import {
  APP_NAME, UNITS, UNIT_LABELS, UNIT_NAMES, OVEN_MODES, OVEN_MODE_LABELS, actionMeta, diffContent, escapeHtml as h, filterRecipes, formatAmount,
  formatQuantity, layoutTable, parseMultiplier, scaleContent, tableHtml, validateDiagram,
} from "./model.mjs";

const main = document.getElementById("main");
const noticeEl = document.getElementById("notice");
const statusBar = document.getElementById("status-bar");
document.title = APP_NAME;
document.getElementById("app-name").textContent = APP_NAME;

const state = {
  info: null,
  recipes: [], problems: [], categories: { version: 0, categories: [] },
  filter: { query: "", categoryIds: [] },
  doc: null, multiplier: 1, selected: null,
  editor: null, drafts: [], sync: null, lastSavedAt: null, syncing: false,
};

// ---- API -------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, body) { super(body.error || `Request failed (${status}).`); this.status = status; this.body = body; }
}

async function api(path, body, { raw, type } = {}) {
  const options = body === undefined ? {} : {
    method: "POST",
    // Binds every write to the cookbook this window loaded; the server refuses it with 409 if another window switched folders since.
    headers: { "Content-Type": raw ? type : "application/json", ...(state.info?.cookbookId ? { "X-Open-Sauce-Cookbook": state.info.cookbookId } : {}) },
    body: raw ? body : JSON.stringify(body),
  };
  const response = await fetch(`api/${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

function notice(message, { kind = "info", actions = [] } = {}) {
  if (!message) { noticeEl.hidden = true; return; }
  noticeEl.hidden = false;
  noticeEl.className = `notice ${kind}`;
  noticeEl.innerHTML = `<span>${h(message)}</span>${actions.map((action, index) => `<button type="button" data-notice="${index}">${h(action.label)}</button>`).join("")}<button type="button" class="ghost" data-notice="close" aria-label="Dismiss">Dismiss</button>`;
  noticeEl.onclick = (event) => {
    const key = event.target.dataset.notice;
    if (key === undefined) return;
    if (key !== "close") actions[Number(key)].run();
    notice(null);
  };
}

function failure(error) {
  if (!(error instanceof ApiError)) { console.error(error); notice("Something went wrong. Nothing was overwritten.", { kind: "error" }); return; }
  notice(error.message, { kind: error.status === 409 ? "warning" : "error" });
}

const categoryName = (id) => state.categories.categories.find((category) => category.id === id)?.name ?? "";
const photoUrl = (id) => `api/photos/${encodeURIComponent(id)}`;
const snapshotOf = (doc, id) => doc.snapshots.find((snapshot) => snapshot.id === id);
const dateLabel = (iso) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { dateStyle: "medium" });
const stars = (rating) => (rating ? `<span class="stars" aria-label="${rating} of 5 stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>` : "");
const today = () => new Date().toLocaleDateString("en-CA");
const clone = (value) => structuredClone(value);
function entryLabel(doc, snapshot) {
  const index = doc.snapshots.indexOf(snapshot) + 1;
  return `#${index} ${snapshot.kind === "attempt" ? `Cooked ${dayLabel(snapshot.attempt.date)}` : snapshot.message}`;
}

// ---- data loading ----------------------------------------------------------

async function loadInfo() {
  state.info = await api("info");
}
async function loadRecipes() {
  const data = await api("recipes");
  state.recipes = data.recipes;
  state.problems = data.problems;
  state.categories = data.categories;
  state.lastSavedAt = data.lastSavedAt ?? state.lastSavedAt;
}
async function loadDoc(id) {
  const { recipe } = await api(`recipes/${encodeURIComponent(id)}`);
  if (state.doc?.id !== recipe.id) { state.multiplier = 1; state.selected = null; }
  state.doc = recipe;
  return recipe;
}
async function loadSync() {
  if (!state.info?.configured) return;
  try { state.sync = await api("sync/status"); } catch { state.sync = null; }
  renderStatus();
}
async function loadDrafts() {
  try { state.drafts = (await api("drafts")).drafts; } catch { state.drafts = []; }
}

function savedLocally(response) {
  state.lastSavedAt = new Date().toISOString();
  if (response?.recipe && state.doc?.id === response.recipe.id) state.doc = response.recipe;
  renderStatus();
  loadSync();
}

// ---- status bar: local save state and sync state are separate --------------

function renderStatus() {
  if (!state.info?.configured) { statusBar.innerHTML = ""; return; }
  const local = state.lastSavedAt ? `Saved locally ${new Date(state.lastSavedAt).toLocaleTimeString("en-GB", { timeStyle: "short" })}` : "All changes are saved locally";
  const sync = state.sync;
  let syncText = "Checking sync...";
  let syncTitle = "";
  if (sync && !sync.available) { syncText = "off"; syncTitle = sync.reason; }
  else if (sync) {
    const parts = [];
    if (sync.pendingChanges) parts.push(`${sync.pendingChanges} file${sync.pendingChanges === 1 ? "" : "s"} not synced`);
    if (sync.ahead) parts.push(`${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} to push`);
    if (!sync.remote) parts.push("no remote");
    syncText = parts.length ? parts.join(", ") : "In sync (as of last sync)";
    if (sync.lastResult) syncTitle = `Last sync: ${sync.lastResult.message} (${dateLabel(sync.lastResult.at)})`;
  }
  statusBar.innerHTML = `
    ${state.info.source === "demo" ? `<span class="pill demo" title="${h(state.info.dataDir)}">Demo cookbook (temporary copy)</span>` : ""}
    <span class="pill" title="${h(state.info.dataDir)}">${h(local)}</span>
    <span class="pill ${sync?.available ? "" : "muted"}" title="${h(syncTitle)}">Sync: ${h(syncText)}</span>
    <button type="button" id="sync-button" ${sync?.available && !state.syncing ? "" : "disabled"} title="${h(sync?.available ? "Commit, fetch, fast-forward and push the cookbook folder" : syncTitle)}">${state.syncing ? "Syncing..." : "Sync"}</button>`;
  statusBar.querySelector("#sync-button").onclick = runSync;
}

async function runSync() {
  state.syncing = true;
  renderStatus();
  try {
    const result = await api("sync", {});
    notice(result.message, { kind: "success" });
    await loadRecipes();
    route();
  } catch (error) { failure(error); }
  finally { state.syncing = false; loadSync(); }
}

// ---- routing ---------------------------------------------------------------

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (!state.info) await loadInfo();
    if (!state.info.configured) return renderSetup();
    // New recipes come only from drafts (Copilot or a local AI assistant). The old blank form route shows the help page.
    if (parts[0] === "add" || parts[0] === "new") { if (!state.categories.version) await loadRecipes(); return renderAddHelp(); }
    if (parts[0] === "draft") return openDraft(parts[1]);
    if (parts[0] === "r" && parts[1]) {
      if (!state.categories.version) await loadRecipes();
      const doc = await loadDoc(parts[1]);
      if (parts[2] === "history") return renderHistory(doc);
      if (parts[2] === "edit") return openEditor({ mode: parts[3] === "attempt" ? "attempt" : "revision", key: parts.slice(1).join("/"), doc, parentId: parts[4] || doc.current });
      return renderRecipe(doc, parts[2] || doc.current);
    }
    await Promise.all([loadRecipes(), loadDrafts()]);
    renderBrowse();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) { notice(error.message, { kind: "error" }); location.hash = "#/"; return; }
    failure(error);
  }
}

// ---- setup -----------------------------------------------------------------

