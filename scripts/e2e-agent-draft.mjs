// Browser end-to-end check of adding a recipe through a local AI assistant (dev helper, not part of the app).
// Usage: npm run -s e2e:agent   (optional SCREENSHOT_DIR saves the help page and the review editor)
//
// Self-contained: copies the synthetic demo cookbook twice under tests/.tmp, starts TWO real
// standalone app processes on those different cookbooks that share one config folder (as the
// standalone app and a Copilot canvas do), and removes everything afterwards. It then acts as
// outside assistants and as the user:
// - each instance's help page shows its own endpoint file and lists the other one, no tokens;
// - an assistant using one instance's file reaches only that instance and cookbook;
// - no blank add form; every submitted field is visible and editable before saving;
// - a photo added during review stays out of the cookbook folder, Cancel discards it, and
//   only "Save reviewed recipe" writes the recipe and its photo;
// - stopping one instance removes only its own file and the other keeps working.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const project = fileURLToPath(new URL("..", import.meta.url));
const root = join(project, "tests", ".tmp", `e2e-agent-${randomBytes(4).toString("hex")}`);
const config = join(root, "config", "config.json");
const shots = process.env.SCREENSHOT_DIR;
const PNG_1PX = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082", "hex");

const fingerprint = (dataDir) => {
  const out = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (name === ".git") continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dataDir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dataDir);
  return out;
};

/** Starts `npm start` equivalent; the UI URL (with its token) is read from the pipe and never printed. */
function startInstance(name) {
  const dataDir = join(root, name);
  cpSync(join(project, ".github/extensions/open-sauce/examples/demo-cookbook"), dataDir, { recursive: true });
  const child = spawn(process.execPath, [join(project, ".github/extensions/open-sauce/standalone.mjs")], {
    env: { ...process.env, OPEN_SAUCE_DATA: dataDir, OPEN_SAUCE_CONFIG: config, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const url = output.match(/^Open Sauce: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/)$/m)?.[1];
      const file = output.match(/address and token are in: (.+\.json)$/m)?.[1];
      if (url && file) resolve({ name, dataDir, child, url, file, endpoint: JSON.parse(readFileSync(file, "utf8")) });
    });
    child.once("exit", (code) => reject(new Error(`${name} exited early (${code})`)));
    setTimeout(() => reject(new Error(`${name} did not start`)), 10000);
  });
  return ready;
}
const stop = (instance) => new Promise((resolve) => {
  if (instance.child.exitCode !== null) return resolve();
  instance.child.once("exit", resolve);
  instance.child.kill("SIGTERM");
});
const submit = (endpoint, body, instanceId = endpoint.instanceId) => fetch(`${endpoint.url}drafts`, {
  method: "POST",
  headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json", "X-Open-Sauce-Instance": instanceId },
  body: JSON.stringify(body),
});

const draft = {
  submittedBy: "E2E test assistant",
  message: "Transcribed from a handwritten card",
  categories: ["Sweet", "baking", "Holiday"],
  recipe: {
    title: "Pflaumenstreusel",
    description: "Plum sheet cake with crumbs.",
    attribution: "Aunt Example",
    sourceUrl: "https://example.com/pflaumenstreusel",
    yield: "1 tray",
    notes: "Use ripe plums.",
    ingredients: [
      { id: "plums", name: "Plums", quantity: 600, unit: "g", note: "halved" },
      { id: "sugar", name: "Sugar", quantity: 120, unit: "g" },
      { id: "flour", name: "Flour", quantity: 150, unit: "g" },
      { id: "butter", name: "Butter", quantity: 100, unit: "g", note: "cold" },
    ],
    actions: [
      { id: "fruit", text: "Toss plums with sugar", inputs: [{ ingredient: "plums" }, { ingredient: "sugar", quantity: 40 }] },
      { id: "crumbs", text: "Rub into crumbs", inputs: [{ ingredient: "flour" }, { ingredient: "butter" }, { ingredient: "sugar", quantity: 80 }] },
      { id: "bake", text: "Scatter crumbs over plums and bake", inputs: [{ action: "fruit" }, { action: "crumbs" }], durationMinutes: 35, temperatureC: 180, ovenMode: "fan" },
    ],
  },
};

