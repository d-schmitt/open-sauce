import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { createRuntime } from "../.github/extensions/open-sauce/runtime.mjs";
import { cookbookCanvas } from "../.github/extensions/open-sauce/canvas.mjs";
import { DRAFT_SCHEMA, MAX_DRAFTS } from "../.github/extensions/open-sauce/drafts.mjs";
import { A, EXT, I, ing, scratch, step } from "./helpers.mjs";

/** Every file path and its content hash, to prove that submitting drafts writes nothing. */
function fingerprint(dir) {
  const out = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function agentSetup(t) {
  const root = scratch(t, "agent");
  const dataDir = join(root, "book");
  cpSync(new URL("examples/demo-cookbook/", EXT), dataDir, { recursive: true });
  const env = { OPEN_SAUCE_DATA: dataDir, OPEN_SAUCE_CONFIG: join(root, "config", "config.json") };
  const runtime = await createRuntime({ env });
  const ui = await runtime.open("ui");
  t.after(() => runtime.dispose());
  const file = runtime.info().agent.file;
  const endpoint = JSON.parse(readFileSync(file, "utf8"));
  const call = (path, { method = "GET", body, token = endpoint.token, headers = {} } = {}) => fetch(new URL(path, endpoint.url), {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { root, dataDir, env, runtime, ui, file, endpoint, call };
}

/** A synthetic recipe with two branches and a split ingredient, as an outside assistant would send it. */
const sampleDraft = () => ({
  submittedBy: "Test agent",
  message: "Transcribed from a card",
  categories: ["sweet", "Baking", "Holiday"],
  recipe: {
    title: "Plum crumble",
    description: "A quick crumble.",
    attribution: "Aunt Example",
    sourceUrl: "https://example.com/plum-crumble",
    yield: "1 dish",
    notes: "Works with apples too.",
    ingredients: [ing("plums", "Plums", 600), ing("sugar", "Sugar", 120), ing("flour", "Flour", 150), ing("butter", "Butter", 100)],
    actions: [
      step("fruit", "Halve plums and toss with sugar", [I("plums"), I("sugar", 40)]),
      step("crumbs", "Rub into crumbs", [I("flour"), I("butter"), I("sugar", 80)]),
      step("bake", "Scatter crumbs over fruit and bake", [A("fruit"), A("crumbs")], { durationMinutes: 35, temperatureC: 180, ovenMode: "fan" }),
    ],
  },
});

test("the agent endpoint file is private, holds address and token, and is removed on shutdown", async (t) => {
  const { file, endpoint, runtime, root, dataDir } = await agentSetup(t);
  assert.equal(join(file, ".."), join(root, "config", "agents"));
  assert.match(endpoint.instanceId, /^standalone-[0-9a-f]{12}$/);
  assert.equal(file, join(root, "config", "agents", `${endpoint.instanceId}.json`));
  assert.equal(endpoint.cookbook, dataDir);
  assert.equal(endpoint.pid, process.pid);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, "..")).mode & 0o077, 0, "folder is private to the user");
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/agent\/v1\/$/);
  assert.match(endpoint.token, /^[0-9a-f]{64}$/);
  const info = runtime.info();
  assert.equal(info.agent.running, true);
  assert.equal(info.agent.file, file);
  assert.equal(info.agent.instanceId, endpoint.instanceId);
  assert.ok(!JSON.stringify(info).includes(endpoint.token), "the UI never receives the agent token");
  await runtime.dispose();
  assert.ok(!existsSync(file));
});

