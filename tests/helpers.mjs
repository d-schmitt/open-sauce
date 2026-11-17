import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const EXT = new URL("../.github/extensions/open-sauce/", import.meta.url);
export const SCRATCH = new URL("./.tmp/", import.meta.url).pathname;

/** Scratch folders live inside the project (tests/.tmp), never in the system temp dir. */
export function scratch(t, label = "case") {
  const dir = join(SCRATCH, `${label}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const ing = (id, name, quantity, unit = "g", note = "") => ({ id, name, quantity, unit, note });
export const step = (id, text, inputs, extra = {}) => ({ id, text, inputs, durationMinutes: null, temperatureC: null, ovenMode: "", ...extra });
export const I = (id, quantity) => (quantity === undefined ? { ingredient: id } : { ingredient: id, quantity });
export const A = (id) => ({ action: id });
export const content = (ingredients, actions, extra = {}) => ({
  title: "Test", description: "", attribution: "", sourceUrl: "", yield: "", notes: "", photos: [], ingredients, actions, ...extra,
});

/** A tiny valid 1x1 PNG. */
export const PNG_1PX = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082", "hex");
