// Regenerates the synthetic demo cookbook in .github/extensions/open-sauce/examples/demo-cookbook.
// All recipes, people and photos are invented examples. Run: npm run demo:build
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { normalizeContent, validateDiagram } from "../.github/extensions/open-sauce/model.mjs";

const OUT = new URL("../.github/extensions/open-sauce/examples/demo-cookbook/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "recipes"), { recursive: true });
mkdirSync(join(OUT, "assets"), { recursive: true });
const write = (path, value) => writeFileSync(join(OUT, path), `${JSON.stringify(value, null, 2)}\n`);

// ---- tiny PNG painter (synthetic illustrations, no real photos) -------------
function png(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x / width, y / height);
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));
function plate(top, food, accent, stripes) {
  return (x, y) => {
    const dx = x - 0.5; const dy = (y - 0.55) * 1.33;
    const d = Math.hypot(dx, dy);
    if (d < 0.27) {
      if (stripes && Math.sin((dx + dy) * 60) > 0.55) return accent;
      return mix(food, accent, Math.max(0, (d - 0.18) / 0.09));
    }
    if (d < 0.34) return [246, 242, 236];
    if (d < 0.35) return [205, 196, 186];
    return mix(top, mix(top, [255, 255, 255], 0.25), y);
  };
}
const photos = {
  apfelkuchen: ["0a1fe7c5b3d24e6f8a9b0c1d2e3f4a5b.png", plate([142, 98, 66], [226, 182, 96], [180, 120, 50], true)],
  shepherd: ["1b2c3d4e5f60718293a4b5c6d7e8f901.png", plate([70, 92, 80], [236, 210, 150], [170, 110, 60], false)],
  banana: ["2c3d4e5f60718293a4b5c6d7e8f90a1b.png", plate([96, 120, 150], [170, 112, 60], [120, 72, 36], false)],
};
for (const [, [id, painter]] of Object.entries(photos)) writeFileSync(join(OUT, "assets", id), png(480, 360, painter));

// ---- recipes ----------------------------------------------------------------
const ing = (id, name, quantity, unit, note = "") => ({ id, name, quantity, unit, note });
const step = (id, text, inputs, extra = {}) => ({ id, text, inputs, durationMinutes: null, temperatureC: null, ovenMode: "", ...extra });
const I = (id, quantity) => (quantity === undefined ? { ingredient: id } : { ingredient: id, quantity });
const A = (id) => ({ action: id });
const base = { description: "", attribution: "", sourceUrl: "", yield: "", notes: "", photos: [] };

function checked(content) {
  const normalized = normalizeContent(content);
  const { errors } = validateDiagram(normalized);
  if (errors.length) throw new Error(`${content.title}: ${errors.map((error) => error.message).join("; ")}`);
  return normalized;
}
function recipe(id, categoryIds, snapshots, current) {
  const doc = {
    format: "open-sauce-recipe", schemaVersion: 1, id, version: 1, categoryIds,
    current: current ?? snapshots.at(-1).id, createdAt: snapshots[0].createdAt, updatedAt: snapshots.at(-1).createdAt,
    snapshots: snapshots.map((snapshot) => ({ attempt: null, ...snapshot, content: checked(snapshot.content) })),
  };
  write(`recipes/${id}.json`, doc);
}

const apfelkuchen = {
  ...base,
  title: "Apfelkuchen",
  description: "Gedeckter Mürbeteig-Boden mit saftiger Apfelfüllung. Zwei Backstufen: erst heiß für den Boden, dann sanft fertig backen.",
  attribution: "Oma Hilde (synthetisches Beispiel)",
  yield: "1 Springform (26 cm)",
  ingredients: [
    ing("i1", "Mehl", 250, "g", "Type 405"),
    ing("i2", "Butter", 125, "g", "kalt, in Würfeln"),
    ing("i3", "Zucker", 50, "g"),
    ing("i4", "Ei", 1, "piece"),
    ing("i5", "Salz", 1, "pinch"),
    ing("i6", "Äpfel", 1, "kg", "säuerlich, z. B. Boskoop"),
    ing("i7", "Zitronensaft", 2, "tbsp"),
    ing("i8", "Zimt", 1, "tsp"),
  ],
  actions: [
    step("a1", "Mehl, Butter, Zucker, Ei und Salz rasch zu einem Mürbeteig verkneten", [I("i1"), I("i2"), I("i3", 20), I("i4"), I("i5")]),
    step("a2", "In Folie kalt stellen", [A("a1")], { durationMinutes: 30 }),
    step("a3", "Springform auslegen, Rand 3 cm hochziehen", [A("a2")]),
    step("a4", "Äpfel schälen, entkernen, in Spalten schneiden", [I("i6")]),
    step("a5", "Mit Zitronensaft, Zucker und Zimt mischen", [A("a4"), I("i7"), I("i3", 30), I("i8")]),
    step("a6", "Füllung auf dem Boden verteilen", [A("a3"), A("a5")]),
    step("a7", "Backen (untere Schiene)", [A("a6")], { durationMinutes: 15, temperatureC: 180, ovenMode: "top-bottom" }),
    step("a8", "Temperatur reduzieren und fertig backen", [A("a7")], { durationMinutes: 35, temperatureC: 160, ovenMode: "top-bottom" }),
  ],
  notes: "Lauwarm mit Sahne servieren.",
  photos: [photos.apfelkuchen[0]],
};
recipe("apfelkuchen", ["sweet", "baking"], [
  { id: "s_a0000000001a", parent: null, kind: "revision", createdAt: "2026-02-14T10:00:00.000Z", message: "Created recipe", content: apfelkuchen },
]);

