import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cookbook, MAX_PHOTO_BYTES } from "../.github/extensions/open-sauce/store.mjs";
import { filterRecipes } from "../.github/extensions/open-sauce/model.mjs";
import { A, EXT, I, PNG_1PX, content, ing, scratch, step } from "./helpers.mjs";

const pancakes = () => content(
  [ing("i1", "Flour", 200), ing("i2", "Milk", 300, "ml"), ing("i3", "Egg", 2, "piece")],
  [step("a1", "Whisk", [I("i1"), I("i2"), I("i3")]), step("a2", "Fry", [A("a1")], { temperatureC: 180 })],
  { title: "Pancakes" },
);
const rejects = (promise, status) => assert.rejects(promise, (error) => error.status === status);

async function freshBook(t) {
  const book = Cookbook.open(join(scratch(t, "store"), "book"), { create: true });
  const { recipe } = await book.createRecipe({ content: pancakes(), categoryIds: ["sweet"] });
  return { book, recipe };
}

test("a new cookbook gets Sweet and Savory and refuses a non-empty foreign folder", (t) => {
  const dir = scratch(t, "init");
  const book = Cookbook.open(join(dir, "book"), { create: true });
  assert.deepEqual(book.readCategories().categories.map((category) => category.name), ["Sweet", "Savory"]);
  writeFileSync(join(dir, "other.txt"), "x");
  assert.throws(() => Cookbook.open(dir, { create: true }), /not empty/);
});

test("a revision does not move Current unless asked", async (t) => {
  const { book, recipe } = await freshBook(t);
  const changed = pancakes();
  changed.ingredients[1].quantity = 350;
  const { recipe: after, snapshotId } = await book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: changed });
  assert.equal(after.current, recipe.current);
  assert.equal(after.snapshots.length, 2);
  assert.equal(after.snapshots[1].parent, recipe.current);
  const promoted = await book.saveEntry(recipe.id, { expectedVersion: 2, parentId: snapshotId, kind: "revision", content: { ...changed, notes: "Rest 10 min" }, makeCurrent: true, expectedCurrent: recipe.current });
  assert.equal(promoted.recipe.current, promoted.snapshotId);
  // A revision identical to its parent is refused.
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 3, parentId: snapshotId, kind: "revision", content: changed }), 400);
});

test("an attempt keeps the actual amounts and the multiplier only as provenance", async (t) => {
  const { book, recipe } = await freshBook(t);
  const cooked = pancakes();
  cooked.ingredients = cooked.ingredients.map((item) => ({ ...item, quantity: item.quantity * 2 }));
  cooked.ingredients[2].quantity = 3; // only had three eggs
  cooked.actions[1].temperatureC = 170;
  const { recipe: doc, snapshotId } = await book.saveEntry(recipe.id, {
    expectedVersion: 1, parentId: recipe.current, kind: "attempt", content: cooked,
    attempt: { date: "2026-05-01", multiplier: 2, outcome: "Fluffy", rating: 4 },
  });
  const saved = JSON.parse(readFileSync(join(book.dir, "recipes", `${recipe.id}.json`), "utf8")).snapshots.find((snapshot) => snapshot.id === snapshotId);
  assert.deepEqual(saved.content.ingredients.map((item) => item.quantity), [400, 600, 3], "stored as cooked, not multiplied again");
  assert.equal(saved.attempt.multiplier, 2);
  assert.equal(saved.attempt.rating, 4);
  assert.equal(doc.current, recipe.current, "an attempt is not promoted by default");
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 2, parentId: recipe.current, kind: "attempt", content: cooked, attempt: { date: "2026-13-01" } }), 400);
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 2, parentId: recipe.current, kind: "attempt", content: cooked, attempt: { date: "2026-05-01", rating: 6 } }), 400);
});

