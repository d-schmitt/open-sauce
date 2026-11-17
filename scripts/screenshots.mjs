// Headless screenshots of the running app (dev helper, not part of the app).
// Usage: OPEN_SAUCE_URL=<url printed by npm start> SCREENSHOT_DIR=<folder> npm run screenshots
// Needs the optional dev dependency playwright-core and a local Chrome (or CHROME_PATH).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.OPEN_SAUCE_URL;
const out = process.env.SCREENSHOT_DIR;
if (!base || !out) throw new Error("Set OPEN_SAUCE_URL and SCREENSHOT_DIR.");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
const problems = [];
page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));

async function shot(hash, file, ready, prepare, fullPage = true) {
  await page.goto(`${base}${hash}`);
  await page.waitForSelector(ready, { timeout: 10000 });
  if (prepare) await prepare();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, file), fullPage });
  console.log(`saved ${file}`);
}

await shot("#/", "1-browse.png", ".recipe-card");
const cards = await page.locator(".recipe-card").count();
await page.getByRole("button", { name: "Sweet", exact: true }).click();
await page.getByRole("button", { name: "Baking", exact: true }).click();
const matchAll = await page.locator(".recipe-card .card-title").allTextContents();
await page.getByRole("button", { name: "Sweet", exact: true }).click();
await page.getByRole("button", { name: "Baking", exact: true }).click();

await shot("#/r/apfelkuchen", "2-recipe-table-apfelkuchen.png", "table.cfe");
const rowspans = await page.locator("table.cfe td[rowspan]").evaluateAll((cells) => cells.map((cell) => Number(cell.getAttribute("rowspan"))));
await page.getByRole("button", { name: /^2\s*x$|^2x$|^2×$/ }).first().click().catch(() => {});
const scaledSugar = await page.locator("table.cfe tr").filter({ hasText: "Zucker" }).locator(".cfe-amount").allTextContents();
await page.getByRole("button", { name: /^1\s*x$|^1x$|^1×$/ }).first().click().catch(() => {});

await shot("#/r/banana-bread/history", "3-history-banana-bread.png", ".history-row");
const historyRows = await page.locator(".history-row").count();

await page.setViewportSize({ width: 1280, height: 1100 });
await shot("#/r/apfelkuchen/edit/attempt/s_a0000000001a", "4-editor-attempt-apfelkuchen.png", ".editor-preview table.cfe", null, false);

const multiplier = page.getByLabel("Multiplier", { exact: true });
await multiplier.fill("2");
await page.getByRole("button", { name: "Scale amounts below" }).click();
await page.getByRole("button", { name: "Scale amounts below" }).click();
const flourAfterScalingTwice = await page.locator(".ingredient-editor tbody tr").first().locator("input").nth(1).inputValue();

// End-to-end save through the UI: a revision must not move Current.
await page.goto(`${base}#/r/apfelkuchen/edit/revision/s_a0000000001a`);
await page.waitForSelector(".editor-preview table.cfe");
await page.getByLabel("Notes (optional)").fill("Lauwarm mit Sahne servieren. Auch kalt gut.");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForFunction(() => !location.hash.includes("/edit/"), null, { timeout: 10000 });
await page.goto(`${base}#/r/apfelkuchen/history`);
await page.waitForSelector(".history-row");
const savedHistoryRows = await page.locator(".history-row").count();
const currentStillFirst = await page.locator(".history-row", { hasText: "#1" }).locator(".kind.current").count();

const narrow = await browser.newPage({ viewport: { width: 420, height: 800 } });
await narrow.goto(`${base}#/r/apfelkuchen`);
await narrow.waitForSelector("table.cfe");
const scrolls = await narrow.locator(".cfe-scroll").evaluate((element) => element.scrollWidth > element.clientWidth);

console.log(JSON.stringify({ cards, matchAll, rowspans, scaledSugar, historyRows, flourAfterScalingTwice, savedHistoryRows, currentStillFirst, narrowTableScrolls: scrolls, problems }, null, 2));
await browser.close();
if (problems.length) process.exitCode = 1;
