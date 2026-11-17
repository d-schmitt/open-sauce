import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  APP_NAME, InputError, PHOTO_ID, RECIPE_ID, SNAPSHOT_ID, diffContent, normalizeAttempt, normalizeContent, text, validateDiagram,
} from "./model.mjs";
import { writeFileAtomic } from "./fsutil.mjs";
import { FileLock } from "./lock.mjs";

export const COOKBOOK_FORMAT = "open-sauce-cookbook";
export const RECIPE_FORMAT = "open-sauce-recipe";
export const LOCK_FILE = ".open-sauce.lock";
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CATEGORIES = [{ id: "sweet", name: "Sweet" }, { id: "savory", name: "Savory" }];
const IGNORABLE = new Set([".git", ".gitignore", ".gitattributes", "README.md", ".DS_Store", LOCK_FILE, `${LOCK_FILE}.recover`]);
const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Validates a photo by content (not only the declared type) and size. Returns the file extension. */
export function checkPhoto(bytes, declaredType) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(declaredType)) throw new InputError("Photos must be PNG, JPEG or WebP images.", 415);
  if (!bytes.length) throw new InputError("The photo is empty.");
  if (bytes.length > MAX_PHOTO_BYTES) throw new InputError(`Photos can be at most ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`, 413);
  const actual = sniffImage(bytes);
  if (!actual) throw new InputError("This file is not a valid PNG, JPEG or WebP image.", 415);
  if (actual !== declaredType) throw new InputError("The photo content does not match its file type.", 415);
  return EXTENSION[actual];
}

export const newPhotoId = (extension) => `${hex(16)}.${extension}`;

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();
const hex = (bytes) => randomBytes(bytes).toString("hex");
const slug = (title) => title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "recipe";

/**
 * A cookbook folder: cookbook.json, categories.json, recipes/<id>.json and
 * assets/<photo>. Every read goes to disk, so several processes (the standalone
 * app and Copilot canvases) can share one folder; mutations hold a lock file.
 */
export class Cookbook {
  #lock;
  #held = null;

  constructor(dir, { lockTimeoutMs = 5000 } = {}) {
    this.dir = dir;
    this.#lock = new FileLock(join(dir, LOCK_FILE), { timeoutMs: lockTimeoutMs });
    this.lastSavedAt = null;
  }

  static open(dir, { create = false, ...options } = {}) {
    if (!existsSync(dir)) {
      if (!create) throw new InputError(`The cookbook folder ${dir} does not exist.`, 404);
      mkdirSync(dir, { recursive: true });
    }
    if (!statSync(dir).isDirectory()) throw new InputError(`${dir} is not a folder.`);
    const marker = join(dir, "cookbook.json");
    if (!existsSync(marker)) {
      const unexpected = readdirSync(dir).filter((name) => !IGNORABLE.has(name));
      if (unexpected.length) throw new InputError(`${dir} is not empty and is not a ${APP_NAME} cookbook. Choose an empty folder or an existing cookbook.`);
      if (!create) throw new InputError(`${dir} is not a ${APP_NAME} cookbook yet.`, 404);
      Cookbook.initialize(dir);
    }
    const meta = JSON.parse(readFileSync(marker, "utf8"));
    if (meta.format !== COOKBOOK_FORMAT || meta.schemaVersion !== 1) throw new InputError(`${dir} contains an unsupported cookbook format.`);
    return new Cookbook(dir, options);
  }