test("agent requests need the agent token; the UI token and browser requests are refused", async (t) => {
  const { endpoint, call, ui } = await agentSetup(t);
  assert.equal((await call("schema", { token: null })).status, 401);
  assert.equal((await call("schema", { token: "f".repeat(64) })).status, 401);
  const uiToken = new URL(ui.url).pathname.split("/")[1];
  assert.equal((await call("schema", { token: uiToken })).status, 401, "UI token does not work here");
  // The agent token cannot reach the UI's save API, in the path or as a header.
  assert.equal((await fetch(`${ui.origin}/${endpoint.token}/api/recipes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${ui.origin}/api/recipes`, { headers: { Authorization: `Bearer ${endpoint.token}` } })).status, 401);
  // Only the documented read and draft routes exist.
  for (const [path, method] of [["recipes", "POST"], ["drafts", "GET"], ["sync", "POST"], ["../api/recipes", "GET"], ["schema?x=1", "GET"]]) {
    assert.ok([404, 405, 400].includes((await call(path, { method, body: method === "POST" ? {} : undefined })).status), path);
  }
  assert.equal((await call("drafts", { method: "POST", body: "not json", headers: { "Content-Type": "text/plain" } })).status, 415);

  const raw = (headers) => new Promise((resolve, reject) => {
    const url = new URL("schema", endpoint.url);
    const request = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { Authorization: `Bearer ${endpoint.token}`, ...headers } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(await raw({}), 200);
  assert.equal(await raw({ Origin: "https://evil.example" }), 403);
  assert.equal(await raw({ Origin: endpoint.url.replace(/\/agent.*/, "") }), 403, "even same-origin browser requests");
  assert.equal(await raw({ "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await raw({ Host: "attacker.example" }), 403);
});

test("the published schema is the one enforced, with the exact operations", async (t) => {
  const { call } = await agentSetup(t);
  const doc = await (await call("schema")).json();
  assert.deepEqual(doc.schemas.draft, DRAFT_SCHEMA);
  assert.ok(doc.operations.some((op) => op.method === "POST" && op.path === "/agent/v1/drafts"));
  const list = await (await call("recipes")).json();
  assert.ok(list.recipes.some((recipe) => recipe.id === "apfelkuchen"));
  const one = await (await call("recipes/apfelkuchen")).json();
  assert.deepEqual(one.recipe.photos, [], "the read shape can be sent back as a draft");
  assert.equal((await call("recipes/nope")).status, 404);
  assert.ok((await (await call("categories")).json()).categories.includes("Sweet"));
});

test("an agent draft goes to the same review area as Copilot drafts and writes nothing", async (t) => {
  const { dataDir, runtime, ui, call } = await agentSetup(t);
  const before = fingerprint(dataDir);
  const response = await call("drafts", { method: "POST", body: sampleDraft() });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.status, "in_review");
  assert.deepEqual(result.diagramErrors, []);
  assert.deepEqual(result.unmatchedCategories, ["Holiday"], "unknown categories are reported, never created");
  assert.ok(!JSON.stringify(result).includes(new URL(ui.url).pathname.split("/")[1]), "the response never reveals the UI address");

  // Copilot submits the same recipe through the canvas action.
  class CanvasError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const canvas = cookbookCanvas({ createCanvas: (definition) => definition, CanvasError }, runtime);
  const submit = canvas.actions.find((item) => item.name === "submit_draft").handler;
  const viaCopilot = submit({ input: sampleDraft() });
  assert.deepEqual(viaCopilot.unmatchedCategories, ["Holiday"]);

  const drafts = (await (await fetch(`${ui.url}api/drafts`)).json()).drafts;
  const agentDraft = drafts.find((draft) => draft.id === result.draftId);
  const copilotDraft = drafts.find((draft) => draft.id === viaCopilot.draftId);
  assert.equal(agentDraft.source, "agent");
  assert.equal(copilotDraft.source, "copilot");
  assert.equal(agentDraft.submittedBy, "Test agent");
  assert.deepEqual(agentDraft.content, copilotDraft.content, "identical normalization");
  assert.deepEqual(agentDraft.suggestedCategoryIds, ["sweet", "baking"]);
  assert.equal(agentDraft.content.actions[1].inputs[2].quantity, 80);

  assert.deepEqual(fingerprint(dataDir), before, "no file was created or changed by submitting drafts");
  const recipes = (await (await fetch(`${ui.url}api/recipes`)).json()).recipes;
  assert.ok(!recipes.some((recipe) => recipe.title === "Plum crumble"));

  // Only the user's explicit save (the UI API) writes the recipe, with the reviewed categories.
  const saved = await fetch(`${ui.url}api/recipes`, { method: "POST", headers: { "Content-Type": "application/json", "X-Open-Sauce-Cookbook": runtime.info().cookbookId }, body: JSON.stringify({ content: { ...agentDraft.content, title: "Plum crumble (checked)" }, categoryIds: agentDraft.suggestedCategoryIds }) });
  assert.equal(saved.status, 201);
  const doc = (await saved.json()).recipe;
  assert.deepEqual(doc.categoryIds, ["sweet", "baking"]);
  assert.equal(doc.snapshots[0].content.title, "Plum crumble (checked)");
});

test("invalid agent drafts are refused with the field path, and nothing is queued", async (t) => {
  const { runtime, call } = await agentSetup(t);
  const cases = [
    [{ ...sampleDraft(), extra: 1 }, /draft has an unknown field "extra"/],
    [{ recipe: { ...sampleDraft().recipe, photos: ["p_123"] } }, /draft\.recipe\.photos must be empty/],
    [{ recipe: { ...sampleDraft().recipe, ingredients: [{ id: "x", name: "Salt", quantity: -1 }] } }, /draft\.recipe\.ingredients\[0\]\.quantity must be greater than 0/],
    [{ recipe: { ...sampleDraft().recipe, ingredients: [{ id: "x", name: "Salt", unit: "cups" }] } }, /draft\.recipe\.ingredients\[0\]\.unit must be one of/],
    [{ recipeId: "apfelkuchen", categories: ["Sweet"], recipe: sampleDraft().recipe }, /only for new recipes/],
    [{ baseSnapshotId: "s_a0000000001a", recipe: sampleDraft().recipe }, /needs recipeId/],
    [{ recipe: { ...sampleDraft().recipe, sourceUrl: "javascript:alert(1)" } }, /http/i],
  ];
  for (const [body, pattern] of cases) {
    const response = await call("drafts", { method: "POST", body });
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match((await response.json()).error, pattern);
  }
  assert.equal((await call("drafts", { method: "POST", body: { recipeId: "missing", recipe: sampleDraft().recipe } })).status, 404);
  assert.equal(runtime.drafts().length, 0);

  // A revision of an existing recipe defaults to its current snapshot.
  const revision = await (await call("drafts", { method: "POST", body: { recipeId: "banana-bread", recipe: (await (await call("recipes/banana-bread")).json()).recipe } })).json();
  assert.equal(runtime.drafts().find((draft) => draft.id === revision.draftId).baseSnapshotId, "s_d0000000004d");
});

test("a full review area refuses new drafts instead of silently dropping older ones", async (t) => {
  const { runtime, call } = await agentSetup(t);
  for (let n = 0; n < MAX_DRAFTS; n += 1) assert.equal((await call("drafts", { method: "POST", body: sampleDraft() })).status, 202);
  const ids = runtime.drafts().map((draft) => draft.id);
  const full = await call("drafts", { method: "POST", body: sampleDraft() });
  assert.equal(full.status, 429);
  assert.match((await full.json()).error, /review or dismiss/);
  assert.deepEqual(runtime.drafts().map((draft) => draft.id), ids, "existing drafts are kept");
});

test("drafts are ephemeral, an unconfigured app refuses them, and its endpoint file gains the cookbook after setup", async (t) => {
  const { env, call, runtime } = await agentSetup(t);
  assert.equal((await call("drafts", { method: "POST", body: sampleDraft() })).status, 202);
  await runtime.dispose();
  const second = await createRuntime({ env });
  t.after(() => second.dispose());
  await second.open("ui2");
  assert.equal(second.drafts().length, 0, "drafts are not persisted between runs");

  const root = scratch(t, "agent-unconfigured");
  const empty = await createRuntime({ env: { OPEN_SAUCE_CONFIG: join(root, "config.json"), OPEN_SAUCE_DEMO_DIR: join(root, "demo") } });
  t.after(() => empty.dispose());
  await empty.open("ui");
  const file = empty.info().agent.file;
  const info = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(info.cookbook, null);
  const response = await fetch(`${info.url}drafts`, { method: "POST", headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" }, body: JSON.stringify(sampleDraft()) });
  assert.equal(response.status, 412);
  await empty.setup({ mode: "demo" });
  const updated = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(updated.cookbook, empty.info().dataDir);
  assert.equal(updated.token, info.token, "same instance, same token");
});

/** Two instances at once (for example the standalone app and a Copilot canvas) on different cookbooks, sharing one config folder. */
test("simultaneous instances have separate endpoint files; each assistant reaches only its intended instance; stopping one leaves the other working", async (t) => {
  const root = scratch(t, "agent-multi");
  const config = join(root, "config", "config.json");
  const bookA = join(root, "book-a");
  const bookB = join(root, "book-b");
  cpSync(new URL("examples/demo-cookbook/", EXT), bookA, { recursive: true });
  cpSync(new URL("examples/demo-cookbook/", EXT), bookB, { recursive: true });
  const a = await createRuntime({ env: { OPEN_SAUCE_DATA: bookA, OPEN_SAUCE_CONFIG: config }, surface: "standalone" });
  const b = await createRuntime({ env: { OPEN_SAUCE_DATA: bookB, OPEN_SAUCE_CONFIG: config }, surface: "canvas" });
  t.after(() => Promise.all([a.dispose(), b.dispose()]));
  await a.open("ui");
  await b.open("canvas-1");
  const infoA = a.info().agent;
  const infoB = b.info().agent;
  assert.notEqual(infoA.file, infoB.file);
  assert.match(infoB.instanceId, /^canvas-[0-9a-f]{12}$/);
  const fileA = JSON.parse(readFileSync(infoA.file, "utf8"));
  const fileB = JSON.parse(readFileSync(infoB.file, "utf8"));
  assert.equal(fileA.cookbook, bookA);
  assert.equal(fileB.cookbook, bookB);
  assert.notEqual(fileA.token, fileB.token);
  assert.deepEqual(readdirSync(join(root, "config", "agents")).sort(), [`${infoA.instanceId}.json`, `${infoB.instanceId}.json`].sort());
  // Each UI lists the other instance (without a token) so the user can pick explicitly.
  assert.deepEqual(a.info().agent.others.map((other) => [other.instanceId, other.cookbook, other.file]), [[infoB.instanceId, bookB, infoB.file]]);
  assert.deepEqual(b.info().agent.others.map((other) => other.instanceId), [infoA.instanceId]);
  assert.ok(!JSON.stringify([a.info(), b.info()]).includes(fileA.token) && !JSON.stringify([a.info(), b.info()]).includes(fileB.token));

  const send = (endpoint, body, headers = {}) => fetch(`${endpoint.url}drafts`, {
    method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const before = { a: fingerprint(bookA), b: fingerprint(bookB) };
  const draftA = { ...sampleDraft(), recipe: { ...sampleDraft().recipe, title: "Only for A" } };
  const draftB = { ...sampleDraft(), recipe: { ...sampleDraft().recipe, title: "Only for B" } };
  const resA = await send(fileA, draftA, { "X-Open-Sauce-Instance": fileA.instanceId });
  assert.equal(resA.status, 202);
  assert.deepEqual((await resA.json()).instance, { id: fileA.instanceId, cookbook: bookA });
  const resB = await send(fileB, draftB, { "X-Open-Sauce-Instance": fileB.instanceId });
  assert.equal(resB.status, 202);
  assert.deepEqual(a.drafts().map((draft) => draft.content.title), ["Only for A"]);
  assert.deepEqual(b.drafts().map((draft) => draft.content.title), ["Only for B"]);
  // Explicit selection: a request whose header names the other instance is refused and queues nothing.
  const wrong = await send(fileB, draftA, { "X-Open-Sauce-Instance": fileA.instanceId });
  assert.equal(wrong.status, 409);
  assert.match((await wrong.json()).error, new RegExp(fileB.instanceId));
  // A token of one instance does not work on the other.
  assert.equal((await fetch(`${fileB.url}instance`, { headers: { Authorization: `Bearer ${fileA.token}` } })).status, 401);
  assert.deepEqual(await (await fetch(`${fileB.url}instance`, { headers: { Authorization: `Bearer ${fileB.token}` } })).json(), { app: "Open Sauce", instanceId: fileB.instanceId, surface: "canvas", cookbook: bookB, pid: process.pid });
  assert.equal(b.drafts().length, 1);
  assert.deepEqual({ a: fingerprint(bookA), b: fingerprint(bookB) }, before, "no cookbook was written");

  // Stopping A removes only A's file; B keeps working with its unchanged file and token.
  await a.dispose();
  assert.ok(!existsSync(infoA.file));
  assert.deepEqual(JSON.parse(readFileSync(infoB.file, "utf8")), fileB);
  assert.equal((await send(fileB, draftB)).status, 202);
  assert.equal(b.drafts().length, 2);
  assert.deepEqual(b.info().agent.others, []);
  // And the other way round: a new A, then stopping B leaves the new A working.
  const a2 = await createRuntime({ env: { OPEN_SAUCE_DATA: bookA, OPEN_SAUCE_CONFIG: config } });
  t.after(() => a2.dispose());
  await a2.open("ui");
  const fileA2 = JSON.parse(readFileSync(a2.info().agent.file, "utf8"));
  assert.notEqual(fileA2.instanceId, fileA.instanceId);
  await b.dispose();
  assert.ok(!existsSync(infoB.file));
  assert.ok(existsSync(a2.info().agent.file));
  assert.equal((await send(fileA2, draftA)).status, 202);
  assert.deepEqual(a2.drafts().map((draft) => draft.content.title), ["Only for A"]);
});

test("endpoint files of crashed instances are removed on the next start; live and unreadable ones are kept", async (t) => {
  const root = scratch(t, "agent-crash");
  const dir = join(root, "config", "agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A pid that cannot exist (beyond the usual maximum) stands in for a crashed process.
  const dead = { app: "Open Sauce", instanceId: "canvas-0123456789ab", surface: "canvas", cookbook: "/nowhere", url: "http://127.0.0.1:9/agent/v1/", token: "x", pid: 2 ** 30, startedAt: "2026-01-01T00:00:00Z" };
  const live = { ...dead, instanceId: "standalone-0123456789ab", surface: "standalone", pid: process.ppid };
  writeFileSync(join(dir, `${dead.instanceId}.json`), JSON.stringify(dead), { mode: 0o600 });
  writeFileSync(join(dir, `${live.instanceId}.json`), JSON.stringify(live), { mode: 0o600 });
  writeFileSync(join(dir, "canvas-ffffffffffff.json"), "{ half written", { mode: 0o600 });
  writeFileSync(join(dir, "notes.txt"), "not ours");
  const runtime = await createRuntime({ env: { OPEN_SAUCE_CONFIG: join(root, "config", "config.json") } });
  t.after(() => runtime.dispose());
  await runtime.open("ui");
  const own = `${runtime.info().agent.instanceId}.json`;
  assert.deepEqual(readdirSync(dir).sort(), [own, "canvas-ffffffffffff.json", "notes.txt", `${live.instanceId}.json`].sort());
  assert.deepEqual(runtime.info().agent.others.map((other) => other.instanceId), [live.instanceId]);
});

test("the agent interface can be switched off", async (t) => {
  const root = scratch(t, "agent-off");
  const runtime = await createRuntime({ env: { OPEN_SAUCE_CONFIG: join(root, "config.json"), OPEN_SAUCE_AGENT: "off" } });
  t.after(() => runtime.dispose());
  await runtime.open("ui");
  assert.equal(runtime.info().agent.running, false);
  assert.ok(!existsSync(join(root, "agents")));
});

test("the UI has no blank add-recipe form: new recipes start only from a reviewed draft", () => {
  const app = readFileSync(new URL("web/app.js", EXT), "utf8");
  assert.ok(!/href="#\/new"/.test(app), "no link to a blank editor");
  assert.ok(!/openEditor\(\{\s*mode:\s*"new"(?![^}]*draft)/.test(app), "mode new is only opened with a draft");
  assert.match(app, /parts\[0\] === "add" \|\| parts\[0\] === "new"\) \{[^\n]*renderAddHelp\(\)/, "the old route shows the help page");
});
