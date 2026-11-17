import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../.github/extensions/open-sauce/runtime.mjs";
import { cookbookCanvas } from "../.github/extensions/open-sauce/canvas.mjs";
import { A, EXT, I, PNG_1PX, content, ing, scratch, step } from "./helpers.mjs";

async function demoServer(t) {
  const root = scratch(t, "server");
  const dataDir = join(root, "book");
  cpSync(new URL("examples/demo-cookbook/", EXT), dataDir, { recursive: true });
  const runtime = await createRuntime({ env: { OPEN_SAUCE_DATA: dataDir, OPEN_SAUCE_CONFIG: join(root, "config.json") } });
  const server = await runtime.open("test");
  t.after(() => runtime.dispose());
  // Like the UI: every write names the cookbook this client loaded.
  const api = (path, options = {}) => fetch(`${server.url}${path}`, options.method === "POST" ? { ...options, headers: { "X-Open-Sauce-Cookbook": runtime.info().cookbookId, ...options.headers } } : options);
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { runtime, server, api, post, dataDir, root };
}

test("API rejects a missing or wrong access token", async (t) => {
  const { server } = await demoServer(t);
  for (const path of ["/api/recipes", "/", "/api/info", `/${"0".repeat(48)}/api/recipes`]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 401, path);
    assert.match((await response.json()).error, /access token/);
  }
  const post = await fetch(`${server.origin}/api/recipes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(post.status, 401);
});

test("serves the UI with a strict CSP and lists recipes with the token", async (t) => {
  const { api } = await demoServer(t);
  const page = await api("");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await page.text(), /<script type="module" src="app\.js">/);
  const list = await (await api("api/recipes")).json();
  assert.ok(list.recipes.some((recipe) => recipe.title === "Apfelkuchen"));
  assert.deepEqual(list.categories.categories.slice(0, 2).map((category) => category.name), ["Sweet", "Savory"]);
  const info = await (await api("api/info")).json();
  assert.equal(info.appName, "Open Sauce");
  assert.equal(info.source, "env");
});

test("cross-origin mutations and foreign Host headers are rejected", async (t) => {
  const { server, api } = await demoServer(t);
  const evil = await api("api/categories", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ expectedVersion: 1, name: "Hacked" }) });
  assert.equal(evil.status, 403);
  const crossSite = await api("api/categories", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ expectedVersion: 1, name: "Hacked" }) });
  assert.equal(crossSite.status, 403);
  const formPost = await api("api/categories", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ expectedVersion: 1, name: "Hacked" }) });
  assert.equal(formPost.status, 415, "simple (non-preflighted) requests are refused");
  const status = await new Promise((resolve, reject) => {
    const url = new URL(`${server.url}api/info`);
    const request = httpRequest({ host: "127.0.0.1", port: url.port, path: url.pathname, headers: { Host: `attacker.example:${url.port}` } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 403);
  const categories = await (await api("api/categories")).json();
  assert.ok(!categories.categories.some((category) => category.name === "Hacked"));
});

test("stale writes over HTTP return 409 and keep the newer data", async (t) => {
  const { api, post } = await demoServer(t);
  const { recipe } = await (await api("api/recipes/apfelkuchen")).json();
  const base = recipe.snapshots[0].content;
  const first = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: recipe.current, kind: "revision", content: { ...base, notes: "Panel one" } });
  assert.equal(first.status, 201);
  const second = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: recipe.current, kind: "revision", content: { ...base, notes: "Panel two" } });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.match(body.error, /changed in another window/);
  assert.equal(body.currentVersion, recipe.version + 1);
});

test("photo upload validates type and returns a generated id", async (t) => {
  const { api } = await demoServer(t);
  const bad = await api("api/photos", { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from("not an image") });
  assert.equal(bad.status, 415);
  const gif = await api("api/photos", { method: "POST", headers: { "Content-Type": "image/gif" }, body: Buffer.from("GIF89a") });
  assert.equal(gif.status, 415);
  const good = await api("api/photos", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG_1PX });
  assert.equal(good.status, 201);
  const { id } = await good.json();
  const photo = await api(`api/photos/${id}`);
  assert.equal(photo.headers.get("content-type"), "image/png");
});

test("setup state: unconfigured until the demo cookbook is copied; app folder is refused", async (t) => {
  const root = scratch(t, "setup");
  const env = { OPEN_SAUCE_CONFIG: join(root, "config", "config.json"), OPEN_SAUCE_DEMO_DIR: join(root, "demo") };
  const runtime = await createRuntime({ env });
  t.after(() => runtime.dispose());
  const server = await runtime.open("setup");
  const post = (path, body) => fetch(`${server.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(`${server.url}api/info`)).json()).configured, false);
  assert.equal((await fetch(`${server.url}api/recipes`)).status, 412);
  const inside = await post("api/setup", { mode: "folder", path: join(EXT.pathname, "my-recipes") });
  assert.equal(inside.status, 400);
  assert.match((await inside.json()).error, /outside the app folder/);
  const demo = await (await post("api/setup", { mode: "demo" })).json();
  assert.equal(demo.configured, true);
  assert.equal(demo.source, "demo");
  assert.ok(demo.dataDir.startsWith(join(root, "demo")));
  assert.ok(!existsSync(env.OPEN_SAUCE_CONFIG), "the demo is not remembered as the real cookbook");
  assert.ok((await (await fetch(`${server.url}api/recipes`)).json()).recipes.length >= 3);
});