  static initialize(dir) {
    mkdirSync(join(dir, "recipes"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileAtomic(join(dir, "categories.json"), json({ format: "open-sauce-categories", version: 1, categories: DEFAULT_CATEGORIES }));
    if (!existsSync(join(dir, ".gitignore"))) writeFileAtomic(join(dir, ".gitignore"), `${LOCK_FILE}*\n.*.tmp\n`);
    writeFileAtomic(join(dir, "cookbook.json"), json({ format: COOKBOOK_FORMAT, schemaVersion: 1, createdAt: now() }));
  }

  // ---- locking -------------------------------------------------------------
  // The protocol lives in lock.mjs. Every write below first checks that this
  // instance still holds the lock, so a lock removed by hand mid-operation
  // stops further writes instead of racing another process.

  async withLock(fn) {
    const handle = await this.#lock.acquire();
    this.#held = handle;
    try {
      return await fn();
    } finally {
      this.#held = null;
      if (!this.#lock.release(handle)) console.warn(`${APP_NAME}: the lock ${this.#lock.path} was replaced by another owner during an operation; it was left in place.`);
    }
  }

  assertLockHeld() {
    if (!this.#lock.isHeld(this.#held)) {
      throw new InputError(`The cookbook lock was removed or taken over while saving, so ${APP_NAME} stopped before writing. Nothing more was changed; reload and try again.`, 423);
    }
  }

  // ---- categories ----------------------------------------------------------

  readCategories() {
    const data = JSON.parse(readFileSync(join(this.dir, "categories.json"), "utf8"));
    if (!Number.isInteger(data.version) || !Array.isArray(data.categories) || (data.deleted !== undefined && !Array.isArray(data.deleted))) {
      throw new Error("categories.json is malformed.");
    }
    data.deleted ??= [];
    return data;
  }

  #checkVersion(actual, expected, what) {
    if (expected !== actual) {
      throw new InputError(`${what} changed in another window or session since you opened it. Reload to see the latest version; nothing was overwritten.`, 409, { currentVersion: actual });
    }
  }

  #categoryName(name, categories, exceptId) {
    name = text(name, "Category name", 40, true);
    if (categories.some((category) => category.id !== exceptId && category.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new InputError(`A category called "${name}" already exists.`);
    }
    return name;
  }

  createCategory({ expectedVersion, name }) {
    return this.withLock(() => {
      const data = this.readCategories();
      this.#checkVersion(data.version, expectedVersion, "The category list");
      if (data.categories.length >= 200) throw new InputError("A cookbook can have at most 200 categories.");
      const taken = new Set([...data.categories, ...data.deleted].map((item) => item.id));
      let id;
      do id = `c_${hex(5)}`; while (taken.has(id)); // tombstoned ids are never reused
      const category = { id, name: this.#categoryName(name, data.categories) };
      data.categories.push(category);
      data.version += 1;
      this.#write("categories.json", data);
      return { category, categories: data };
    });
  }

  renameCategory(id, { expectedVersion, name }) {
    return this.withLock(() => {
      const data = this.readCategories();
      this.#checkVersion(data.version, expectedVersion, "The category list");
      const category = data.categories.find((item) => item.id === id);
      if (!category) throw new InputError("That category no longer exists.", 404);
      category.name = this.#categoryName(name, data.categories, id);
      data.version += 1;
      this.#write("categories.json", data);
      return { categories: data };
    });
  }

  /**
   * Tombstone design: the category moves to `deleted` in categories.json first
   * (one atomic write, id never reused), then each recipe is untagged with its
   * own atomic write. Every reader ignores tombstoned ids, so an interruption
   * between those writes (crash, full disk, permissions) can only leave a stale
   * id in a recipe file that behaves as already removed. Repeating the delete
   * is idempotent and finishes the cleanup. Recipes themselves are never deleted.
   */
  deleteCategory(id, { expectedVersion }) {
    return this.withLock(() => {
      const data = this.readCategories();
      const category = data.categories.find((item) => item.id === id);
      if (category) {
        this.#checkVersion(data.version, expectedVersion, "The category list");
        data.categories = data.categories.filter((item) => item.id !== id);
        data.deleted.push({ id, name: category.name, deletedAt: now() });
        data.version += 1;
        this.#write("categories.json", data);
      } else if (!data.deleted.some((item) => item.id === id)) {
        throw new InputError("That category no longer exists.", 404);
      }
      return { categories: data, untagged: this.#purgeDeletedTags(data) };
    });
  }

  /** Removes every tombstoned id still present in recipe files. Returns the number of recipes changed. */
  #purgeDeletedTags(data) {
    const deleted = new Set(data.deleted.map((item) => item.id));
    let untagged = 0;
    for (const { doc } of this.#readAll()) {
      if (!doc || !doc.categoryIds.some((item) => deleted.has(item))) continue;
      doc.categoryIds = doc.categoryIds.filter((item) => !deleted.has(item));
      doc.version += 1;
      doc.updatedAt = now();
      this.#write(`recipes/${doc.id}.json`, doc);
      untagged += 1;
    }
    return untagged;
  }

  // ---- recipes -------------------------------------------------------------

  #readAll() {
    const dir = join(this.dir, "recipes");
    const results = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json") || !RECIPE_ID.test(name.slice(0, -5))) continue;
      try { results.push({ doc: this.#parseRecipe(readFileSync(join(dir, name), "utf8"), name.slice(0, -5)) }); }
      catch (error) { results.push({ problem: { file: `recipes/${name}`, message: error.message } }); }
    }
    return results.filter((item) => item.doc).concat(results.filter((item) => item.problem));
  }

  #parseRecipe(raw, id) {
    const doc = JSON.parse(raw);
    if (doc.format !== RECIPE_FORMAT || doc.id !== id || !Number.isInteger(doc.version) || !Array.isArray(doc.snapshots) ||
        !Array.isArray(doc.categoryIds) || !doc.snapshots.some((snapshot) => snapshot.id === doc.current)) {
      throw new Error("This recipe file is malformed. Fix or restore it from a backup; it was not changed.");
    }
    return doc;
  }

  getRecipe(id) {
    if (typeof id !== "string" || !RECIPE_ID.test(id)) throw new InputError("Unknown recipe.", 404);
    let raw;
    try { raw = readFileSync(join(this.dir, "recipes", `${id}.json`), "utf8"); }
    catch (error) { if (error.code === "ENOENT") throw new InputError("That recipe does not exist.", 404); throw error; }
    const doc = this.#parseRecipe(raw, id);
    const deleted = new Set(this.readCategories().deleted.map((item) => item.id));
    doc.categoryIds = doc.categoryIds.filter((item) => !deleted.has(item));
    return doc;
  }

  listRecipes() {
    const known = new Set(this.readCategories().categories.map((category) => category.id));
    const recipes = [];
    const problems = [];
    for (const item of this.#readAll()) {
      if (item.problem) { problems.push(item.problem); continue; }
      const { doc } = item;
      const current = doc.snapshots.find((snapshot) => snapshot.id === doc.current);
      const attemptPhoto = [...doc.snapshots].reverse().find((snapshot) => snapshot.attempt?.photos?.length)?.attempt.photos[0];
      recipes.push({
        id: doc.id,
        version: doc.version,
        title: current.content.title,
        description: current.content.description,
        attribution: current.content.attribution,
        ingredientNames: current.content.ingredients.map((ingredient) => ingredient.name),
        categoryIds: doc.categoryIds.filter((categoryId) => known.has(categoryId)),
        photo: current.content.photos[0] ?? attemptPhoto ?? null,
        currentId: doc.current,
        snapshotCount: doc.snapshots.length,
        updatedAt: doc.updatedAt,
      });
    }
    recipes.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
    return { recipes, problems };
  }

  #validatedContent(input) {
    const content = normalizeContent(input);
    const { errors } = validateDiagram(content);
    if (errors.length) throw new InputError("The preparation steps need attention before saving.", 422, { diagramErrors: errors });
    return content;
  }

  /**
   * Photos added while reviewing live only in the app's memory (staged), never in the
   * cookbook folder, so Sync cannot pick up a photo of a recipe that was never saved.
   * On Save, under the lock, staged photos are written durably to assets/ first and the
   * recipe second. If the recipe write fails, the photos written by this call are removed
   * again (no recipe references them, and their ids are new). Returns the published ids.
   */
  #publishPhotos(ids, staged) {
    const missing = [...new Set(ids)].filter((id) => !existsSync(join(this.dir, "assets", id)));
    for (const id of missing) {
      if (!staged?.has(id)) throw new InputError("A photo of this entry is no longer available (the app was restarted or the photo expired). Remove it and add it again, then save.", 422);
    }
    const written = [];
    try {
      if (missing.length) mkdirSync(join(this.dir, "assets"), { recursive: true });
      for (const id of missing) {
        this.assertLockHeld();
        writeFileAtomic(join(this.dir, "assets", id), staged.get(id).bytes);
        written.push(id);
      }
    } catch (error) {
      this.#unpublish(written);
      throw error;
    }
    return written;
  }

  #unpublish(ids) {
    for (const id of ids) {
      try { rmSync(join(this.dir, "assets", id), { force: true }); }
      catch (error) { console.warn(`${APP_NAME}: could not remove unreferenced photo assets/${id} after a failed save: ${error.message}`); }
    }
  }