test("moving Current back keeps all later history, and any snapshot can be a branch base", async (t) => {
  const { book, recipe } = await freshBook(t);
  const first = recipe.current;
  const v2 = pancakes(); v2.ingredients[0].quantity = 220;
  const { snapshotId: second } = await book.saveEntry(recipe.id, { expectedVersion: 1, parentId: first, kind: "revision", content: v2, makeCurrent: true, expectedCurrent: first });
  const v3 = structuredClone(v2); v3.notes = "Use butter";
  const { snapshotId: third } = await book.saveEntry(recipe.id, { expectedVersion: 2, parentId: second, kind: "revision", content: v3, makeCurrent: true, expectedCurrent: second });
  const { recipe: back } = await book.setCurrent(recipe.id, { expectedVersion: 3, snapshotId: first });
  assert.equal(back.current, first);
  assert.deepEqual(back.snapshots.map((snapshot) => snapshot.id), [first, second, third]);
  const branch = pancakes(); branch.ingredients[1].quantity = 250;
  const { recipe: branched, snapshotId: fourth } = await book.saveEntry(recipe.id, { expectedVersion: 4, parentId: first, kind: "revision", content: branch });
  assert.equal(branched.snapshots.find((snapshot) => snapshot.id === fourth).parent, first);
  assert.equal(branched.snapshots.filter((snapshot) => snapshot.parent === first).length, 2, "two branches from the first snapshot");
  assert.equal(branched.snapshots.find((snapshot) => snapshot.id === third).content.notes, "Use butter", "later snapshots are unchanged");
  await rejects(book.setCurrent(recipe.id, { expectedVersion: 5, snapshotId: "s_deadbeef00" }), 404);
});

test("promotion needs the Current the user saw; an old branch can still be promoted on purpose", async (t) => {
  const { book, recipe } = await freshBook(t);
  const first = recipe.current;
  const v2 = pancakes(); v2.ingredients[0].quantity = 220;
  const { snapshotId: second } = await book.saveEntry(recipe.id, { expectedVersion: 1, parentId: first, kind: "revision", content: v2, makeCurrent: true, expectedCurrent: first });
  const branch = pancakes(); branch.notes = "Branch from the original";
  // A refreshed version alone is not enough: the caller still believes `first` is Current.
  await assert.rejects(
    book.saveEntry(recipe.id, { expectedVersion: 2, parentId: first, kind: "revision", content: branch, makeCurrent: true, expectedCurrent: first }),
    (error) => error.status === 409 && error.details.currentChanged === true && error.details.current === second,
  );
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 2, parentId: first, kind: "revision", content: branch, makeCurrent: true }), 409);
  const unchanged = book.getRecipe(recipe.id);
  assert.equal(unchanged.current, second);
  assert.equal(unchanged.snapshots.length, 2, "nothing was written by the refused promotion");
  // Confirming against the Current actually seen promotes the old branch intentionally.
  const { recipe: promoted, snapshotId } = await book.saveEntry(recipe.id, { expectedVersion: 2, parentId: first, kind: "revision", content: branch, makeCurrent: true, expectedCurrent: second });
  assert.equal(promoted.current, snapshotId);
  assert.equal(promoted.snapshots.find((snapshot) => snapshot.id === snapshotId).parent, first);
  assert.ok(promoted.snapshots.some((snapshot) => snapshot.id === second), "the previous Current stays in history");
});

test("stale writes are rejected with 409 so two panels cannot silently overwrite", async (t) => {
  const { book, recipe } = await freshBook(t);
  const edit = pancakes(); edit.notes = "Panel A";
  await book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: edit });
  const other = pancakes(); other.notes = "Panel B";
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: other }), 409);
  await rejects(book.setCurrent(recipe.id, { expectedVersion: 1, snapshotId: recipe.current }), 409);
  await rejects(book.createCategory({ expectedVersion: 0, name: "Late" }), 409);
  assert.equal(book.getRecipe(recipe.id).snapshots.length, 2);
});

test("invalid diagrams are rejected with details instead of being saved", async (t) => {
  const { book, recipe } = await freshBook(t);
  const broken = pancakes(); broken.actions[1].inputs.push(I("i1"));
  await assert.rejects(book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: broken }),
    (error) => error.status === 422 && error.details.diagramErrors.some((item) => item.code === "over_allocated"));
});