test("canvas actions are read-only plus drafts, and validate input", async (t) => {
  const { runtime, api } = await demoServer(t);
  class CanvasError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const canvas = cookbookCanvas({ createCanvas: (definition) => definition, CanvasError }, runtime);
  assert.equal(canvas.id, "open-sauce");
  const action = (name) => canvas.actions.find((item) => item.name === name).handler;

  const list = await action("list_recipes")({ input: {} });
  assert.ok(list.some((recipe) => recipe.id === "apfelkuchen" && recipe.categories.includes("Sweet")));
  const current = await action("get_recipe")({ input: { recipeId: "banana-bread" } });
  assert.equal(current.snapshotId, "s_d0000000004d");
  assert.throws(() => action("get_recipe")({ input: { recipeId: "../etc" } }), (error) => error.code === "invalid_input");
  assert.throws(() => action("get_recipe")({ input: { recipeId: "nope" } }), (error) => error.code === "not_found");

  const before = JSON.stringify((await (await api("api/recipes")).json()).recipes);
  const draft = await action("submit_draft")({ input: {
    message: "Suggested lemon drizzle",
    recipe: { title: "Lemon drizzle", ingredients: [ing("i1", "Flour", 200), ing("i2", "Sugar", 150)], actions: [step("a1", "Mix", [I("i1"), I("i2", 100)]), step("a2", "Drizzle", [A("a1"), I("i2", 50)])] },
  } });
  assert.equal(draft.status, "in_review");
  assert.deepEqual(draft.diagramErrors, []);
  const revision = await action("submit_draft")({ input: { recipeId: "apfelkuchen", recipe: content([ing("i1", "Flour", 1)], [step("a1", "Mix", [])]) } });
  assert.ok(revision.diagramErrors.some((message) => /no inputs/.test(message)), "invalid diagrams are flagged for review, not saved");
  assert.throws(() => action("submit_draft")({ input: { recipe: { title: "", ingredients: [], actions: [] } } }), (error) => error.code === "invalid_input");
  assert.throws(() => action("submit_draft")({ input: { recipeId: "missing-recipe", recipe: content([], []) } }), (error) => error.code === "not_found");

  const drafts = await (await api("api/drafts")).json();
  assert.equal(drafts.drafts.length, 2);
  assert.equal(JSON.stringify((await (await api("api/recipes")).json()).recipes), before, "drafts never save anything");
});