  /** Writes photos then the recipe; on a failed recipe write the just-published photos are removed. */
  #writeWithPhotos(relativePath, doc, photoIds, staged) {
    const published = this.#publishPhotos(photoIds, staged);
    try {
      this.#write(relativePath, doc);
    } catch (error) {
      this.#unpublish(published);
      throw error;
    }
    return published;
  }

  #categoryIds(input) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 50) throw new InputError("Categories must be a list.");
    const known = new Set(this.readCategories().categories.map((category) => category.id));
    for (const id of input) if (!known.has(id)) throw new InputError("One of the chosen categories no longer exists. Reload and try again.", 409);
    return [...new Set(input)];
  }

  createRecipe({ content, categoryIds, message }, { stagedPhotos } = {}) {
    return this.withLock(() => {
      const normalized = this.#validatedContent(content);
      const ids = this.#categoryIds(categoryIds);
      let id;
      do id = `${slug(normalized.title)}-${hex(3)}`; while (existsSync(join(this.dir, "recipes", `${id}.json`)));
      const snapshot = { id: `s_${hex(6)}`, parent: null, kind: "revision", createdAt: now(), message: text(message, "Message", 300) || "Created recipe", content: normalized, attempt: null };
      const doc = { format: RECIPE_FORMAT, schemaVersion: 1, id, version: 1, categoryIds: ids, current: snapshot.id, createdAt: snapshot.createdAt, updatedAt: snapshot.createdAt, snapshots: [snapshot] };
      const publishedPhotos = this.#writeWithPhotos(`recipes/${id}.json`, doc, normalized.photos, stagedPhotos);
      return { recipe: doc, snapshotId: snapshot.id, publishedPhotos };
    });
  }

  /**
   * Appends an immutable snapshot based on any earlier snapshot (branching).
   * Current only moves when makeCurrent is true.
   */
  /**
   * Appends a snapshot. Promotion (makeCurrent) must also name the Current the caller saw
   * (expectedCurrent): a client that refreshed its version after a conflict cannot move a
   * Current that another window set in the meantime without the user seeing it first.
   */
  saveEntry(recipeId, { expectedVersion, parentId, kind, content, attempt, makeCurrent = false, expectedCurrent, message }, { stagedPhotos } = {}) {
    return this.withLock(() => {
      const doc = this.getRecipe(recipeId);
      this.#checkVersion(doc.version, expectedVersion, "This recipe");
      if (makeCurrent === true && expectedCurrent !== doc.current) {
        throw new InputError("The current recipe changed since you chose to make this entry current. Review the new current recipe and confirm again.", 409, { currentChanged: true, current: doc.current, currentVersion: doc.version });
      }
      const parent = doc.snapshots.find((snapshot) => snapshot.id === parentId);
      if (!parent) throw new InputError("The entry you started from no longer exists.", 404);
      if (!["revision", "attempt"].includes(kind)) throw new InputError("Choose whether this is a revision or a cooking attempt.");
      if (typeof makeCurrent !== "boolean") throw new InputError("makeCurrent must be true or false.");
      const normalized = this.#validatedContent(content);
      let details = null;
      if (kind === "attempt") {
        details = normalizeAttempt(attempt);
      } else {
        if (attempt !== undefined && attempt !== null) throw new InputError("A revision cannot carry cooking attempt details.");
        if (diffContent(parent.content, normalized).empty) throw new InputError("This revision has no changes compared with the entry it starts from.");
      }
      const snapshot = {
        id: `s_${hex(6)}`, parent: parent.id, kind, createdAt: now(),
        message: text(message, "Message", 300) || (kind === "attempt" ? "Cooked" : "Revised"),
        content: normalized, attempt: details,
      };
      doc.snapshots.push(snapshot);
      if (makeCurrent) doc.current = snapshot.id;
      doc.version += 1;
      doc.updatedAt = snapshot.createdAt;
      const publishedPhotos = this.#writeWithPhotos(`recipes/${doc.id}.json`, doc, [...normalized.photos, ...(details?.photos ?? [])], stagedPhotos);
      return { recipe: doc, snapshotId: snapshot.id, publishedPhotos };
    });
  }

  /** Moving Current (also backwards) never deletes or rewrites snapshots. */
  setCurrent(recipeId, { expectedVersion, snapshotId }) {
    return this.withLock(() => {
      const doc = this.getRecipe(recipeId);
      this.#checkVersion(doc.version, expectedVersion, "This recipe");
      if (typeof snapshotId !== "string" || !SNAPSHOT_ID.test(snapshotId) || !doc.snapshots.some((snapshot) => snapshot.id === snapshotId)) {
        throw new InputError("That history entry does not exist.", 404);
      }
      doc.current = snapshotId;
      doc.version += 1;
      doc.updatedAt = now();
      this.#write(`recipes/${doc.id}.json`, doc);
      return { recipe: doc };
    });
  }

  setRecipeCategories(recipeId, { expectedVersion, categoryIds }) {
    return this.withLock(() => {
      const doc = this.getRecipe(recipeId);
      this.#checkVersion(doc.version, expectedVersion, "This recipe");
      doc.categoryIds = this.#categoryIds(categoryIds);
      doc.version += 1;
      doc.updatedAt = now();
      this.#write(`recipes/${doc.id}.json`, doc);
      return { recipe: doc };
    });
  }

  // ---- photos --------------------------------------------------------------

  /**
   * Writes a validated photo straight into assets/. The app itself no longer uses this for
   * uploads (they are staged in memory until Save, see #publishPhotos); kept for tools and tests.
   */
  savePhoto(bytes, declaredType) {
    const extension = checkPhoto(bytes, declaredType);
    return this.withLock(() => {
      const id = newPhotoId(extension);
      mkdirSync(join(this.dir, "assets"), { recursive: true });
      this.assertLockHeld();
      writeFileAtomic(join(this.dir, "assets", id), bytes);
      this.lastSavedAt = now();
      return { id };
    });
  }

  photo(id) {
    if (typeof id !== "string" || !PHOTO_ID.test(id)) throw new InputError("Unknown photo.", 404);
    try { return { bytes: readFileSync(join(this.dir, "assets", id)), mime: MIME[id.split(".").pop()] }; }
    catch (error) { if (error.code === "ENOENT") throw new InputError("That photo is missing from the cookbook folder.", 404); throw error; }
  }

  #write(relativePath, value) {
    this.assertLockHeld();
    writeFileAtomic(join(this.dir, relativePath), json(value));
    this.lastSavedAt = now();
  }
}