function renderSetup() {
  main.innerHTML = `
    <section class="setup">
      <h1>Set up your cookbook</h1>
      <p>${h(APP_NAME)} keeps every recipe as a readable JSON file in a folder you choose. Nothing is stored inside the app folder, so updates never touch your recipes.</p>
      ${state.info.setupError ? `<p class="error-text" role="alert">${h(state.info.setupError)}</p>` : ""}
      <form id="folder-form" class="card">
        <h2>Use a cookbook folder</h2>
        <p class="muted">Choose an empty folder for a new cookbook or an existing ${h(APP_NAME)} folder. The choice is remembered in ~/.config/open-sauce/config.json. You can also set the OPEN_SAUCE_DATA environment variable.</p>
        <label>Absolute folder path <input name="path" required placeholder="/Users/you/Documents/open-sauce-files" autocomplete="off"></label>
        <button type="submit">Use this folder</button>
      </form>
      <div class="card">
        <h2>Just looking?</h2>
        <p class="muted">Open a temporary copy of the bundled demo cookbook with synthetic example recipes. Changes stay in the temporary copy.</p>
        <button type="button" id="demo-button" class="secondary">Open demo cookbook</button>
      </div>
    </section>`;
  const finish = async (input) => {
    try {
      state.info = { ...(await api("setup", input)) };
      notice(null);
      location.hash = "#/";
      await route();
      loadSync();
    } catch (error) { failure(error); }
  };
  main.querySelector("#folder-form").onsubmit = (event) => { event.preventDefault(); finish({ mode: "folder", path: new FormData(event.target).get("path") }); };
  main.querySelector("#demo-button").onclick = () => finish({ mode: "demo" });
}

// ---- browse ----------------------------------------------------------------

function renderBrowse() {
  const list = filterRecipes(state.recipes, state.filter);
  const categories = state.categories.categories;
  main.innerHTML = `
    ${draftsHtml()}
    <section class="browse-head">
      <div>
        <h1>Recipes</h1>
        <p class="muted">${state.recipes.length} recipe${state.recipes.length === 1 ? "" : "s"} in this cookbook</p>
      </div>
      <a class="button" href="#/add">Add a recipe with AI</a>
    </section>
    ${state.problems.length ? `<div class="diagram-errors" role="alert"><p><strong>Some recipe files could not be read and are not shown:</strong></p><ul>${state.problems.map((problem) => `<li>${h(problem.file)}: ${h(problem.message)}</li>`).join("")}</ul></div>` : ""}
    <section class="filters" aria-label="Filter recipes">
      <label class="search">Search <input type="search" id="search" value="${h(state.filter.query)}" placeholder="Title, ingredient, family member..."></label>
      <div class="chips" role="group" aria-label="Categories">
        ${categories.map((category) => `<button type="button" class="chip" data-category="${h(category.id)}" aria-pressed="${state.filter.categoryIds.includes(category.id)}">${h(category.name)}</button>`).join("")}
      </div>
      <p class="muted small">${state.filter.categoryIds.length > 1 ? "Showing recipes that have all selected categories." : "Select several categories to see recipes that have all of them."}</p>
    </section>
    <section class="cards" aria-label="Recipes">
      ${list.map((recipe) => `
        <a class="recipe-card" href="#/r/${encodeURIComponent(recipe.id)}">
          ${recipe.photo ? `<img src="${photoUrl(recipe.photo)}" alt="" loading="lazy">` : `<div class="placeholder" aria-hidden="true">${h(recipe.title.slice(0, 1))}</div>`}
          <span class="card-title">${h(recipe.title)}</span>
          ${recipe.attribution ? `<span class="muted small">${h(recipe.attribution)}</span>` : ""}
          <span class="tags">${recipe.categoryIds.map((id) => `<span class="tag">${h(categoryName(id))}</span>`).join("")}</span>
        </a>`).join("") || `<p class="muted">No recipes match. ${state.recipes.length ? "Clear the search or deselect a category." : `Give a recipe to your AI assistant and review its draft here. <a href="#/add">How to add a recipe</a>.`}</p>`}
    </section>
    <details class="manage card">
      <summary>Manage categories</summary>
      <p class="muted small">Deleting a category only removes the tag. Recipes are never deleted.</p>
      <ul class="category-list">
        ${categories.map((category) => `
          <li><form data-rename="${h(category.id)}"><label class="visually-hidden" for="cat-${h(category.id)}">Name</label><input id="cat-${h(category.id)}" name="name" value="${h(category.name)}" maxlength="40" required>
          <button type="submit" class="secondary">Rename</button><button type="button" class="danger" data-delete-category="${h(category.id)}">Delete</button></form></li>`).join("")}
      </ul>
      <form id="new-category" class="inline"><label>New category <input name="name" maxlength="40" required></label><button type="submit">Add</button></form>
    </details>`;
  const search = main.querySelector("#search");
  search.oninput = () => {
    state.filter.query = search.value;
    const position = search.selectionStart;
    renderBrowse();
    const again = main.querySelector("#search");
    again.focus();
    again.setSelectionRange(position, position);
  };
  bindDrafts();
  main.querySelectorAll("[data-category]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.category;
      const selected = state.filter.categoryIds;
      state.filter.categoryIds = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
      renderBrowse();
    };
  });
  const mutateCategories = async (path, body) => {
    try {
      const result = await api(path, { expectedVersion: state.categories.version, ...body });
      savedLocally();
      await loadRecipes();
      state.filter.categoryIds = state.filter.categoryIds.filter((id) => state.categories.categories.some((category) => category.id === id));
      renderBrowse();
      main.querySelector("details.manage").open = true;
      return result;
    } catch (error) {
      failure(error);
      if (error.status === 409) { await loadRecipes(); renderBrowse(); }
    }
  };
  main.querySelector("#new-category").onsubmit = (event) => { event.preventDefault(); mutateCategories("categories", { name: new FormData(event.target).get("name") }); };
  main.querySelectorAll("[data-rename]").forEach((form) => {
    form.onsubmit = (event) => { event.preventDefault(); mutateCategories(`categories/${encodeURIComponent(form.dataset.rename)}/rename`, { name: new FormData(form).get("name") }); };
  });
  main.querySelectorAll("[data-delete-category]").forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.deleteCategory;
      if (!confirm(`Delete the category "${categoryName(id)}"? Recipes keep existing; only this tag is removed.`)) return;
      const result = await mutateCategories(`categories/${encodeURIComponent(id)}/delete`, {});
      if (result) notice(`Category deleted. ${result.untagged} recipe${result.untagged === 1 ? "" : "s"} untagged, none deleted.`, { kind: "success" });
    };
  });
}

function draftsHtml() {
  if (!state.drafts.length) return "";
  return `<section class="drafts card" aria-label="Drafts waiting for review">
    <h2>Drafts waiting for review</h2>
    <p class="muted small">Nothing here is saved. Open a draft, check and correct every field, then save it yourself, or dismiss it. Drafts are kept only while the app is running.</p>
    <ul>${state.drafts.map((draft) => `<li>
      <strong>${h(draft.content.title)}</strong> <span class="muted small">${draft.recipeId ? "proposed revision" : "proposed new recipe"} · from ${h(draftSourceLabel(draft))} · ${dateLabel(draft.createdAt)}</span>
      ${draft.message ? `<p class="small">${h(draft.message)}</p>` : ""}
      ${draft.diagramErrors.length ? `<p class="error-text small">${draft.diagramErrors.length} preparation problem${draft.diagramErrors.length === 1 ? "" : "s"} to fix in the editor.</p>` : ""}
      <a class="button secondary" href="#/draft/${h(draft.id)}">Review and save</a>
      <button type="button" class="ghost" data-dismiss-draft="${h(draft.id)}">Dismiss</button>
    </li>`).join("")}</ul>
  </section>`;
}
function draftSourceLabel(draft) {
  const kind = draft.source === "agent" ? "a local AI assistant" : "Copilot";
  return draft.submittedBy ? `${draft.submittedBy} (${kind})` : kind;
}