test("deleting a category only removes the tag and never deletes recipes", async (t) => {
  const { book, recipe } = await freshBook(t);
  const { category: baking } = await book.createCategory({ expectedVersion: 1, name: "Baking" });
  await rejects(book.createCategory({ expectedVersion: 2, name: "baking" }), 400);
  await book.setRecipeCategories(recipe.id, { expectedVersion: 1, categoryIds: ["sweet", baking.id] });
  await book.renameCategory(baking.id, { expectedVersion: 2, name: "Oven" });
  assert.equal(book.readCategories().categories.find((item) => item.id === baking.id).name, "Oven");
  const { untagged } = await book.deleteCategory("sweet", { expectedVersion: 3 });
  assert.equal(untagged, 1);
  const doc = book.getRecipe(recipe.id);
  assert.deepEqual(doc.categoryIds, [baking.id]);
  assert.equal(doc.snapshots.length, 1);
  assert.equal(book.listRecipes().recipes.length, 1);
  assert.deepEqual(book.readCategories().categories.map((item) => item.name), ["Savory", "Oven"]);
});

test("category delete is a tombstone: ids are never reused and an interrupted delete is consistent and resumable", async (t) => {
  const { book, recipe } = await freshBook(t);
  const second = (await book.createRecipe({ content: pancakes(), categoryIds: ["sweet", "savory"] })).recipe;
  await book.setRecipeCategories(recipe.id, { expectedVersion: 1, categoryIds: ["sweet"] });
  const recipesDir = join(book.dir, "recipes");
  const before = Object.fromEntries([recipe.id, second.id].map((id) => [id, readFileSync(join(recipesDir, `${id}.json`), "utf8")]));

  // Interrupt the delete after the tombstone: recipe files cannot be replaced.
  chmodSync(recipesDir, 0o555);
  try { await assert.rejects(book.deleteCategory("sweet", { expectedVersion: 1 })); }
  finally { chmodSync(recipesDir, 0o755); }
  const categories = book.readCategories();
  assert.deepEqual(categories.categories.map((item) => item.id), ["savory"]);
  assert.deepEqual(categories.deleted.map((item) => [item.id, item.name]), [["sweet", "Sweet"]]);
  for (const id of [recipe.id, second.id]) assert.equal(readFileSync(join(recipesDir, `${id}.json`), "utf8"), before[id], "recipe files untouched");
  assert.equal(readdirSync(recipesDir).filter((name) => !name.endsWith(".json")).length, 0, "no temp files left");

  // The stale id already behaves as removed everywhere.
  assert.deepEqual(book.getRecipe(second.id).categoryIds, ["savory"]);
  assert.deepEqual(book.listRecipes().recipes.map((item) => item.categoryIds).sort(), [[], ["savory"]]);
  assert.equal(filterRecipes(book.listRecipes().recipes, { categoryIds: ["sweet"] }).length, 0);
  await rejects(book.setRecipeCategories(recipe.id, { expectedVersion: 2, categoryIds: ["sweet"] }), 409);
  await rejects(book.renameCategory("sweet", { expectedVersion: 2, name: "Sweets" }), 404);

  // Repeating the delete is idempotent and finishes the cleanup; no recipe or snapshot is lost.
  const { untagged } = await book.deleteCategory("sweet", { expectedVersion: 2 });
  assert.equal(untagged, 2);
  assert.ok(!readFileSync(join(recipesDir, `${second.id}.json`), "utf8").includes('"sweet"'));
  assert.equal((await book.deleteCategory("sweet", { expectedVersion: 2 })).untagged, 0);
  assert.equal(book.listRecipes().recipes.length, 2);
  assert.equal(book.getRecipe(recipe.id).snapshots.length, 1);

  // A new category with the same name gets a new id; the old one stays a tombstone.
  const { category } = await book.createCategory({ expectedVersion: 2, name: "Sweet" });
  assert.notEqual(category.id, "sweet");
  assert.equal(filterRecipes(book.listRecipes().recipes, { categoryIds: [category.id] }).length, 0);
});

