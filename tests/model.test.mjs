import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  diffContent, filterRecipes, formatAmount, layoutTable, normalizeContent, parseMultiplier, scaleContent, tableHtml, validateDiagram,
} from "../.github/extensions/open-sauce/model.mjs";
import { A, EXT, I, content, ing, step } from "./helpers.mjs";

/** Every grid position is covered exactly once, and every row has its ingredient cell. */
function assertGrid(layout) {
  const width = layout.columnCount;
  const covered = layout.rows.map(() => new Array(width).fill(0));
  for (const row of layout.rows) {
    for (const cell of row) {
      for (let r = cell.row; r < cell.row + cell.rowspan; r += 1) {
        for (let c = cell.column; c < cell.column + cell.colspan; c += 1) covered[r][c] += 1;
      }
    }
  }
  for (const row of covered) assert.deepEqual(row, new Array(width).fill(1));
}
const actionCell = (layout, id) => layout.rows.flat().find((cell) => cell.kind === "action" && cell.actionId === id);
const leafNames = (layout) => layout.rows.map((row) => row.find((cell) => cell.kind === "ingredient").name);

const apfelkuchen = () => JSON.parse(readFileSync(new URL("examples/demo-cookbook/recipes/apfelkuchen.json", EXT), "utf8")).snapshots[0].content;

test("branch merge: dough and filling are parallel branches that merge later", () => {
  const layout = layoutTable(apfelkuchen());
  assert.equal(layout.ok, true);
  assertGrid(layout);
  // 9 leaves: 8 ingredients, sugar split into two portions.
  assert.equal(layout.rows.length, 9);
  assert.deepEqual(leafNames(layout), ["Mehl", "Butter", "Zucker", "Ei", "Salz", "Äpfel", "Zitronensaft", "Zucker", "Zimt"]);
  const merge = actionCell(layout, "a6");
  assert.equal(merge.rowspan, 9);
  assert.equal(actionCell(layout, "a3").rowspan, 5, "dough branch spans the five dough rows");
  assert.equal(actionCell(layout, "a5").row, 5);
  assert.equal(actionCell(layout, "a5").rowspan, 4, "filling branch spans the four filling rows");
  // Final action is the last column and carries oven data unchanged.
  const final = actionCell(layout, "a8");
  assert.equal(final.final, true);
  assert.equal(final.column, layout.columnCount - 1);
  assert.match(final.meta, /160 °C/);
  // The shorter filling branch is padded with a gap so the merge lines up.
  const gaps = layout.rows[5].filter((cell) => cell.kind === "gap");
  assert.ok(gaps.length >= 1);
});

test("split portions appear as separate rows with their own amounts", () => {
  const layout = layoutTable(apfelkuchen());
  const sugarRows = layout.rows.filter((row) => row.some((cell) => cell.kind === "ingredient" && cell.name === "Zucker"));
  assert.deepEqual(sugarRows.map((row) => row.find((cell) => cell.kind === "amount").text), ["20 g", "30 g"]);
  assert.ok(sugarRows.every((row) => row.find((cell) => cell.kind === "ingredient").portion));
  const html = tableHtml(layout);
  assert.match(html, /<table class="cfe">/);
  assert.match(html, /rowspan="9"/);
});

test("deep chain: each step gets its own column, final step last", () => {
  const actions = [step("a1", "one", [I("i1")])];
  for (let n = 2; n <= 12; n += 1) actions.push(step(`a${n}`, `step ${n}`, [A(`a${n - 1}`)]));
  const layout = layoutTable(content([ing("i1", "Water", 1, "l")], actions));
  assert.equal(layout.ok, true);
  assert.equal(layout.columnCount, 14);
  assert.equal(layout.rows.length, 1);
  assert.deepEqual(layout.rows[0].map((cell) => cell.column), [0, 1, ...Array.from({ length: 12 }, (_, index) => index + 2)]);
  assertGrid(layout);
});

test("layout is deterministic and never drops ingredients or steps", () => {
  const recipe = apfelkuchen();
  const first = JSON.stringify(layoutTable(recipe));
  assert.equal(JSON.stringify(layoutTable(structuredClone(recipe))), first);
  const layout = layoutTable(recipe);
  const actionIds = new Set(layout.rows.flat().filter((cell) => cell.kind === "action").map((cell) => cell.actionId));
  assert.deepEqual([...actionIds].sort(), recipe.actions.map((action) => action.id).sort());
  const ingredientIds = new Set(layout.rows.flat().filter((cell) => cell.kind === "ingredient").map((cell) => cell.ingredientId));
  assert.deepEqual([...ingredientIds].sort(), recipe.ingredients.map((item) => item.id).sort());
});