function renderAddHelp() {
  const agent = state.info.agent ?? {};
  main.innerHTML = `
    <nav class="crumbs"><a href="#/">Recipes</a></nav>
    <section class="add-help" id="add-help">
      <h1>Add a recipe</h1>
      <p>Recipes are entered by an AI assistant, not typed into a blank form. Give the assistant the recipe (pasted text, a photo of a card, a description) and it places a draft in the review area. You then see every field, ingredient amount and preparation step, correct anything and press Save. Nothing is written to your cookbook folder before you press Save; photos you add while reviewing stay in this app's memory until then.</p>
      <div class="card">
        <h2>With GitHub Copilot</h2>
        <p>Open the ${h(APP_NAME)} canvas in a Copilot session and say for example: "Add this recipe to my cookbook" followed by the recipe. Copilot uses the <code>submit_draft</code> action.</p>
      </div>
      <div class="card">
        <h2>With another AI assistant on this computer</h2>
        <p>Any assistant that can run local tools (for example a coding agent that can read files and call <code>curl</code>) can submit drafts while ${h(APP_NAME)} is running.</p>
        ${agent.running ? `<p>This window is ${h(APP_NAME)} instance <code id="agent-instance">${h(agent.instanceId)}</code> (${agent.surface === "canvas" ? "Copilot canvas" : "standalone app"}), using the cookbook folder <code class="path">${h(state.info.dataDir ?? "not set up yet")}</code>.</p>
        <p>Drafts appear here only if the assistant uses this instance's own endpoint file, which holds its address and a private access token and is readable only by your user account:</p>
        <p><code class="path" id="agent-file">${h(agent.file)}</code></p>
        <p>Tell the assistant to read exactly that file, fetch <code>GET schema</code> for the draft format and send the recipe with <code>POST drafts</code>, adding the header <code>X-Open-Sauce-Instance: ${h(agent.instanceId)}</code> so a draft can never land in another window. The README has a ready-to-use instruction.</p>
        ${agent.others?.length ? `<div class="other-instances" id="other-instances"><p><strong>Other ${h(APP_NAME)} instances are running.</strong> Each has its own file and token; a draft sent with one of these files appears only in that instance:</p>
          <ul>${agent.others.map((other) => `<li><code>${h(other.instanceId)}</code> (${other.surface === "canvas" ? "Copilot canvas" : "standalone app"}), cookbook <code class="path">${h(other.cookbook ?? "not set up yet")}</code><br><code class="path">${h(other.file)}</code></li>`).join("")}</ul></div>` : ""}`
        : `<p class="error-text">${h(agent.error || "The local agent interface is switched off (OPEN_SAUCE_AGENT=off).")}</p>`}
        <p class="muted small">Never paste the token into a chat, an issue or a website. It only works on this computer and changes every time ${h(APP_NAME)} starts. Endpoint files are removed when an instance stops normally; after a crash the next start removes them. Hosted chatbots in a browser tab cannot reach this interface; the assistant needs local tool access.</p>
      </div>
    </section>`;
}

function bindDrafts() {
  main.querySelectorAll("[data-dismiss-draft]").forEach((button) => {
    button.onclick = async () => {
      try { state.drafts = (await api(`drafts/${encodeURIComponent(button.dataset.dismissDraft)}/dismiss`, {})).drafts; renderBrowse(); }
      catch (error) { failure(error); }
    };
  });
}

// ---- recipe view -----------------------------------------------------------

function scaleControls() {
  const presets = [0.5, 1, 2, 3];
  return `<div class="scale" role="group" aria-label="Scale amounts">
    <span class="label">Scale</span>
    ${presets.map((value) => `<button type="button" class="chip" data-scale="${value}" aria-pressed="${state.multiplier === value}">${value}x</button>`).join("")}
    <form id="custom-scale" class="inline"><label class="visually-hidden" for="custom-multiplier">Custom multiplier</label>
      <input id="custom-multiplier" name="m" inputmode="decimal" size="4" placeholder="1.25" value="${presets.includes(state.multiplier) ? "" : h(state.multiplier)}"><button type="submit" class="secondary">Apply</button></form>
    ${state.multiplier !== 1 ? `<span class="muted small">Amounts x${h(formatQuantity(state.multiplier))}. Times and temperatures are unchanged.</span>` : ""}
  </div>`;
}

function ingredientListHtml(content, multiplier) {
  return `<ul class="ingredients">${content.ingredients.map((item) => `<li><span class="amount">${h(formatAmount(item.quantity === null ? null : item.quantity * multiplier, item.unit))}</span> <span>${h(item.name)}</span>${item.note ? ` <span class="muted small">(${h(item.note)})</span>` : ""}</li>`).join("")}</ul>`;
}

function attemptHtml(snapshot) {
  const a = snapshot.attempt;
  if (!a) return "";
  return `<div class="attempt-box">
    <p><strong>Cooked ${h(dayLabel(a.date))}</strong> ${stars(a.rating)} ${a.multiplier !== 1 ? `<span class="pill">cooked at ${h(formatQuantity(a.multiplier))}x; amounts below are what was actually used</span>` : ""}</p>
    ${a.outcome ? `<p>${h(a.outcome)}</p>` : ""}
    ${a.photos.length ? `<div class="photos">${a.photos.map((id) => `<img src="${photoUrl(id)}" alt="Photo of this attempt">`).join("")}</div>` : ""}
  </div>`;
}