test("photos added while reviewing stay in memory: cancel, failed save and restart write nothing; Save publishes them", async (t) => {
  const { runtime, api, post, dataDir, root } = await demoServer(t);
  const assets = () => readdirSync(join(dataDir, "assets")).sort();
  const before = assets();
  const upload = async () => (await (await api("api/photos", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG_1PX })).json()).id;
  const cancelled = await upload();
  assert.deepEqual(assets(), before, "upload writes nothing to the cookbook folder");
  assert.equal((await api(`api/photos/${cancelled}`)).status, 200, "the editor can show it");
  assert.deepEqual(await (await post(`api/photos/${cancelled}/discard`, {})).json(), { discarded: true });
  assert.equal((await api(`api/photos/${cancelled}`)).status, 404);

  const { recipe } = await (await api("api/recipes/apfelkuchen")).json();
  const base = recipe.snapshots.find((snapshot) => snapshot.id === recipe.current).content;
  const kept = await upload();
  const stale = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version - 1, parentId: recipe.current, kind: "revision", content: { ...base, photos: [...base.photos, kept] } });
  assert.equal(stale.status, 409);
  assert.deepEqual(assets(), before, "a failed save publishes nothing");

  const saved = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: recipe.current, kind: "revision", content: { ...base, photos: [...base.photos, kept] } });
  assert.equal(saved.status, 201);
  assert.deepEqual(assets(), [...before, kept].sort());
  assert.equal(runtime.stagedPhoto(kept), null, "released from memory after Save");
  assert.equal((await api(`api/photos/${kept}`)).status, 200, "now served from the cookbook folder");

  // Unsaved photos do not survive a restart, and saving one afterwards is refused clearly.
  const lost = await upload();
  await runtime.dispose();
  const restarted = await createRuntime({ env: { OPEN_SAUCE_DATA: dataDir, OPEN_SAUCE_CONFIG: join(root, "config.json") } });
  t.after(() => restarted.dispose());
  const server2 = await restarted.open("again");
  const { recipe: now } = await (await fetch(`${server2.url}api/recipes/apfelkuchen`)).json();
  const retry = await fetch(`${server2.url}api/recipes/apfelkuchen/entries`, { method: "POST", headers: { "Content-Type": "application/json", "X-Open-Sauce-Cookbook": restarted.info().cookbookId }, body: JSON.stringify({ expectedVersion: now.version, parentId: now.current, kind: "revision", content: { ...base, notes: "x", photos: [lost] } }) });
  assert.equal(retry.status, 422);
  assert.match((await retry.json()).error, /no longer available/);
  assert.ok(!assets().includes(lost));
});