test("validation reports actionable errors instead of drawing a misleading table", () => {
  const codes = (recipe) => validateDiagram(normalizeContent(recipe)).errors.map((error) => error.code).sort();
  const two = [ing("i1", "Flour", 100), ing("i2", "Sugar", 50)];

  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1"), I("i2"), A("a2")]), step("a2", "bake", [A("a1")])])), ["cycle", "no_final"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1"), I("i2"), A("zz")])])), ["missing_input"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1"), I("i2", 30)]), step("a2", "top", [A("a1"), I("i2", 40)])])), ["over_allocated"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1"), I("i2", 30)])])), ["under_allocated"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1")]), step("a2", "other", [I("i2")])])), ["unreachable"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1"), I("i2")]), step("a2", "x", [A("a1")]), step("a3", "y", [A("a1")]), step("a4", "z", [A("a2"), A("a3")])])), ["consumed_twice"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1")])])), ["unused_ingredient"]);
  assert.deepEqual(codes(content(two, [step("a1", "mix", [I("i1"), I("i2")]), step("a2", "again", [A("a1"), I("i2")])])), ["over_allocated"]);

  const layout = layoutTable(normalizeContent(content(two, [step("a1", "mix", [I("i1")]), step("a2", "other", [I("i2")])])));
  assert.equal(layout.ok, false);
  assert.match(tableHtml(layout), /cannot be drawn yet/);
  assert.match(layout.errors[0].message, /do not lead to the final result/);
});

test("all demo recipes are valid in every snapshot", () => {
  const dir = new URL("examples/demo-cookbook/recipes/", EXT);
  for (const name of readdirSync(dir)) {
    const doc = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    for (const snapshot of doc.snapshots) assert.deepEqual(validateDiagram(normalizeContent(snapshot.content)).errors, [], `${name} ${snapshot.id}`);
  }
});

test("scaling multiplies quantities in list and table, never times or temperatures", () => {
  const recipe = apfelkuchen();
  const scaled = scaleContent(recipe, 1.5);
  assert.equal(scaled.ingredients.find((item) => item.id === "i4").quantity, 1.5);
  assert.equal(formatAmount(1.5, "piece"), "1.5", "no silent rounding of piece counts");
  assert.deepEqual(scaled.actions.map((action) => [action.durationMinutes, action.temperatureC, action.ovenMode]), recipe.actions.map((action) => [action.durationMinutes, action.temperatureC, action.ovenMode]));
  const layout = layoutTable(recipe, 1.5);
  const sugar = layout.rows.filter((row) => row.some((cell) => cell.name === "Zucker")).map((row) => row[0].text);
  assert.deepEqual(sugar, ["30 g", "45 g"], "portions scale consistently with the list");
  assert.equal(layout.rows[3][0].text, "1.5");
  assert.match(actionCell(layout, "a7").meta, /15 min · 180 °C/);
  assert.equal(recipe.ingredients[0].quantity, 250, "scaling does not mutate the stored recipe");
});

test("multiplier parsing rejects non-positive and non-finite values", () => {
  assert.equal(parseMultiplier("2x"), 2);
  assert.equal(parseMultiplier("0,5"), 0.5);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc", "", null, 1000]) assert.throws(() => parseMultiplier(bad), /multiplier/);
});

test("diff against the parent accounts for the attempt multiplier", () => {
  const parent = normalizeContent(content([ing("i1", "Flour", 100), ing("i2", "Egg", 1, "piece")], [step("a1", "bake", [I("i1"), I("i2")], { temperatureC: 180 })]));
  const child = structuredClone(parent);
  child.ingredients[0].quantity = 200;
  child.ingredients[1].quantity = 3;
  child.actions[0].temperatureC = 170;
  const diff = diffContent(parent, child, 2);
  assert.deepEqual(diff.ingredients.changed.map((change) => change.id), ["i2"], "200 g flour at 2x is not a change");
  assert.deepEqual(diff.oven, [{ id: "a1", text: "bake", field: "temperatureC", from: 180, to: 170 }]);
});

test("category filter always matches ALL selected categories", () => {
  const recipes = [
    { title: "Apfelkuchen", categoryIds: ["sweet", "baking"], ingredientNames: ["Äpfel"] },
    { title: "Pancakes", categoryIds: ["sweet"], ingredientNames: [] },
    { title: "Bread", categoryIds: ["baking", "savory"], ingredientNames: [] },
  ];
  assert.deepEqual(filterRecipes(recipes, { categoryIds: ["sweet", "baking"] }).map((recipe) => recipe.title), ["Apfelkuchen"]);
  assert.deepEqual(filterRecipes(recipes, { categoryIds: ["sweet"] }).map((recipe) => recipe.title), ["Apfelkuchen", "Pancakes"]);
  assert.deepEqual(filterRecipes(recipes, { categoryIds: ["sweet", "savory"] }), []);
  assert.deepEqual(filterRecipes(recipes, { query: "apfel" }).map((recipe) => recipe.title), ["Apfelkuchen"]);
  assert.deepEqual(filterRecipes(recipes, { query: "apfel", categoryIds: ["savory"] }), []);
});