function renderRecipe(doc, snapshotId) {
  const snapshot = snapshotOf(doc, snapshotId);
  if (!snapshot) { notice("That history entry does not exist.", { kind: "error" }); location.hash = `#/r/${doc.id}`; return; }
  const content = snapshot.content;
  const isCurrent = snapshot.id === doc.current;
  // An attempt already stores the actual amounts; the view never re-applies its multiplier.
  const layout = layoutTable(content, state.multiplier);
  main.innerHTML = `
    <nav class="crumbs"><a href="#/">Recipes</a></nav>
    <article class="recipe">
      <header class="recipe-head">
        <h1>${h(content.title)}</h1>
        ${content.attribution ? `<p class="attribution">${h(content.attribution)}</p>` : ""}
        <p class="muted small">${[content.yield && `Makes ${h(content.yield)}`, content.sourceUrl && `<a href="${h(content.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a>`].filter(Boolean).join(" · ")}</p>
        <div class="tags">${doc.categoryIds.map((id) => `<span class="tag">${h(categoryName(id))}</span>`).join("")}
          <details class="inline-edit"><summary>Edit categories</summary>
            <form id="recipe-categories">${state.categories.categories.map((category) => `<label class="check"><input type="checkbox" name="c" value="${h(category.id)}" ${doc.categoryIds.includes(category.id) ? "checked" : ""}> ${h(category.name)}</label>`).join("")}
            <button type="submit" class="secondary">Save categories</button></form>
          </details>
        </div>
        <div class="tabs"><a href="#/r/${h(doc.id)}" aria-current="page">Recipe</a><a href="#/r/${h(doc.id)}/history">History (${doc.snapshots.length})</a></div>
      </header>
      ${isCurrent ? "" : `<div class="banner">You are viewing ${h(entryLabel(doc, snapshot))}, not the current recipe.
        <a href="#/r/${h(doc.id)}">Go to current</a> <button type="button" id="make-current" class="secondary">Set as current</button></div>`}
      ${attemptHtml(snapshot)}
      ${content.photos.length ? `<div class="photos">${content.photos.map((id) => `<img src="${photoUrl(id)}" alt="Photo of ${h(content.title)}">`).join("")}</div>` : ""}
      ${content.description ? `<p class="description">${h(content.description)}</p>` : ""}
      <div class="actions-row">
        <a class="button" href="#/r/${h(doc.id)}/edit/revision/${h(snapshot.id)}">Edit (new revision)</a>
        <a class="button secondary" href="#/r/${h(doc.id)}/edit/attempt/${h(snapshot.id)}" id="log-attempt">Log a cooking attempt</a>
      </div>
      ${scaleControls()}
      <section><h2>Ingredients</h2>${ingredientListHtml(content, state.multiplier)}</section>
      <section><h2>Preparation</h2>${tableHtml(layout)}</section>
      ${content.notes ? `<section><h2>Notes</h2><p class="notes">${h(content.notes)}</p></section>` : ""}
    </article>`;
  bindScale(() => renderRecipe(state.doc, snapshotId));
  main.querySelector("#log-attempt").onclick = () => { state.pendingAttemptMultiplier = state.multiplier; };
  main.querySelector("#make-current")?.addEventListener("click", () => setCurrent(doc, snapshot.id));
  main.querySelector("#recipe-categories").onsubmit = async (event) => {
    event.preventDefault();
    const categoryIds = new FormData(event.target).getAll("c");
    try {
      savedLocally(await api(`recipes/${encodeURIComponent(doc.id)}/categories`, { expectedVersion: doc.version, categoryIds }));
      renderRecipe(state.doc, snapshotId);
    } catch (error) { conflictAware(error, doc.id); }
  };
}

function bindScale(rerender) {
  main.querySelectorAll("[data-scale]").forEach((button) => { button.onclick = () => { state.multiplier = Number(button.dataset.scale); rerender(); }; });
  const form = main.querySelector("#custom-scale");
  form.onsubmit = (event) => {
    event.preventDefault();
    try { state.multiplier = parseMultiplier(form.m.value); rerender(); }
    catch (error) { notice(error.message, { kind: "error" }); }
  };
}

function conflictAware(error, recipeId) {
  if (error.status === 409) {
    notice(error.message, { kind: "warning", actions: [{ label: "Reload recipe", run: async () => { await loadDoc(recipeId); route(); } }] });
  } else failure(error);
}

async function setCurrent(doc, snapshotId) {
  try {
    savedLocally(await api(`recipes/${encodeURIComponent(doc.id)}/current`, { expectedVersion: doc.version, snapshotId }));
    notice("Current recipe updated. All history entries are kept.", { kind: "success" });
    route();
  } catch (error) { conflictAware(error, doc.id); }
}

// ---- history ---------------------------------------------------------------

/** Deterministic lanes: a snapshot continues its parent's lane if it is the parent's first child, otherwise opens a new lane. */
function historyLayout(doc) {
  const chronological = [...doc.snapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const lane = new Map();
  const continued = new Set();
  let lanes = 0;
  for (const snapshot of chronological) {
    if (snapshot.parent && !continued.has(snapshot.parent) && lane.has(snapshot.parent)) {
      lane.set(snapshot.id, lane.get(snapshot.parent));
      continued.add(snapshot.parent);
    } else lane.set(snapshot.id, lanes++);
    if (!lanes) lanes = 1;
  }
  const rows = chronological.reverse();
  const rowOf = new Map(rows.map((snapshot, index) => [snapshot.id, index]));
  return { rows, lane, rowOf, lanes };
}

function graphSvg(layout, snapshot, current) {
  const width = 14 + layout.lanes * 18;
  const H = 72;
  const mid = 30;
  const x = (laneIndex) => 12 + laneIndex * 18;
  const r = layout.rowOf.get(snapshot.id);
  const lines = [];
  for (const child of layout.rows) {
    if (!child.parent || !layout.rowOf.has(child.parent)) continue;
    const rc = layout.rowOf.get(child.id);
    const rp = layout.rowOf.get(child.parent);
    const lc = layout.lane.get(child.id);
    const lp = layout.lane.get(child.parent);
    if (r === rc) lines.push(`<line x1="${x(lc)}" y1="${mid}" x2="${x(lc)}" y2="${H}"/>`);
    else if (r > rc && r < rp) lines.push(`<line x1="${x(lc)}" y1="0" x2="${x(lc)}" y2="${H}"/>`);
    else if (r === rp) lines.push(`<line x1="${x(lc)}" y1="0" x2="${x(lp)}" y2="${mid}"/>`);
  }
  const dot = x(layout.lane.get(snapshot.id));
  return `<svg class="graph" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" aria-hidden="true">${lines.join("")}
    <circle cx="${dot}" cy="${mid}" r="${current ? 7 : 5}" class="${snapshot.kind}${current ? " current" : ""}"/></svg>`;
}

function diffHtml(doc, snapshot) {
  const parent = snapshot.parent && snapshotOf(doc, snapshot.parent);
  if (!parent) return `<p class="muted">First entry of this recipe.</p>`;
  const multiplier = snapshot.attempt?.multiplier ?? 1;
  const diff = diffContent(parent.content, snapshot.content, multiplier);
  const amount = (item) => formatAmount(item.quantity, item.unit) || "no amount";
  const items = [];
  for (const item of diff.ingredients.added) items.push(`<li class="added">Added ${h(item.name)} (${h(amount(item))})</li>`);
  for (const item of diff.ingredients.removed) items.push(`<li class="removed">Removed ${h(item.name)} (${h(amount(item))})</li>`);
  for (const change of diff.ingredients.changed) {
    items.push(`<li class="changed">${h(change.to.name)}: ${h(amount(change.from))} → ${h(amount(change.to))}${change.from.name !== change.to.name ? ` (was "${h(change.from.name)}")` : ""}${change.from.note !== change.to.note ? ` · note "${h(change.to.note)}"` : ""}</li>`);
  }
  const fieldLabel = { temperatureC: "temperature", durationMinutes: "time", ovenMode: "oven mode" };
  const show = (field, value) => (value === null || value === "" ? "none" : field === "temperatureC" ? `${formatQuantity(value)} °C` : field === "durationMinutes" ? `${formatQuantity(value)} min` : field === "ovenMode" ? OVEN_MODE_LABELS[value] : value);
  const oven = diff.oven.map((change) => `<li class="changed">Oven, "${h(change.text)}": ${fieldLabel[change.field]} ${h(show(change.field, change.from))} → ${h(show(change.field, change.to))}</li>`);
  const steps = [
    ...diff.steps.added.map((step) => `<li class="added">New step "${h(step.text)}"${actionMeta(step) ? ` (${h(actionMeta(step))})` : ""}</li>`),
    ...diff.steps.removed.map((step) => `<li class="removed">Removed step "${h(step.text)}"</li>`),
    ...diff.steps.textChanged.map((step) => `<li class="changed">Step text: "${h(step.from)}" → "${h(step.to)}"</li>`),
    ...diff.steps.inputsChanged.map((step) => `<li class="changed">Inputs changed in "${h(step.text)}"</li>`),
  ];
  return `
    <p class="muted small">Compared with ${h(entryLabel(doc, parent))}${multiplier !== 1 ? ` scaled to ${h(formatQuantity(multiplier))}x` : ""}.</p>
    ${diff.empty ? `<p>No changes: cooked exactly as written.</p>` : ""}
    ${items.length ? `<h4>Ingredients</h4><ul class="diff">${items.join("")}</ul>` : ""}
    ${oven.length ? `<h4>Oven and timing</h4><ul class="diff">${oven.join("")}</ul>` : ""}
    ${steps.length ? `<h4>Steps</h4><ul class="diff">${steps.join("")}</ul>` : ""}
    ${diff.fields.length ? `<p class="small">Also changed: ${h(diff.fields.join(", "))}</p>` : ""}`;
}

function renderHistory(doc) {
  const layout = historyLayout(doc);
  const current = snapshotOf(doc, doc.current);
  const selected = snapshotOf(doc, state.selected) ?? current;
  main.innerHTML = `
    <nav class="crumbs"><a href="#/">Recipes</a></nav>
    <header class="recipe-head">
      <h1>${h(current.content.title)}</h1>
      <div class="tabs"><a href="#/r/${h(doc.id)}">Recipe</a><a href="#/r/${h(doc.id)}/history" aria-current="page">History (${doc.snapshots.length})</a></div>
    </header>
    <p class="muted small">Every saved entry is kept. Revisions are untested changes; cooking attempts record what you actually did. Saving never changes the current recipe unless you choose to.</p>
    <div class="history">
      <ol class="history-list" aria-label="History entries, newest first">
        ${layout.rows.map((snapshot) => {
          const isCurrent = snapshot.id === doc.current;
          return `<li><button type="button" class="history-row${snapshot.id === selected.id ? " selected" : ""}" data-select="${h(snapshot.id)}" aria-pressed="${snapshot.id === selected.id}">
            ${graphSvg(layout, snapshot, isCurrent)}
            <span class="history-text">
              <span class="history-title">#${doc.snapshots.indexOf(snapshot) + 1} <span class="kind ${snapshot.kind}">${snapshot.kind === "attempt" ? "Cooking attempt" : "Revision"}</span>${isCurrent ? ` <span class="kind current">Current</span>` : ""}</span>
              <span class="small">${h(snapshot.kind === "attempt" ? `${dayLabel(snapshot.attempt.date)}: ${snapshot.message}` : snapshot.message)} ${snapshot.attempt ? stars(snapshot.attempt.rating) : ""}</span>
              <span class="muted small">${snapshot.parent ? `based on #${doc.snapshots.findIndex((item) => item.id === snapshot.parent) + 1} · ` : ""}saved ${h(dateLabel(snapshot.createdAt))}</span>
            </span></button></li>`;
        }).join("")}
      </ol>
      <section class="history-detail card" aria-live="polite">
        <h2>${h(entryLabel(doc, selected))}</h2>
        ${attemptHtml(selected)}
        ${diffHtml(doc, selected)}
        <div class="actions-row">
          <a class="button secondary" href="#/r/${h(doc.id)}/${h(selected.id)}">View</a>
          ${selected.id === doc.current ? `<span class="pill">This is the current recipe</span>` : `<button type="button" id="set-current">Set as current</button>`}
        </div>
        <p class="small">Start a new entry from here:</p>
        <div class="actions-row">
          <a class="button secondary" href="#/r/${h(doc.id)}/edit/revision/${h(selected.id)}">New revision</a>
          <a class="button secondary" href="#/r/${h(doc.id)}/edit/attempt/${h(selected.id)}">New cooking attempt</a>
        </div>
      </section>
    </div>`;
  main.querySelectorAll("[data-select]").forEach((button) => { button.onclick = () => { state.selected = button.dataset.select; renderHistory(doc); }; });
  main.querySelector("#set-current")?.addEventListener("click", () => setCurrent(doc, selected.id));
}

// ---- editor ----------------------------------------------------------------

const blankContent = () => ({ title: "", description: "", attribution: "", sourceUrl: "", yield: "", ingredients: [], actions: [], notes: "", photos: [] });
const nextId = (prefix, items) => {
  let n = items.length + 1;
  while (items.some((item) => item.id === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
};

async function openDraft(draftId) {
  await loadDrafts();
  const draft = state.drafts.find((item) => item.id === draftId);
  if (!draft) { notice("That draft is no longer in the review area.", { kind: "error" }); location.hash = "#/"; return; }
  if (draft.recipeId) {
    const doc = await loadDoc(draft.recipeId);
    return openEditor({ mode: "revision", key: `draft/${draft.id}`, doc, parentId: draft.baseSnapshotId, content: draft.content, message: draft.message, draft });
  }
  return openEditor({ mode: "new", key: `draft/${draft.id}`, content: draft.content, message: draft.message, draft });
}

async function openEditor({ mode, key, doc, parentId, content, message = "", draft = null }) {
  if (state.editor?.key !== key) {
    if (!state.recipes.length || !state.categories.version) await loadRecipes();
    const parent = doc ? snapshotOf(doc, parentId) : null;
    if (doc && !parent) { notice("That history entry does not exist.", { kind: "error" }); location.hash = `#/r/${doc.id}`; return; }
    const base = clone(content ?? parent?.content ?? blankContent());
    if (mode === "attempt") base.photos = [...(parent?.content.photos ?? [])];
    discardStaged(state.editor);
    state.editor = {
      key, mode, draftId: draft?.id ?? null,
      // Photos added in this editor that exist only in the app's memory until Save.
      staged: new Set(),
      draftInfo: draft ? { source: draftSourceLabel(draft), message: draft.message, unmatchedCategories: draft.unmatchedCategories ?? [], cookbook: draft.cookbook ?? state.info.dataDir } : null,
      // Photos already saved in the entry this one is based on (kept unless the user removes them).
      parentPhotos: new Set(parent?.content.photos ?? []),
      recipeId: doc?.id ?? null, parentId: parent?.id ?? null, expectedVersion: doc?.version ?? null,
      // The Current the user saw. Promotion is only sent with this value, so the server refuses to move a Current someone else changed.
      seenCurrent: doc?.current ?? null, seenCurrentLabel: doc ? entryLabel(doc, snapshotOf(doc, doc.current)) : null,
      parentLabel: parent ? entryLabel(doc, parent) : null,
      base: clone(base), content: base, message, makeCurrent: false,
      categoryIds: (draft?.suggestedCategoryIds ?? []).filter((id) => state.categories.categories.some((category) => category.id === id)),
      attempt: { date: today(), multiplier: 1, outcome: "", rating: null, photos: [] },
      errors: [],
    };
    if (mode === "attempt" && state.pendingAttemptMultiplier && state.pendingAttemptMultiplier !== 1) applyAttemptMultiplier(state.pendingAttemptMultiplier);
    state.pendingAttemptMultiplier = null;
  }
  renderEditor();
}

/** Recomputes amounts from the starting entry, so applying a multiplier twice never multiplies twice. */
function applyAttemptMultiplier(multiplier) {
  const editor = state.editor;
  const scaled = scaleContent(editor.base, multiplier);
  const byId = new Map(scaled.ingredients.map((item) => [item.id, item]));
  for (const item of editor.content.ingredients) if (byId.has(item.id)) item.quantity = byId.get(item.id).quantity;
  const steps = new Map(scaled.actions.map((action) => [action.id, action]));
  for (const action of editor.content.actions) {
    const source = steps.get(action.id);
    if (!source) continue;
    for (const ref of action.inputs) {
      const match = source.inputs.find((item) => item.ingredient === ref.ingredient && item.ingredient !== undefined);
      if (ref.quantity !== undefined && match?.quantity !== undefined) ref.quantity = match.quantity;
    }
  }
  editor.attempt.multiplier = multiplier;
}

function allocation(content) {
  const used = new Map(content.ingredients.map((item) => [item.id, { whole: false, portions: 0 }]));
  const consumed = new Set();
  for (const action of content.actions) for (const ref of action.inputs) {
    if (ref.ingredient !== undefined && used.has(ref.ingredient)) {
      if (ref.quantity === undefined) used.get(ref.ingredient).whole = true; else used.get(ref.ingredient).portions += ref.quantity;
    }
    if (ref.action !== undefined) consumed.add(ref.action);
  }
  return { used, consumed };
}

function remaining(item, used) {
  const slot = used.get(item.id);
  if (slot.whole) return 0;
  if (item.quantity === null) return slot.portions ? 0 : null;
  return Math.max(0, item.quantity - slot.portions);
}

function inputLabel(content, ref) {
  if (ref.ingredient !== undefined) {
    const item = content.ingredients.find((ingredient) => ingredient.id === ref.ingredient);
    if (!item) return "Missing ingredient";
    const amount = formatAmount(ref.quantity ?? item.quantity, item.unit);
    return `${amount ? `${amount} ` : ""}${item.name}${ref.quantity !== undefined ? " (portion)" : ""}`;
  }
  const index = content.actions.findIndex((action) => action.id === ref.action);
  return index < 0 ? "Missing step" : `Result of step ${index + 1}: ${content.actions[index].text || "(no text yet)"}`;
}

/** A split portion stays editable in place: the amount is an input, the rest of the label is text. */
function portionChip(content, ref, index, refIndex) {
  const item = content.ingredients.find((ingredient) => ingredient.id === ref.ingredient);
  if (!item) return h(inputLabel(content, ref));
  const unit = item.unit ? ` ${h(UNIT_LABELS[item.unit] ?? item.unit)}` : "";
  return `<input name="p.${index}.${refIndex}" class="portion-amount" value="${Number.isFinite(ref.quantity) ? h(formatQuantity(ref.quantity)) : ""}" inputmode="decimal" size="4" aria-label="Portion of ${h(item.name)} in step ${index + 1}">${unit} ${h(item.name)} (portion)`;
}

function stepInputsHtml(content, action, index, alloc) {
  const options = [];
  for (const item of content.ingredients) {
    const left = remaining(item, alloc.used);
    if (left === 0) continue;
    const leftText = left === null ? "" : ` (${formatAmount(left, item.unit)} ${left < item.quantity ? "left" : ""})`.replace(" )", ")");
    options.push(`<option value="i:${h(item.id)}">${h(item.name || "(unnamed)")}${h(leftText)}</option>`);
  }
  const steps = content.actions.slice(0, index).map((step, stepIndex) => ({ step, stepIndex })).filter(({ step }) => !alloc.consumed.has(step.id));
  return `
    <ul class="input-chips" aria-label="Inputs of step ${index + 1}">
      ${action.inputs.map((ref, refIndex) => `<li class="chip static">${ref.quantity !== undefined ? portionChip(content, ref, index, refIndex) : h(inputLabel(content, ref))}<button type="button" class="ghost" data-remove-input="${index}:${refIndex}" aria-label="Remove input">×</button></li>`).join("") || `<li class="muted small">No inputs yet.</li>`}
    </ul>
    ${options.length || steps.length ? `<div class="add-input">
      <label>Add input <select data-input-select="${index}">
        <option value="">Choose...</option>
        ${options.length ? `<optgroup label="Unused ingredients">${options.join("")}</optgroup>` : ""}
        ${steps.length ? `<optgroup label="Earlier steps">${steps.map(({ step, stepIndex }) => `<option value="a:${h(step.id)}">Step ${stepIndex + 1}: ${h(step.text || "(no text yet)")}</option>`).join("")}</optgroup>` : ""}
      </select></label>
      <label class="portion" hidden>Amount <input data-portion="${index}" inputmode="decimal" size="6"></label>
      <button type="button" class="secondary" data-add-input="${index}">Add</button>
    </div>` : `<p class="muted small">All ingredients and earlier steps are already used.</p>`}`;
}

function photoStrip(ids, target) {
  const staged = state.editor?.staged ?? new Set();
  const kept = state.editor?.draftId && state.editor.mode === "revision" ? state.editor.parentPhotos : new Set();
  const caption = (id) => staged.has(id) ? `<figcaption class="small">Not saved yet</figcaption>` : kept.has(id) ? `<figcaption class="small kept">Kept from the base entry</figcaption>` : "";
  return `<div class="photos editable">${ids.map((id) => `<figure${staged.has(id) ? ' class="staged"' : ""}><img src="${photoUrl(id)}" alt="">${caption(id)}<button type="button" class="ghost" data-remove-photo="${target}:${h(id)}">Remove</button></figure>`).join("")}
    <label class="file-button">Add photo<input type="file" accept="image/png,image/jpeg,image/webp" data-upload="${target}" class="visually-hidden"></label></div>
    <p class="muted small photo-note">New photos are kept only in this app's memory until you press Save. They are not in the cookbook folder and cannot be synced before that; Cancel discards them${state.editor?.draftId ? " (the draft itself stays in the review area)" : ""}.${kept.size ? " Photos of the entry this revision is based on are kept; press Remove to leave one out." : ""}</p>`;
}

/** Drops photos an editor uploaded but never saved. Best effort: the server also expires them after a day and forgets them on restart. */
function discardStaged(editor) {
  if (!editor?.staged?.size) return;
  for (const id of editor.staged) api(`photos/${encodeURIComponent(id)}/discard`, {}).catch(() => {});
  editor.staged.clear();
}

function renderEditor() {
  const editor = state.editor;
  const { content } = editor;
  const alloc = allocation(content);
  const heading = editor.draftId ? (editor.mode === "new" ? "Review new recipe" : "Review proposed revision") : editor.mode === "new" ? "New recipe" : editor.mode === "attempt" ? "Log a cooking attempt" : "New revision";
  main.innerHTML = `
    <nav class="crumbs"><a href="#/">Recipes</a>${editor.recipeId ? ` / <a href="#/r/${h(editor.recipeId)}">${h(editor.base.title)}</a>` : ""}</nav>
    <form id="editor" class="editor" novalidate>
      <div class="editor-main">
        <h1>${heading}</h1>
        ${editor.parentLabel ? `<p class="muted">Based on ${h(editor.parentLabel)}.</p>` : ""}
        ${editor.draftInfo ? `<div class="banner" id="draft-banner"><p>Draft from ${h(editor.draftInfo.source)}. Nothing has been saved yet. Check and correct every field below, then press Save at the end. Cancel keeps the draft in the review area but discards photos you added here.</p>
          <p class="small" id="draft-cookbook">Saving adds it to the cookbook in <code>${h(editor.draftInfo.cookbook)}</code>.</p>
          ${editor.draftInfo.message ? `<p class="small">Message: ${h(editor.draftInfo.message)}</p>` : ""}</div>` : ""}
        ${editor.mode === "attempt" ? `
        <fieldset class="card">
          <legend>The cooking attempt</legend>
          <div class="grid2">
            <label>Date cooked <input type="date" name="a.date" value="${h(editor.attempt.date)}" required></label>
            <div><span class="label">Rating (optional)</span><div class="rating" role="radiogroup" aria-label="Rating">
              ${[0, 1, 2, 3, 4, 5].map((n) => `<label class="check"><input type="radio" name="a.rating" value="${n}" ${(editor.attempt.rating ?? 0) === n ? "checked" : ""}> ${n ? "★".repeat(n) : "none"}</label>`).join("")}
            </div></div>
          </div>
          <div class="inline">
            <label>Multiplier <input name="a.multiplier" inputmode="decimal" size="5" value="${h(editor.attempt.multiplier)}"></label>
            <button type="button" class="secondary" id="apply-multiplier">Scale amounts below</button>
            <span class="muted small">Recorded with the attempt. Then adjust the amounts below to what you actually used.</span>
          </div>
          <label>How did it turn out? (optional)<textarea name="a.outcome" rows="3">${h(editor.attempt.outcome)}</textarea></label>
          <span class="label">Photo of the result (optional)</span>
          ${photoStrip(editor.attempt.photos, "attempt")}
        </fieldset>` : ""}
        <fieldset class="card">
          <legend>About the recipe</legend>
          <label>Title <input name="title" value="${h(content.title)}" required maxlength="200"></label>
          <label>Description (optional)<textarea name="description" rows="2">${h(content.description)}</textarea></label>
          <div class="grid2">
            <label>From (family member or source) <input name="attribution" value="${h(content.attribution)}" maxlength="200"></label>
            <label>Yield <input name="yield" value="${h(content.yield)}" maxlength="100" placeholder="1 cake (26 cm)"></label>
          </div>
          <label>Source URL (optional) <input name="sourceUrl" type="url" value="${h(content.sourceUrl)}" placeholder="https://"></label>
          ${editor.mode === "new" ? `<div id="category-picker"><span class="label">Categories</span>${editor.draftInfo?.unmatchedCategories.length ? `<p class="muted small" id="unmatched-categories">Suggested but not in your cookbook (not created): ${editor.draftInfo.unmatchedCategories.map(h).join(", ")}. Add them under Manage categories first if you want them.</p>` : ""}<div class="chips">${state.categories.categories.map((category) => `<label class="check"><input type="checkbox" name="categories" value="${h(category.id)}" ${editor.categoryIds.includes(category.id) ? "checked" : ""}> ${h(category.name)}</label>`).join("")}</div></div>` : ""}
        </fieldset>
        <fieldset class="card">
          <legend>Ingredients</legend>
          <table class="ingredient-editor">
            <thead><tr><th scope="col">Ingredient</th><th scope="col">Amount</th><th scope="col">Unit</th><th scope="col">Note</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
            <tbody>${content.ingredients.map((item, index) => `<tr>
              <td><input name="i.${index}.name" value="${h(item.name)}" aria-label="Ingredient ${index + 1} name" required></td>
              <td><input name="i.${index}.quantity" value="${item.quantity === null ? "" : h(formatQuantity(item.quantity))}" inputmode="decimal" size="6" aria-label="Amount of ingredient ${index + 1}"></td>
              <td><select name="i.${index}.unit" aria-label="Unit of ingredient ${index + 1}">${UNITS.map((unit) => `<option value="${unit}" ${item.unit === unit ? "selected" : ""}>${h(UNIT_NAMES[unit])}</option>`).join("")}</select></td>
              <td><input name="i.${index}.note" value="${h(item.note)}" aria-label="Note for ingredient ${index + 1}" placeholder="optional"></td>
              <td><button type="button" class="ghost" data-remove-ingredient="${index}" aria-label="Remove ingredient ${index + 1}">Remove</button></td>
            </tr>`).join("")}</tbody>
          </table>
          <button type="button" class="secondary" id="add-ingredient">Add ingredient</button>
        </fieldset>
        <fieldset class="card">
          <legend>Preparation steps</legend>
          <p class="muted small">Each step combines unused ingredients (or portions of them) and results of earlier steps. The last step produces the dish.</p>
          <ol class="step-editor">${content.actions.map((action, index) => `<li class="step">
            <div class="step-head"><strong>Step ${index + 1}</strong><button type="button" class="ghost" data-remove-step="${index}">Remove step</button></div>
            <label>What to do <input name="s.${index}.text" value="${h(action.text)}" required placeholder="Knead into a smooth dough"></label>
            <div class="grid3">
              <label>Time (min) <input name="s.${index}.durationMinutes" inputmode="decimal" value="${action.durationMinutes ?? ""}"></label>
              <label>Temperature (°C) <input name="s.${index}.temperatureC" inputmode="decimal" value="${action.temperatureC ?? ""}"></label>
              <label>Oven mode <select name="s.${index}.ovenMode">${OVEN_MODES.map((mode) => `<option value="${mode}" ${action.ovenMode === mode ? "selected" : ""}>${mode ? h(OVEN_MODE_LABELS[mode]) : "none"}</option>`).join("")}</select></label>
            </div>
            ${stepInputsHtml(content, action, index, alloc)}
          </li>`).join("")}</ol>
          <button type="button" class="secondary" id="add-step">Add step</button>
        </fieldset>
        <fieldset class="card">
          <legend>Notes and photos</legend>
          <label>Notes (optional)<textarea name="notes" rows="3">${h(content.notes)}</textarea></label>
          ${editor.mode === "attempt" ? "" : photoStrip(content.photos, "recipe")}
        </fieldset>
        <fieldset class="card save-box">
          <legend>Save</legend>
          ${editor.draftId ? `<div id="review-summary" aria-live="polite"></div>` : ""}
          ${editor.mode === "new" ? "" : `<label>${editor.mode === "attempt" ? "Short summary" : "What changed?"} <input name="message" value="${h(editor.message)}" maxlength="300" placeholder="${editor.mode === "attempt" ? "Sunday lunch" : "Less sugar in the filling"}"></label>
          <label class="check"><input type="checkbox" name="makeCurrent" ${editor.makeCurrent ? "checked" : ""}> Make this the current recipe</label>
          <p class="muted small">If unticked, the entry is added to the history and the current recipe stays as it is.</p>
          ${editor.parentId !== editor.seenCurrent ? `<p class="muted small" id="branch-note">This entry starts from ${h(editor.parentLabel)}, not from the current recipe (${h(editor.seenCurrentLabel)}). Ticking the box makes this branch the current recipe; ${h(editor.seenCurrentLabel)} stays in the history.</p>` : ""}`}
          <div id="save-errors">${editor.errors.length ? `<ul class="error-text">${editor.errors.map((message) => `<li>${h(message)}</li>`).join("")}</ul>` : ""}</div>
          <div class="actions-row"><button type="submit">${editor.draftId ? "Save reviewed recipe" : "Save"}</button><a class="button ghost" href="${editor.recipeId ? `#/r/${h(editor.recipeId)}` : "#/"}" id="cancel-edit">Cancel</a></div>
        </fieldset>
      </div>
      <aside class="editor-preview" aria-label="Live preview">
        <h2>Live preview</h2>
        <div id="preview"></div>
      </aside>
    </form>`;
  renderPreview();
  bindEditor();
}

function renderPreview() {
  const { content } = state.editor;
  const preview = main.querySelector("#preview");
  if (!preview) return;
  const { errors } = validateDiagram(content);
  const badNumbers = invalidNumbers(content);
  preview.innerHTML = badNumbers ? `${ingredientListHtml(content, 1)}<p class="error-text">${h(badNumbers)}</p>` : `${ingredientListHtml(content, 1)}${tableHtml(errors.length ? { ok: false, errors } : layoutTable(content, 1))}`;
  const summary = main.querySelector("#review-summary");
  if (summary) {
    const editor = state.editor;
    const names = editor.mode === "new" ? editor.categoryIds.map(categoryName).join(", ") || "none" : "unchanged (edit them on the recipe page)";
    const problems = errors.length + (badNumbers ? 1 : 0);
    summary.innerHTML = `<p class="small"><strong>Before you save:</strong> "${h(content.title || "(no title)")}", ${content.ingredients.length} ingredient${content.ingredients.length === 1 ? "" : "s"}, ${content.actions.length} step${content.actions.length === 1 ? "" : "s"}, categories: ${h(names)}. ${problems ? `<span class="error-text">${problems} problem${problems === 1 ? "" : "s"} to fix.</span>` : "Preparation table is complete."} Nothing is stored until you press Save.</p>`;
  }
}

function invalidNumbers(content) {
  const bad = (value) => Number.isNaN(value);
  if (content.ingredients.some((item) => bad(item.quantity)) || content.actions.some((action) => bad(action.durationMinutes) || bad(action.temperatureC))) return "Some amounts, times or temperatures are not numbers.";
  if (content.actions.some((action) => action.inputs.some((ref) => ref.quantity !== undefined && !(Number.isFinite(ref.quantity) && ref.quantity > 0)))) return "Every portion needs a positive amount.";
  return "";
}

function numberOrNull(value) {
  const trimmed = String(value).trim().replace(",", ".");
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : Number.NaN;
}

function bindEditor() {
  const editor = state.editor;
  const form = main.querySelector("#editor");
  const { content } = editor;
  const update = (target) => {
    const name = target.name;
    if (!name) return false;
    const [scope, index, field] = name.split(".");
    if (["title", "description", "attribution", "yield", "sourceUrl", "notes"].includes(name)) content[name] = target.value;
    else if (name === "message") editor.message = target.value;
    else if (name === "makeCurrent") editor.makeCurrent = target.checked;
    else if (name === "categories") { editor.categoryIds = [...form.querySelectorAll('input[name="categories"]:checked')].map((input) => input.value); return true; }
    else if (scope === "a") {
      if (index === "rating") editor.attempt.rating = Number(target.value) || null;
      else if (index === "date" || index === "outcome") editor.attempt[index] = target.value;
      else return false;
    } else if (scope === "i") {
      const item = content.ingredients[Number(index)];
      if (field === "quantity") item.quantity = numberOrNull(target.value);
      else item[field] = target.value;
      return true;
    } else if (scope === "p") {
      const ref = content.actions[Number(index)].inputs[Number(field)];
      const value = numberOrNull(target.value);
      ref.quantity = value === null ? Number.NaN : value;
      return true;
    } else if (scope === "s") {
      const action = content.actions[Number(index)];
      if (field === "durationMinutes" || field === "temperatureC") action[field] = numberOrNull(target.value);
      else action[field] = target.value;
      return true;
    }
    return false;
  };
  form.addEventListener("input", (event) => { if (update(event.target)) renderPreview(); });
  // Labels in the input pickers depend on names and amounts: refresh them when a field is committed.
  form.addEventListener("change", (event) => {
    if (update(event.target) && /^(i\.|p\.|s\.\d+\.text)/.test(event.target.name)) {
      const focusName = document.activeElement?.name;
      renderEditor();
      if (focusName) main.querySelector(`[name="${CSS.escape(focusName)}"]`)?.focus();
    }
  });
  form.querySelector("#add-ingredient").onclick = () => {
    content.ingredients.push({ id: nextId("i", content.ingredients), name: "", quantity: null, unit: "g", note: "" });
    renderEditor();
    main.querySelector(`[name="i.${content.ingredients.length - 1}.name"]`).focus();
  };
  form.querySelector("#add-step").onclick = () => {
    content.actions.push({ id: nextId("a", content.actions), text: "", inputs: [], durationMinutes: null, temperatureC: null, ovenMode: "" });
    renderEditor();
    main.querySelector(`[name="s.${content.actions.length - 1}.text"]`).focus();
  };
  form.querySelectorAll("[data-remove-ingredient]").forEach((button) => {
    button.onclick = () => {
      const [item] = content.ingredients.splice(Number(button.dataset.removeIngredient), 1);
      for (const action of content.actions) action.inputs = action.inputs.filter((ref) => ref.ingredient !== item.id);
      renderEditor();
    };
  });
  form.querySelectorAll("[data-remove-step]").forEach((button) => {
    button.onclick = () => {
      const [step] = content.actions.splice(Number(button.dataset.removeStep), 1);
      for (const action of content.actions) action.inputs = action.inputs.filter((ref) => ref.action !== step.id);
      renderEditor();
    };
  });
  form.querySelectorAll("[data-remove-input]").forEach((button) => {
    button.onclick = () => {
      const [stepIndex, refIndex] = button.dataset.removeInput.split(":").map(Number);
      content.actions[stepIndex].inputs.splice(refIndex, 1);
      renderEditor();
    };
  });
  form.querySelectorAll("[data-input-select]").forEach((select) => {
    const index = Number(select.dataset.inputSelect);
    const portion = form.querySelector(`[data-portion="${index}"]`);
    select.onchange = () => {
      const [kind, id] = select.value.split(":");
      const item = kind === "i" ? content.ingredients.find((ingredient) => ingredient.id === id) : null;
      const left = item ? remaining(item, allocation(content).used) : null;
      portion.closest("label").hidden = !(item && left !== null);
      if (item && left !== null) portion.value = formatQuantity(left);
    };
    form.querySelector(`[data-add-input="${index}"]`).onclick = () => {
      const [kind, id] = select.value.split(":");
      if (!kind) return;
      const action = content.actions[index];
      if (kind === "a") action.inputs.push({ action: id });
      else {
        const item = content.ingredients.find((ingredient) => ingredient.id === id);
        const slot = allocation(content).used.get(id);
        const amount = numberOrNull(portion.value);
        if (item.quantity !== null && amount !== null && (!Number.isFinite(amount) || amount <= 0)) { notice("Enter a positive amount for the portion.", { kind: "error" }); return; }
        // Using the full, untouched amount is stored as the whole ingredient; anything else is a portion.
        if (item.quantity === null || amount === null || (!slot.portions && Math.abs(amount - item.quantity) < 1e-9)) action.inputs.push({ ingredient: id });
        else action.inputs.push({ ingredient: id, quantity: amount });
      }
      renderEditor();
    };
  });
  form.querySelector("#apply-multiplier")?.addEventListener("click", () => {
    try { applyAttemptMultiplier(parseMultiplier(form.querySelector('[name="a.multiplier"]').value)); renderEditor(); }
    catch (error) { notice(error.message, { kind: "error" }); }
  });
  form.querySelectorAll("[data-upload]").forEach((input) => {
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const { id } = await api("photos", file, { raw: true, type: file.type || "application/octet-stream" });
        editor.staged.add(id);
        (input.dataset.upload === "attempt" ? editor.attempt.photos : content.photos).push(id);
        renderEditor();
      } catch (error) { failure(error); }
    };
  });
  form.querySelectorAll("[data-remove-photo]").forEach((button) => {
    button.onclick = () => {
      const [target, id] = button.dataset.removePhoto.split(":");
      const list = target === "attempt" ? editor.attempt.photos : content.photos;
      list.splice(list.indexOf(id), 1);
      const stillUsed = content.photos.includes(id) || editor.attempt.photos.includes(id);
      if (editor.staged.has(id) && !stillUsed) { editor.staged.delete(id); api(`photos/${encodeURIComponent(id)}/discard`, {}).catch(() => {}); }
      renderEditor();
    };
  });
  form.onsubmit = (event) => { event.preventDefault(); saveEditor(); };
}

/**
 * After a 409 the entry keeps its own parent (the snapshot the user chose, which still
 * exists because snapshots are immutable), so it becomes a sibling of whatever the other
 * window saved. If the other window moved Current, promotion is switched off: moving
 * Current again needs a fresh, explicit tick by the user, who now sees the new Current.
 */
async function recoverFromConflict(editor) {
  const doc = await loadDoc(editor.recipeId);
  if (state.editor !== editor) return;
  editor.expectedVersion = doc.version;
  const parentLabel = editor.parentLabel;
  let message = `Loaded the latest history. Your entry is still based on ${parentLabel}, the entry you started from, and will be added next to the other changes. Nothing was overwritten. Save again when ready.`;
  if (doc.current !== editor.seenCurrent) {
    const wasPromoting = editor.makeCurrent;
    editor.makeCurrent = false;
    editor.seenCurrent = doc.current;
    editor.seenCurrentLabel = entryLabel(doc, snapshotOf(doc, doc.current));
    message = `Another window changed the current recipe to ${editor.seenCurrentLabel}. Your entry is still based on ${parentLabel} and will be saved as a separate branch.${wasPromoting ? ` "Make this the current recipe" was unticked. Tick it again only if your entry should replace ${editor.seenCurrentLabel} as the current recipe.` : ""}`;
  }
  renderEditor();
  notice(message, { kind: "info" });
}

async function saveEditor() {
  const editor = state.editor;
  const content = clone(editor.content);
  editor.errors = [];
  const badNumbers = invalidNumbers(content);
  if (badNumbers) editor.errors.push(badNumbers);
  if (!badNumbers) editor.errors.push(...validateDiagram(content).errors.map((error) => error.message));
  if (editor.errors.length) { renderEditor(); main.querySelector("#save-errors").scrollIntoView({ block: "center" }); return; }
  try {
    let response;
    if (editor.mode === "new") response = await api("recipes", { content, categoryIds: editor.categoryIds });
    else {
      response = await api(`recipes/${encodeURIComponent(editor.recipeId)}/entries`, {
        expectedVersion: editor.expectedVersion, parentId: editor.parentId, kind: editor.mode, content,
        attempt: editor.mode === "attempt" ? editor.attempt : undefined, makeCurrent: editor.makeCurrent, message: editor.message,
        expectedCurrent: editor.makeCurrent ? editor.seenCurrent : undefined,
      });
    }
    // The server moved this entry's photos into the cookbook folder; any others are discarded.
    for (const id of [...content.photos, ...(editor.mode === "attempt" ? editor.attempt.photos : [])]) editor.staged.delete(id);
    discardStaged(editor);
    if (editor.draftId) { try { await api(`drafts/${encodeURIComponent(editor.draftId)}/dismiss`, {}); } catch { /* already gone */ } }
    state.editor = null;
    state.doc = response.recipe;
    savedLocally(response);
    await loadRecipes();
    notice(editor.mode === "new" ? "Recipe saved." : editor.makeCurrent ? "Saved and set as the current recipe." : "Saved to the history. The current recipe is unchanged.", { kind: "success" });
    state.selected = response.snapshotId;
    location.hash = editor.mode === "new" ? `#/r/${response.recipe.id}` : `#/r/${response.recipe.id}/history`;
  } catch (error) {
    if (error.body?.code === "cookbook_changed") {
      editor.errors = [error.message];
      renderEditor();
      return;
    }
    if (error.status === 409 && editor.recipeId) {
      notice(`${error.message} Your edits are still here.`, {
        kind: "warning",
        actions: [{ label: "Load the latest history and keep my edits", run: () => recoverFromConflict(editor).catch(failure) }],
      });
      return;
    }
    if (error.body?.diagramErrors) editor.errors = error.body.diagramErrors.map((item) => item.message);
    else editor.errors = [error.message];
    renderEditor();
  }
}

// ---- start -----------------------------------------------------------------

window.addEventListener("hashchange", () => {
  if (!location.hash.includes("/edit/") && !location.hash.startsWith("#/draft")) { discardStaged(state.editor); state.editor = null; }
  route();
});
window.addEventListener("focus", async () => {
  if (!state.info?.configured) return;
  loadSync();
  if (!location.hash || location.hash === "#/") { await loadDrafts(); if (!state.editor) route(); }
});
setInterval(async () => {
  if (!state.info?.configured || (location.hash && location.hash !== "#/")) return;
  const before = state.drafts.length;
  await loadDrafts();
  if (state.drafts.length !== before) renderBrowse();
}, 5000);

await route();
loadSync();