test("revision drafts keep the photos of their exact base snapshot through review and save, for Copilot and local agents", async (t) => {
  const { runtime, api, post, dataDir } = await demoServer(t);
  const upload = async () => (await (await api("api/photos", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG_1PX })).json()).id;
  const doc = async () => (await (await api("api/recipes/apfelkuchen")).json()).recipe;
  const snapshot = (recipe, id) => recipe.snapshots.find((item) => item.id === id);
  const saveCurrent = async (photos) => {
    const recipe = await doc();
    const base = snapshot(recipe, recipe.current).content;
    const response = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: recipe.current, kind: "revision", content: { ...base, photos }, makeCurrent: true, expectedCurrent: recipe.current });
    assert.equal(response.status, 201);
    return (await response.json()).snapshotId;
  };
  const oldPhoto = await upload();
  const oldSnapshot = await saveCurrent([oldPhoto]);
  const newPhotos = [await upload(), await upload()];
  await saveCurrent(newPhotos);

  // Assistants read recipes without photo ids and send none.
  class CanvasError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const canvas = cookbookCanvas({ createCanvas: (definition) => definition, CanvasError }, runtime);
  const action = (name) => canvas.actions.find((item) => item.name === name).handler;
  const read = await action("get_recipe")({ input: { recipeId: "apfelkuchen" } });
  assert.deepEqual([read.recipe.photos, read.photoCount], [[], 2]);
  const endpoint = JSON.parse(readFileSync(runtime.info().agent.file, "utf8"));
  const agent = (path, body) => fetch(new URL(path, endpoint.url), { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${endpoint.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  const agentRead = await (await agent("recipes/apfelkuchen")).json();
  assert.deepEqual([agentRead.recipe.photos, agentRead.photoCount], [[], 2]);

  const copilot = await action("submit_draft")({ input: { recipeId: "apfelkuchen", recipe: { ...read.recipe, notes: "Copilot: less sugar" } } });
  assert.equal(copilot.cookbook, dataDir);
  const fromOld = await (await agent("drafts", { recipeId: "apfelkuchen", baseSnapshotId: oldSnapshot, recipe: { ...agentRead.recipe, notes: "Agent: based on the old entry" } })).json();
  const assetsBefore = readdirSync(join(dataDir, "assets")).sort();
  const drafts = (await (await api("api/drafts")).json()).drafts;
  const reviewed = (id) => drafts.find((draft) => draft.id === id);
  assert.deepEqual(reviewed(copilot.draftId).content.photos, newPhotos, "Copilot revision shows the photos of Current");
  assert.deepEqual(reviewed(fromOld.draftId).content.photos, [oldPhoto], "a branch from an old snapshot shows that snapshot's photos, not Current's");

  // Saving the reviewed Copilot draft (promoted) keeps its photos.
  let recipe = await doc();
  const draftA = reviewed(copilot.draftId);
  let response = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: draftA.baseSnapshotId, kind: "revision", content: draftA.content, makeCurrent: true, expectedCurrent: recipe.current });
  assert.equal(response.status, 201);
  recipe = (await response.json()).recipe;
  assert.deepEqual(snapshot(recipe, recipe.current).content.photos, newPhotos);

  // The agent's branch from the old snapshot, intentionally promoted, keeps the old snapshot's photo.
  const draftB = reviewed(fromOld.draftId);
  response = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: draftB.baseSnapshotId, kind: "revision", content: draftB.content, makeCurrent: true, expectedCurrent: recipe.current });
  assert.equal(response.status, 201);
  recipe = (await response.json()).recipe;
  const promoted = snapshot(recipe, recipe.current);
  assert.equal(promoted.parent, oldSnapshot);
  assert.deepEqual(promoted.content.photos, [oldPhoto]);

  // Removing a photo is only possible as an explicit edit by the user, and history keeps it.
  const third = await action("submit_draft")({ input: { recipeId: "apfelkuchen", recipe: { ...read.recipe, notes: "third" } } });
  const draftC = (await (await api("api/drafts")).json()).drafts.find((draft) => draft.id === third.draftId);
  assert.deepEqual(draftC.content.photos, [oldPhoto]);
  response = await post("api/recipes/apfelkuchen/entries", { expectedVersion: recipe.version, parentId: draftC.baseSnapshotId, kind: "revision", content: { ...draftC.content, photos: [] } });
  recipe = (await response.json()).recipe;
  assert.deepEqual(recipe.snapshots.at(-1).content.photos, []);
  assert.deepEqual(snapshot(recipe, recipe.current).content.photos, [oldPhoto], "not promoted, Current keeps its photo");
  assert.deepEqual(readdirSync(join(dataDir, "assets")).sort(), assetsBefore, "no photo file is added or removed by drafts");
});