test("photo validation: type, content sniffing and size; written before it can be referenced", async (t) => {
  const { book, recipe } = await freshBook(t);
  assert.throws(() => book.savePhoto(Buffer.from("GIF89a...."), "image/gif"), (error) => error.status === 415);
  assert.throws(() => book.savePhoto(Buffer.from("<svg></svg>"), "image/png"), (error) => error.status === 415);
  assert.throws(() => book.savePhoto(PNG_1PX, "image/jpeg"), (error) => error.status === 415);
  assert.throws(() => book.savePhoto(Buffer.concat([PNG_1PX, Buffer.alloc(MAX_PHOTO_BYTES)]), "image/png"), (error) => error.status === 413);
  const { id } = await book.savePhoto(PNG_1PX, "image/png");
  assert.match(id, /^[a-f0-9]{32}\.png$/);
  assert.ok(existsSync(join(book.dir, "assets", id)));
  assert.deepEqual(book.photo(id).bytes, PNG_1PX);
  const withPhoto = { ...pancakes(), photos: [id] };
  await book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: withPhoto });
  const missing = { ...pancakes(), photos: ["0123456789abcdef0123456789abcdef.png"] };
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 2, parentId: recipe.current, kind: "revision", content: missing }), 422);
  assert.throws(() => book.photo("../cookbook.json"), (error) => error.status === 404);
});

test("the demo cookbook opens and lists its recipes, including a branching history", (t) => {
  const dir = join(scratch(t, "demo"), "book");
  cpSync(new URL("examples/demo-cookbook/", EXT), dir, { recursive: true });
  const book = Cookbook.open(dir);
  const { recipes, problems } = book.listRecipes();
  assert.deepEqual(problems, []);
  assert.ok(recipes.length >= 3);
  const banana = book.getRecipe("banana-bread");
  const kinds = banana.snapshots.map((snapshot) => `${snapshot.kind}:${snapshot.parent ? banana.snapshots.findIndex((item) => item.id === snapshot.parent) : "-"}`);
  assert.deepEqual(kinds, ["revision:-", "revision:0", "attempt:0", "attempt:1"]);
  assert.equal(banana.current, banana.snapshots[3].id);
  assert.ok(readdirSync(join(dir, "assets")).length >= 2);
});

test("staged photos are published to assets/ only with a successful save; a failed recipe write removes them again", async (t) => {
  const { book, recipe } = await freshBook(t);
  const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
  const staged = new Map([[id, { bytes: PNG_1PX }]]);
  const withPhoto = { ...pancakes(), notes: "with photo", photos: [id] };
  // Stale version: nothing is published.
  await rejects(book.saveEntry(recipe.id, { expectedVersion: 99, parentId: recipe.current, kind: "revision", content: withPhoto }, { stagedPhotos: staged }), 409);
  assert.ok(!existsSync(join(book.dir, "assets", id)));
  // The recipe write fails after the photo was written: the photo is removed, the recipe unchanged.
  chmodSync(join(book.dir, "recipes"), 0o500);
  try {
    await assert.rejects(book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: withPhoto }, { stagedPhotos: staged }));
  } finally { chmodSync(join(book.dir, "recipes"), 0o700); }
  assert.ok(!existsSync(join(book.dir, "assets", id)), "no orphan photo after a failed save");
  assert.equal(book.getRecipe(recipe.id).version, 1);
  // Success: photo first, then the recipe that references it.
  const saved = await book.saveEntry(recipe.id, { expectedVersion: 1, parentId: recipe.current, kind: "revision", content: withPhoto }, { stagedPhotos: staged });
  assert.deepEqual(saved.publishedPhotos, [id]);
  assert.deepEqual(readFileSync(join(book.dir, "assets", id)), PNG_1PX);
  // Already published photos need no staging on later saves.
  const again = await book.saveEntry(recipe.id, { expectedVersion: 2, parentId: saved.snapshotId, kind: "attempt", content: withPhoto, attempt: { date: "2026-11-17", multiplier: 1, outcome: "", rating: null, photos: [id] } });
  assert.deepEqual(again.publishedPhotos, []);
});
