// Browser end-to-end check of the two-panel conflict flow (dev helper, not part of the app).
// Usage: OPEN_SAUCE_URL=<url printed by npm start> npm run -s e2e:conflict
// Run it only against a throwaway copy of the demo cookbook: it saves entries to banana-bread.
//
// Panel A starts a revision from the old snapshot #1 and ticks "Make this the current recipe".
// Panel B then sets #2 as current. A's save must fail with 409, recovery must keep A's parent,
// untick promotion and explain it, the next save must create a branch without touching Current,
// and only an explicit new tick in a fresh editor may promote A's branch.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const base = process.env.OPEN_SAUCE_URL;
if (!base) throw new Error("Set OPEN_SAUCE_URL.");
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const problems = [];
const panel = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && !/409/.test(message.text())) problems.push(`console: ${message.text()}`); });
  return page;
};
const recipe = (page) => page.evaluate(async () => (await (await fetch("api/recipes/banana-bread")).json()).recipe);
const number = (doc, id) => doc.snapshots.findIndex((snapshot) => snapshot.id === id) + 1;
const steps = [];

try {
  const a = await panel();
  const b = await panel();
  const start = await (async () => { await a.goto(`${base}#/`); return recipe(a); })();
  assert.equal(number(start, start.current), 4, "demo Current is #4");
  const [first, second] = start.snapshots.map((snapshot) => snapshot.id);

  await a.goto(`${base}#/r/banana-bread/edit/revision/${first}`);
  await a.waitForSelector(".editor-preview table.cfe");
  await a.getByLabel("Notes (optional)").fill("Branch from the first version, written in panel A.");
  await a.getByLabel("Make this the current recipe").check();
  assert.match(await a.locator("#branch-note").textContent(), /starts from .*#1.*not from the current recipe/s);
  steps.push("A: editor on #1, promotion ticked, branch note shown");

  await b.goto(`${base}#/r/banana-bread/history`);
  await b.locator(`.history-row[data-select="${second}"]`).click();
  await b.locator("#set-current").click();
  await b.locator(`.history-row[data-select="${second}"] .kind.current`).waitFor();
  steps.push("B: set #2 as current");

  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.locator(".notice.warning", { hasText: "changed in another window" }).waitFor();
  assert.equal(number(await recipe(a), (await recipe(a)).current), 2, "the rejected save did not move Current");
  steps.push("A: save rejected with 409, edits kept");

  await a.getByRole("button", { name: "Load the latest history and keep my edits" }).click();
  const info = a.locator(".notice.info");
  await info.waitFor();
  const infoText = await info.textContent();
  assert.match(infoText, /Another window changed the current recipe to .*#2/s);
  assert.match(infoText, /still based on .*#1.*separate branch/s);
  assert.match(infoText, /was unticked\. Tick it again only if/);
  assert.equal(await a.getByLabel("Make this the current recipe").isChecked(), false, "promotion was unticked");
  assert.equal(await a.getByLabel("Notes (optional)").inputValue(), "Branch from the first version, written in panel A.", "edits kept");
  steps.push("A: recovery kept parent #1 and edits, unticked promotion, explained the branch");

  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.waitForFunction(() => location.hash.endsWith("/history"), null, { timeout: 10000 });
  let doc = await recipe(a);
  const branch = doc.snapshots.at(-1);
  assert.equal(doc.snapshots.length, 5);
  assert.equal(branch.parent, first, "the new entry is a branch from #1");
  assert.equal(doc.current, second, "Current stays where panel B put it");
  steps.push("A: saved #5 as a branch from #1; Current still #2");

  await a.goto(`${base}#/r/banana-bread/edit/revision/${branch.id}`);
  await a.waitForSelector(".editor-preview table.cfe");
  await a.getByLabel("Notes (optional)").fill("Branch from the first version, tested and preferred.");
  await a.getByLabel("Make this the current recipe").check();
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await a.waitForFunction(() => location.hash.endsWith("/history"), null, { timeout: 10000 });
  doc = await recipe(a);
  assert.equal(doc.snapshots.length, 6);
  assert.equal(doc.snapshots.at(-1).parent, branch.id);
  assert.equal(doc.current, doc.snapshots.at(-1).id, "explicit promotion moved Current to the branch");
  assert.ok([first, second].every((id) => doc.snapshots.some((snapshot) => snapshot.id === id)), "older history kept");
  steps.push("A: explicit tick promoted the branch (#6 current); all earlier entries kept");
  assert.deepEqual(problems, []);
  console.log(JSON.stringify({ ok: true, steps }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, steps, problems, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