test("a write is bound to the cookbook the window loaded; changing folders keeps drafts and never saves across cookbooks", async (t) => {
  const root = scratch(t, "switch");
  // The app refuses cookbook folders inside its own folder, so these two live next to it and are removed afterwards.
  const outside = join(new URL("../../../../", EXT).pathname, `.open-sauce-switch-test-${process.pid}`);
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const [bookA, bookB] = ["a", "b"].map((name) => {
    const dir = join(outside, name);
    cpSync(new URL("examples/demo-cookbook/", EXT), dir, { recursive: true });
    return dir;
  });
  const runtime = await createRuntime({ env: { OPEN_SAUCE_CONFIG: join(root, "config", "config.json") } });
  t.after(() => runtime.dispose());
  const server = await runtime.open("switch");
  const send = (path, body, cookbookId, type = "application/json") => fetch(`${server.url}${path}`, { method: "POST", headers: { "Content-Type": type, ...(cookbookId ? { "X-Open-Sauce-Cookbook": cookbookId } : {}) }, body: type === "application/json" ? JSON.stringify(body) : body });
  const info = async () => (await fetch(`${server.url}api/info`)).json();

  assert.equal((await send("api/setup", { mode: "folder", path: bookA })).status, 200);
  const panelA = (await info()).cookbookId;
  assert.match(panelA, /^cb_[0-9a-f]{12}$/);
  assert.equal((await send("api/setup", { mode: "folder", path: bookA })).status, 200, "same target is a no-op");
  assert.equal((await info()).cookbookId, panelA);

  // A draft waiting for review blocks the switch; nothing is discarded.
  const draft = runtime.submitDraft({ recipe: { title: "Waiting", ingredients: [ing("i1", "Flour", 1)], actions: [step("a1", "Mix", [I("i1")])] } });
  const blocked = await send("api/setup", { mode: "folder", path: bookB });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /1 draft is waiting/);
  assert.equal((await info()).dataDir, bookA);
  assert.equal((await send(`api/drafts/${draft.id}/dismiss`, {}, panelA)).status, 200);

  // Panel A has an open edit and a staged photo; panel B switches to book B (same recipe ids and versions).
  const { id: photo } = await (await send("api/photos", PNG_1PX, panelA, "image/png")).json();
  const { recipe } = await (await fetch(`${server.url}api/recipes/apfelkuchen`)).json();
  const base = recipe.snapshots.find((snapshot) => snapshot.id === recipe.current).content;
  const entry = { expectedVersion: recipe.version, parentId: recipe.current, kind: "revision", content: { ...base, notes: "edited for A", photos: [photo] } };
  assert.equal((await send("api/setup", { mode: "folder", path: bookB })).status, 200);
  const panelB = (await info()).cookbookId;
  assert.notEqual(panelB, panelA);
  const before = readFileSync(join(bookB, "recipes", "apfelkuchen.json"), "utf8");

  for (const cookbookId of [panelA, undefined]) {
    const stale = await send("api/recipes/apfelkuchen/entries", entry, cookbookId);
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.code, "cookbook_changed");
    assert.equal(body.cookbook, bookB);
    assert.equal((await send("api/photos", PNG_1PX, cookbookId, "image/png")).status, 409);
  }
  assert.equal(readFileSync(join(bookB, "recipes", "apfelkuchen.json"), "utf8"), before, "nothing was saved into the other cookbook");
  assert.ok(!readdirSync(join(bookA, "recipes")).some((name) => name.includes(".tmp")));
  // Book A's unsaved photo is not visible to, and cannot be published into, book B.
  assert.equal(runtime.stagedPhoto(photo), null);
  const crossPhoto = await send("api/recipes/apfelkuchen/entries", entry, panelB);
  assert.equal(crossPhoto.status, 422);
  assert.ok(!readdirSync(join(bookB, "assets")).includes(photo));
});

test("staged photos expire on read, not only when another photo is uploaded", async (t) => {
  const root = scratch(t, "ttl");
  const dataDir = join(root, "book");
  cpSync(new URL("examples/demo-cookbook/", EXT), dataDir, { recursive: true });
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const runtime = await createRuntime({ env: { OPEN_SAUCE_DATA: dataDir, OPEN_SAUCE_CONFIG: join(root, "config.json") }, now: () => clock });
  t.after(() => runtime.dispose());
  const { id } = runtime.stagePhoto(PNG_1PX, "image/png");
  clock += 23 * 60 * 60 * 1000;
  assert.ok(runtime.stagedPhoto(id));
  clock += 2 * 60 * 60 * 1000;
  assert.equal(runtime.stagedPhoto(id), null, "expired when read");
  assert.equal(runtime.stagedPhotos.size, 0, "and never handed to a save");
  const recipe = runtime.cookbook.getRecipe("apfelkuchen");
  const base = recipe.snapshots.find((snapshot) => snapshot.id === recipe.current).content;
  await assert.rejects(runtime.cookbook.saveEntry("apfelkuchen", { expectedVersion: recipe.version, parentId: recipe.current, kind: "revision", content: { ...base, photos: [id] } }, { stagedPhotos: runtime.stagedPhotos }), (error) => error.status === 422);
  assert.ok(!readdirSync(join(dataDir, "assets")).includes(id));
});