const shepherd = {
  ...base,
  title: "Shepherd's Pie",
  description: "Lamb and vegetable filling under a buttery mash, baked until golden. Two branches (mash and filling) meet in the dish.",
  attribution: "Uncle Tom (synthetic example)",
  sourceUrl: "https://example.com/synthetic/shepherds-pie",
  yield: "4 servings",
  ingredients: [
    ing("i1", "Floury potatoes", 1, "kg"),
    ing("i2", "Salt", 2, "tsp"),
    ing("i3", "Butter", 50, "g"),
    ing("i4", "Milk", 100, "ml", "warm"),
    ing("i5", "Onion", 1, "piece"),
    ing("i6", "Carrots", 2, "piece"),
    ing("i7", "Olive oil", 2, "tbsp"),
    ing("i8", "Lamb mince", 500, "g"),
    ing("i9", "Tomato paste", 1, "tbsp"),
    ing("i10", "Beef stock", 250, "ml"),
    ing("i11", "Worcestershire sauce", 1, "tbsp"),
    ing("i12", "Dried thyme", 1, "tsp"),
  ],
  actions: [
    step("a1", "Peel and quarter the potatoes", [I("i1")]),
    step("a2", "Boil in salted water until tender", [A("a1"), I("i2", 1)], { durationMinutes: 20 }),
    step("a3", "Drain and mash with butter and milk", [A("a2"), I("i3"), I("i4")]),
    step("a4", "Dice onion and carrots", [I("i5"), I("i6")]),
    step("a5", "Soften in the oil", [A("a4"), I("i7")], { durationMinutes: 8 }),
    step("a6", "Add the mince and brown it", [A("a5"), I("i8")], { durationMinutes: 8 }),
    step("a7", "Stir in tomato paste, stock, Worcestershire, thyme and salt; simmer", [A("a6"), I("i9"), I("i10"), I("i11"), I("i12"), I("i2", 1)], { durationMinutes: 20 }),
    step("a8", "Spread the filling in a baking dish and top with the mash", [A("a7"), A("a3")]),
    step("a9", "Bake until golden", [A("a8")], { durationMinutes: 25, temperatureC: 200, ovenMode: "fan" }),
  ],
  photos: [photos.shepherd[0]],
};
recipe("shepherds-pie", ["savory", "weeknight"], [
  { id: "s_b0000000001b", parent: null, kind: "revision", createdAt: "2026-01-20T18:00:00.000Z", message: "Created recipe", content: shepherd },
]);

const kartoffelsalat = {
  ...base,
  title: "Schwäbischer Kartoffelsalat",
  description: "Mit warmer Brühe angemacht, ohne Mayonnaise.",
  attribution: "Tante Erika (synthetisches Beispiel)",
  yield: "4 Portionen",
  ingredients: [
    ing("i1", "Festkochende Kartoffeln", 1, "kg"),
    ing("i2", "Zwiebel", 1, "piece"),
    ing("i3", "Gemüsebrühe", 200, "ml"),
    ing("i4", "Weißweinessig", 4, "tbsp"),
    ing("i5", "Sonnenblumenöl", 4, "tbsp"),
    ing("i6", "Salz und Pfeffer", null, "", "nach Geschmack"),
    ing("i7", "Schnittlauch", 1, "bunch"),
  ],
  actions: [
    step("a1", "Kartoffeln mit Schale kochen", [I("i1")], { durationMinutes: 25 }),
    step("a2", "Pellen und in dünne Scheiben schneiden", [A("a1")]),
    step("a3", "Zwiebel fein würfeln", [I("i2")]),
    step("a4", "Mit Brühe und Essig aufkochen", [A("a3"), I("i3"), I("i4")]),
    step("a5", "Heiß über die Kartoffeln gießen, ziehen lassen", [A("a2"), A("a4")], { durationMinutes: 30 }),
    step("a6", "Öl unterheben, abschmecken, Schnittlauch darüber", [A("a5"), I("i5"), I("i6"), I("i7")]),
  ],
};
recipe("kartoffelsalat", ["savory"], [
  { id: "s_c0000000001c", parent: null, kind: "revision", createdAt: "2026-03-05T12:00:00.000Z", message: "Created recipe", content: kartoffelsalat },
]);