mkdirSync(root, { recursive: true });
const instances = [];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const problems = [];
const steps = [];
try {
  const a = await startInstance("book-a");
  instances.push(a);
  const b = await startInstance("book-b");
  instances.push(b);
  const base = a.url;
  const dataDir = a.dataDir;
  const endpoint = a.endpoint;
  assert.notEqual(a.file, b.file);
  assert.deepEqual([a.endpoint.cookbook, b.endpoint.cookbook], [a.dataDir, b.dataDir]);
  steps.push(`two live instances on different cookbooks: ${a.endpoint.instanceId} and ${b.endpoint.instanceId}, one endpoint file each`);

  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
  const api = (path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
  const assets = () => readdirSync(join(dataDir, "assets")).sort();

  // 1. No blank add-new entry point; the help page names this instance's own file.
  await page.goto(`${base}#/`);
  await page.waitForSelector(".recipe-card");
  assert.equal(await page.getByRole("link", { name: /^New recipe$/ }).count(), 0);
  assert.equal(await page.locator('a[href="#/new"]').count(), 0);
  await page.getByRole("link", { name: "Add a recipe with AI" }).click();
  await page.waitForSelector("#add-help");
  await page.goto(`${base}#/new`);
  await page.waitForSelector("#add-help");
  assert.equal(await page.locator("form#editor").count(), 0, "the old route shows help, not a blank editor");
  const help = await page.locator("#add-help").textContent();
  assert.equal(await page.locator("#agent-file").textContent(), a.file, "help shows this instance's own endpoint file");
  assert.equal(await page.locator("#agent-instance").textContent(), a.endpoint.instanceId);
  assert.ok(help.includes(a.dataDir), "help shows this instance's cookbook folder");
  const others = await page.locator("#other-instances").textContent();
  assert.ok(others.includes(b.file) && others.includes(b.dataDir) && others.includes(b.endpoint.instanceId), "the other instance is listed for explicit selection");
  const html = await page.content();
  assert.ok(!html.includes(a.endpoint.token) && !html.includes(b.endpoint.token), "no token is ever shown in the UI");
  assert.match(help, /need[s]? local tool access/);
  if (shots) await page.screenshot({ path: join(shots, "5-add-recipe-help.png"), fullPage: true });
  const helpB = await (await fetch(`${b.url}api/info`)).json();
  assert.equal(helpB.agent.file, b.file);
  assert.deepEqual(helpB.agent.others.map((other) => other.file), [a.file]);
  steps.push("no New recipe button; each instance's help page shows its own endpoint file and cookbook, lists the other, and shows no token");

  // 2. Two assistants, each with one instance's file, reach only their instance.
  const beforeB = fingerprint(b.dataDir);
  const before = fingerprint(dataDir);
  const response = await submit(endpoint, draft);
  assert.equal(response.status, 202);
  const submitted = await response.json();
  assert.deepEqual(submitted.instance, { id: a.endpoint.instanceId, cookbook: a.dataDir });
  assert.deepEqual(submitted.unmatchedCategories, ["Holiday"]);
  const forB = { ...draft, recipe: { ...draft.recipe, title: "Only for B" } };
  const responseB = await submit(b.endpoint, forB);
  assert.equal(responseB.status, 202);
  assert.equal((await responseB.json()).instance.cookbook, b.dataDir);
  assert.equal((await submit(b.endpoint, forB, a.endpoint.instanceId)).status, 409, "a request naming the other instance is refused");
  const draftsA = (await api("api/drafts")).drafts.map((item) => item.content.title);
  const draftsB = (await (await fetch(`${b.url}api/drafts`)).json()).drafts.map((item) => item.content.title);
  assert.deepEqual(draftsA, ["Pflaumenstreusel"]);
  assert.deepEqual(draftsB, ["Only for B"]);
  assert.deepEqual(fingerprint(dataDir), before, "submitting wrote nothing");
  assert.deepEqual(fingerprint(b.dataDir), beforeB);
  steps.push(`assistant A -> 202 in ${a.endpoint.instanceId} only, assistant B -> 202 in ${b.endpoint.instanceId} only, wrong instance header -> 409; both cookbooks unchanged`);

  // 3. It shows up for review; cancelling keeps it and writes nothing, also with a photo added.
  await page.goto(`${base}#/`);
  const card = page.locator(".drafts li", { hasText: "Pflaumenstreusel" });
  await card.waitFor();
  assert.match(await card.textContent(), /E2E test assistant \(a local AI assistant\)/);
  await card.getByRole("link", { name: "Review and save" }).click();
  await page.waitForSelector(".editor-preview table.cfe");
  await page.locator('input[data-upload="recipe"]').setInputFiles({ name: "card.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.waitForSelector("figure.staged figcaption");
  const cancelledPhoto = (await page.locator("figure.staged img").getAttribute("src")).split("/").pop();
  assert.equal((await page.evaluate(async (p) => (await fetch(p)).status, `api/photos/${cancelledPhoto}`)), 200, "the unsaved photo is visible in the editor");
  assert.deepEqual(fingerprint(dataDir), before, "adding a photo during review writes nothing to the cookbook folder");
  await page.locator("#cancel-edit").click();
  await card.waitFor();
  await page.waitForFunction(async (p) => (await fetch(p)).status === 404, `api/photos/${cancelledPhoto}`);
  assert.deepEqual(fingerprint(dataDir), before);
  steps.push("draft listed with its source; a photo added during review stays out of the cookbook folder; Cancel discards it and keeps the draft");

  // 4. Everything is visible and editable before saving.
  await card.getByRole("link", { name: "Review and save" }).click();
  await page.waitForSelector(".editor-preview table.cfe");
  assert.equal(await page.locator("h1").first().textContent(), "Review new recipe");
  assert.match(await page.locator("#draft-banner").textContent(), /Nothing has been saved yet.*Transcribed from a handwritten card/s);
  const value = (name) => page.locator(`[name="${name}"]`).inputValue();
  assert.equal(await value("title"), "Pflaumenstreusel");
  assert.equal(await value("description"), "Plum sheet cake with crumbs.");
  assert.equal(await value("attribution"), "Aunt Example");
  assert.equal(await value("yield"), "1 tray");
  assert.equal(await value("sourceUrl"), "https://example.com/pflaumenstreusel");
  assert.equal(await value("notes"), "Use ripe plums.");
  assert.deepEqual(
    await Promise.all([0, 1, 2, 3].map(async (i) => [await value(`i.${i}.name`), await value(`i.${i}.quantity`), await value(`i.${i}.unit`), await value(`i.${i}.note`)])),
    [["Plums", "600", "g", "halved"], ["Sugar", "120", "g", ""], ["Flour", "150", "g", ""], ["Butter", "100", "g", "cold"]],
  );
  assert.equal(await value("p.0.1"), "40", "split portion amounts are editable");
  assert.equal(await value("p.1.2"), "80");
  assert.deepEqual([await value("s.2.text"), await value("s.2.durationMinutes"), await value("s.2.temperatureC"), await value("s.2.ovenMode")], ["Scatter crumbs over plums and bake", "35", "180", "fan"]);
  const chips = await page.locator('.input-chips[aria-label="Inputs of step 3"] li').allTextContents();
  assert.ok(chips.some((text) => /Result of step 1/.test(text)) && chips.some((text) => /Result of step 2/.test(text)), "connections between steps are shown");
  assert.equal(await page.locator('input[name="categories"][value="sweet"]').isChecked(), true);
  assert.equal(await page.locator('input[name="categories"][value="baking"]').isChecked(), true);
  assert.match(await page.locator("#unmatched-categories").textContent(), /Holiday/);
  const bakeCell = page.locator(".editor-preview table.cfe td", { hasText: "Scatter crumbs over plums and bake" });
  assert.equal(await bakeCell.getAttribute("rowspan"), "5", "the final step spans every ingredient row (sugar split in two)");
  assert.match(await page.locator("#review-summary").textContent(), /4 ingredients, 3 steps, categories: Sweet, Baking\. Preparation table is complete\. Nothing is stored/);
  steps.push("every field, amount, portion, step connection, category and the preparation table are shown and editable");

  // 5. Correct a few things; still nothing written.
  await page.locator('[name="title"]').fill("Pflaumenstreusel (Oma)");
  await page.locator('[name="i.1.quantity"]').fill("130");
  await page.locator('[name="i.1.quantity"]').press("Tab");
  await page.locator('[name="p.0.1"]').fill("50");
  await page.locator('[name="p.0.1"]').press("Tab");
  await page.locator('[name="notes"]').fill("Use ripe plums. Less sugar if very sweet.");
  await page.locator('input[name="categories"][value="baking"]').uncheck();
  await page.locator('input[name="categories"][value="weeknight"]').check();
  await page.locator('[name="s.2.temperatureC"]').fill("175");
  await page.waitForFunction(() => /Sweet, Weeknight\. Preparation table is complete/.test(document.querySelector("#review-summary")?.textContent ?? ""));
  await page.locator('input[data-upload="recipe"]').setInputFiles({ name: "cake.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.waitForSelector("figure.staged figcaption");
  const savedPhoto = (await page.locator("figure.staged img").getAttribute("src")).split("/").pop();
  assert.notEqual(savedPhoto, cancelledPhoto);
  assert.deepEqual(fingerprint(dataDir), before, "editing in review, including adding a photo, writes nothing");
  if (shots) await page.screenshot({ path: join(shots, "6-review-ai-draft.png"), fullPage: true });
  steps.push("edited title, amounts, a portion, notes, categories and temperature and added a photo; data folder still unchanged");

  // 6. Explicit save.
  await page.getByRole("button", { name: "Save reviewed recipe" }).click();
  await page.waitForFunction(() => /^#\/r\//.test(location.hash), null, { timeout: 10000 });
  const id = await page.evaluate(() => decodeURIComponent(location.hash.split("/")[2]));
  const doc = (await api(`api/recipes/${encodeURIComponent(id)}`)).recipe;
  const saved = doc.snapshots.find((snapshot) => snapshot.id === doc.current).content;
  assert.equal(doc.snapshots.length, 1);
  assert.equal(saved.title, "Pflaumenstreusel (Oma)");
  assert.equal(saved.notes, "Use ripe plums. Less sugar if very sweet.");
  assert.equal(saved.ingredients[1].quantity, 130);
  assert.deepEqual(saved.actions[0].inputs[1], { ingredient: "sugar", quantity: 50 });
  assert.equal(saved.actions[2].temperatureC, 175);
  assert.deepEqual(doc.categoryIds.slice().sort(), ["sweet", "weeknight"]);
  assert.deepEqual(saved.photos, [savedPhoto]);
  const after = fingerprint(dataDir);
  const added = Object.keys(after).filter((file) => !(file in before)).sort();
  assert.deepEqual(added, [`assets/${savedPhoto}`, `recipes/${id}.json`].sort(), "exactly the recipe file and its reviewed photo are new");
  assert.deepEqual(readFileSync(join(dataDir, "assets", savedPhoto)), PNG_1PX);
  assert.ok(Object.keys(before).every((file) => before[file] === after[file] || file === "categories.json"), "nothing else changed");
  assert.equal((await api("api/drafts")).drafts.some((item) => item.id === submitted.draftId), false, "the draft left the review area");
  steps.push(`saved ${id} with the reviewed values; only its recipe file and photo are new; draft removed from the review area`);
  assert.deepEqual(fingerprint(b.dataDir), beforeB, "the other cookbook is untouched");

  // 6b. A revision proposed by the assistant keeps the saved recipe's photo; the user promotes it.
  const read = await (await fetch(`${endpoint.url}recipes/${id}`, { headers: { Authorization: `Bearer ${endpoint.token}` } })).json();
  assert.deepEqual([read.recipe.photos, read.photoCount], [[], 1], "assistants see no photo ids, only a count");
  const revisionResponse = await submit(endpoint, { submittedBy: "E2E test assistant", recipeId: id, recipe: { ...read.recipe, notes: "Revision: add cinnamon to the crumbs." } });
  assert.equal(revisionResponse.status, 202);
  await page.goto(`${base}#/`);
  const revisionCard = page.locator(".drafts li", { hasText: "Pflaumenstreusel (Oma)" });
  await revisionCard.getByRole("link", { name: "Review and save" }).click();
  await page.waitForSelector("#draft-banner");
  assert.equal(await page.locator("h1").textContent(), "Review proposed revision");
  assert.equal(await page.locator("#draft-cookbook code").textContent(), a.dataDir, "the review names the cookbook it will be saved to");
  assert.match(await page.locator("#draft-banner").textContent(), /Cancel keeps the draft in the review area but discards photos you added here/);
  const kept = page.locator("figure", { has: page.locator(`img[src$="${savedPhoto}"]`) });
  assert.equal(await kept.locator("figcaption").textContent(), "Kept from the base entry");
  assert.equal(await kept.getByRole("button", { name: "Remove" }).count(), 1, "only the user can remove it");
  await page.locator('input[name="makeCurrent"]').check();
  await page.getByRole("button", { name: "Save reviewed recipe" }).click();
  await page.waitForFunction(() => location.hash.endsWith("/history"));
  const revised = (await api(`api/recipes/${encodeURIComponent(id)}`)).recipe;
  const currentContent = revised.snapshots.find((snapshot) => snapshot.id === revised.current).content;
  assert.equal(revised.snapshots.length, 2);
  assert.equal(currentContent.notes, "Revision: add cinnamon to the crumbs.");
  assert.deepEqual(currentContent.photos, [savedPhoto], "the promoted revision still has the photo");
  steps.push("assistant revision draft showed the base photo as kept, named the target cookbook, and after promotion the current recipe still has the photo");

  // 7. Stopping one instance removes only its own endpoint file; the other keeps working.
  await stop(a);
  assert.ok(!existsSync(a.file), "A removed its own file on shutdown");
  assert.deepEqual(JSON.parse(readFileSync(b.file, "utf8")), b.endpoint, "B's file is untouched");
  assert.equal((await submit(b.endpoint, { ...forB, recipe: { ...forB.recipe, title: "Still B" } })).status, 202);
  assert.equal((await (await fetch(`${b.url}api/drafts`)).json()).drafts.length, 2);
  assert.equal((await (await fetch(`${b.url}api/info`)).json()).agent.others.length, 0);
  await stop(b);
  assert.ok(!existsSync(b.file));
  steps.push("stopping A removed only A's file; B kept its file and token and accepted another draft; stopping B removed B's file");

  assert.deepEqual(problems, []);
  console.log(JSON.stringify({ ok: true, steps }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, steps, problems, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
  await Promise.all(instances.map(stop));
  rmSync(root, { recursive: true, force: true });
}