// Banana bread: branching history.
//   #1 created -> #2 revision "less sugar, walnuts" (untested, not current)
//   #1 -> #3 cooking attempt at 2x (not promoted)
//   #2 -> #4 cooking attempt (promoted to Current)
const banana1 = {
  ...base,
  title: "Weekday Banana Bread",
  description: "A forgiving loaf for very ripe bananas.",
  attribution: "Cousin Sam (synthetic example)",
  yield: "1 loaf (25 cm tin)",
  ingredients: [
    ing("i1", "Very ripe bananas", 3, "piece"),
    ing("i2", "Butter", 100, "g", "melted"),
    ing("i3", "Brown sugar", 150, "g"),
    ing("i4", "Egg", 1, "piece"),
    ing("i5", "Plain flour", 250, "g"),
    ing("i6", "Baking soda", 1, "tsp"),
    ing("i7", "Salt", 1, "pinch"),
  ],
  actions: [
    step("a1", "Mash the bananas", [I("i1")]),
    step("a2", "Stir in melted butter, sugar and egg", [A("a1"), I("i2"), I("i3"), I("i4")]),
    step("a3", "Whisk flour, baking soda and salt", [I("i5"), I("i6"), I("i7")]),
    step("a4", "Fold the dry mix into the wet mix", [A("a2"), A("a3")]),
    step("a5", "Pour into a lined loaf tin and bake", [A("a4")], { durationMinutes: 60, temperatureC: 175, ovenMode: "top-bottom" }),
  ],
};
const banana2 = {
  ...banana1,
  ingredients: [...banana1.ingredients.map((item) => (item.id === "i3" ? { ...item, quantity: 100 } : item)), ing("i8", "Walnuts", 80, "g", "roughly chopped")],
  actions: banana1.actions.map((action) => (action.id === "a4" ? { ...action, text: "Fold the dry mix and walnuts into the wet mix", inputs: [A("a2"), A("a3"), I("i8")] } : action)),
};
const banana3 = {
  ...banana1,
  ingredients: banana1.ingredients.map((item) => ({ ...item, quantity: item.id === "i1" ? 5 : item.quantity * 2 })),
  actions: banana1.actions.map((action) => (action.id === "a5" ? { ...action, text: "Pour into two lined loaf tins and bake", temperatureC: 165, durationMinutes: 55, ovenMode: "fan" } : action)),
};
const banana4 = {
  ...banana2,
  ingredients: banana2.ingredients.map((item) => (item.id === "i8" ? { ...item, note: "toasted, roughly chopped" } : item)),
  actions: banana2.actions.map((action) => (action.id === "a5" ? { ...action, temperatureC: 170, durationMinutes: 55 } : action)),
  notes: "Toast the walnuts in a dry pan first. 170 °C works better in our oven.",
};
recipe("banana-bread", ["sweet", "baking"], [
  { id: "s_d0000000001d", parent: null, kind: "revision", createdAt: "2026-03-01T09:00:00.000Z", message: "Created recipe", content: banana1 },
  { id: "s_d0000000002d", parent: "s_d0000000001d", kind: "revision", createdAt: "2026-04-02T19:30:00.000Z", message: "Less sugar, add walnuts", content: banana2 },
  {
    id: "s_d0000000003d", parent: "s_d0000000001d", kind: "attempt", createdAt: "2026-04-12T16:00:00.000Z", message: "Double batch for the school fair", content: banana3,
    attempt: { date: "2026-04-12", multiplier: 2, outcome: "Only had 5 bananas. Fan at 165 °C browned the top too fast.", rating: 3, photos: [] },
  },
  {
    id: "s_d0000000004d", parent: "s_d0000000002d", kind: "attempt", createdAt: "2026-05-10T15:00:00.000Z", message: "Sunday baking", content: banana4,
    attempt: { date: "2026-05-10", multiplier: 1, outcome: "Best version so far. Moist, not too sweet.", rating: 5, photos: [photos.banana[0]] },
  },
], "s_d0000000004d");

write("categories.json", {
  format: "open-sauce-categories", version: 1,
  categories: [{ id: "sweet", name: "Sweet" }, { id: "savory", name: "Savory" }, { id: "baking", name: "Baking" }, { id: "weeknight", name: "Weeknight" }],
});
writeFileSync(join(OUT, ".gitignore"), ".open-sauce.lock*\n.*.tmp\n");
write("cookbook.json", { format: "open-sauce-cookbook", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", demo: true });
console.log(`Demo cookbook written to ${OUT}`);
