// Shared, dependency-free recipe model. Imported by the Node server and served
// unchanged to the browser, so validation and table layout cannot drift apart.

// Working name. Rename the app here (and in README.md).
export const APP_NAME = "Open Sauce";

export class InputError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const UNITS = ["g", "kg", "ml", "cl", "l", "tsp", "tbsp", "pinch", "piece", "clove", "bunch", "can", ""];
export const UNIT_LABELS = { g: "g", kg: "kg", ml: "ml", cl: "cl", l: "l", tsp: "tsp", tbsp: "tbsp", pinch: "pinch", piece: "", clove: "clove", bunch: "bunch", can: "can", "": "" };
const PLURAL = { pinch: "pinches", clove: "cloves", bunch: "bunches", can: "cans" };
export const UNIT_NAMES = { g: "g (gram)", kg: "kg", ml: "ml", cl: "cl", l: "l (litre)", tsp: "tsp", tbsp: "tbsp", pinch: "pinch", piece: "piece", clove: "clove", bunch: "bunch", can: "can", "": "no unit" };
export const OVEN_MODES = ["", "top-bottom", "fan", "grill", "fan-grill", "bottom", "top"];
export const OVEN_MODE_LABELS = {
  "": "", "top-bottom": "Top and bottom heat", fan: "Fan", grill: "Grill", "fan-grill": "Fan grill", bottom: "Bottom heat", top: "Top heat",
};

export const ID = /^[A-Za-z0-9_-]{1,40}$/;
export const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const SNAPSHOT_ID = /^s_[a-f0-9]{8,32}$/;
export const PHOTO_ID = /^[a-f0-9]{32}\.(png|jpg|webp)$/;
const EPSILON = 1e-9;

export function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new InputError(`${label} must be text.`);
  value = value.trim();
  if (required && !value) throw new InputError(`${label} is required.`);
  if (value.length > max) throw new InputError(`${label} is too long (maximum ${max} characters).`);
  return value;
}

function optionalNumber(value, label, { min = 0, max = 1e6, positive = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max || (positive && number <= 0)) {
    throw new InputError(`${label} must be a ${positive ? "positive " : ""}number${max < 1e6 ? ` up to ${max}` : ""}.`);
  }
  return number;
}

function list(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError(`${label} must be a list.`);
  if (value.length > max) throw new InputError(`${label} has too many entries (maximum ${max}).`);
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new InputError(`${label} has an invalid id.`);
  return value;
}

export function photoIds(value, label = "Photos", max = 20) {
  const ids = list(value, label, max);
  for (const photo of ids) if (typeof photo !== "string" || !PHOTO_ID.test(photo)) throw new InputError(`${label} contains an invalid photo reference.`);
  return [...new Set(ids)];
}

export function sourceUrl(value) {
  const url = text(value, "Source URL", 2000);
  if (!url) return "";
  let parsed;
  try { parsed = new URL(url); } catch { throw new InputError("Source URL must be a full web address starting with http:// or https://."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new InputError("Source URL must start with http:// or https://.");
  return url;
}

/** Structural validation of recipe content. Diagram logic errors are reported separately by validateDiagram. */
export function normalizeContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Recipe content must be an object.");
  const ingredientIds = new Set();
  const ingredients = list(input.ingredients, "Ingredients", 150).map((item, index) => {
    if (!item || typeof item !== "object") throw new InputError(`Ingredient ${index + 1} is invalid.`);
    const ingredient = {
      id: id(item.id, `Ingredient ${index + 1}`),
      name: text(item.name, `Ingredient ${index + 1} name`, 120, true),
      quantity: optionalNumber(item.quantity, `Quantity of "${item.name}"`, { positive: true }),
      unit: item.unit ?? "",
      note: text(item.note, `Note for "${item.name}"`, 200),
    };
    if (!UNITS.includes(ingredient.unit)) throw new InputError(`Unit of "${ingredient.name}" must be one of: ${UNITS.filter(Boolean).join(", ")}.`);
    if (ingredientIds.has(ingredient.id)) throw new InputError(`Ingredient id "${ingredient.id}" is used twice.`);
    ingredientIds.add(ingredient.id);
    return ingredient;
  });
  const actionIds = new Set();
  const actions = list(input.actions, "Preparation steps", 150).map((item, index) => {
    if (!item || typeof item !== "object") throw new InputError(`Step ${index + 1} is invalid.`);
    const action = {
      id: id(item.id, `Step ${index + 1}`),
      text: text(item.text, `Step ${index + 1} text`, 500, true),
      inputs: list(item.inputs, `Inputs of step ${index + 1}`, 60).map((ref) => {
        if (ref && typeof ref.ingredient === "string" && ref.action === undefined) {
          const portion = optionalNumber(ref.quantity, `Portion in step ${index + 1}`, { positive: true });
          return portion === null ? { ingredient: id(ref.ingredient, "Input") } : { ingredient: id(ref.ingredient, "Input"), quantity: portion };
        }
        if (ref && typeof ref.action === "string" && ref.ingredient === undefined) return { action: id(ref.action, "Input") };
        throw new InputError(`Inputs of step ${index + 1} must reference an ingredient or an earlier step.`);
      }),
      durationMinutes: optionalNumber(item.durationMinutes, `Duration of step ${index + 1}`, { max: 10080 }),
      temperatureC: optionalNumber(item.temperatureC, `Temperature of step ${index + 1}`, { max: 500 }),
      ovenMode: item.ovenMode ?? "",
    };
    if (!OVEN_MODES.includes(action.ovenMode)) throw new InputError(`Oven mode of step ${index + 1} is not supported.`);
    if (actionIds.has(action.id)) throw new InputError(`Step id "${action.id}" is used twice.`);
    actionIds.add(action.id);
    return action;
  });
  return {
    title: text(input.title, "Title", 200, true),
    description: text(input.description, "Description", 4000),
    attribution: text(input.attribution, "Family or source attribution", 200),
    sourceUrl: sourceUrl(input.sourceUrl),
    yield: text(input.yield, "Yield", 100),
    ingredients,
    actions,
    notes: text(input.notes, "Notes", 8000),
    photos: photoIds(input.photos),
  };
}

const short = (value, max = 40) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);
const stepName = (action) => `"${short(action.text)}"`;

/**
 * Checks the preparation graph. Returns { errors, finalId }.
 * Each error has { code, message, ids } so the editor can highlight the culprit.
 */
export function validateDiagram(content) {
  const errors = [];
  const add = (code, message, ids = []) => errors.push({ code, message, ids });
  const ingredients = new Map(content.ingredients.map((item) => [item.id, item]));
  const actions = new Map(content.actions.map((item) => [item.id, item]));
  if (!content.actions.length) return { errors, finalId: null };
  const consumers = new Map(content.actions.map((action) => [action.id, []]));
  const allocation = new Map(content.ingredients.map((item) => [item.id, { whole: 0, portions: 0, count: 0, steps: [] }]));

  for (const action of content.actions) {
    if (!action.inputs.length) add("missing_input", `Step ${stepName(action)} has no inputs. Choose at least one ingredient or earlier step.`, [action.id]);
    for (const ref of action.inputs) {
      if (ref.ingredient !== undefined) {
        const ingredient = ingredients.get(ref.ingredient);
        if (!ingredient) { add("missing_input", `Step ${stepName(action)} uses an ingredient that is not in the ingredient list.`, [action.id]); continue; }
        const slot = allocation.get(ref.ingredient);
        slot.steps.push(action.id);
        if (ref.quantity === undefined || ref.quantity === null) { slot.whole += 1; continue; }
        if (ingredient.quantity === null) {
          add("portion_without_quantity", `"${ingredient.name}" has no quantity, so it cannot be split into portions. Use the whole ingredient in one step.`, [ingredient.id, action.id]);
          continue;
        }
        slot.portions += ref.quantity;
        slot.count += 1;
      } else {
        if (!actions.has(ref.action)) { add("missing_input", `Step ${stepName(action)} uses a step that does not exist.`, [action.id]); continue; }
        if (ref.action === action.id) continue; // reported as a cycle below
        consumers.get(ref.action).push(action.id);
      }
    }
  }

  for (const ingredient of content.ingredients) {
    const slot = allocation.get(ingredient.id);
    const unit = UNIT_LABELS[ingredient.unit] ? ` ${UNIT_LABELS[ingredient.unit]}` : "";
    if (!slot.whole && !slot.count) add("unused_ingredient", `"${ingredient.name}" is not used in any step. Add it to a step so it appears in the table.`, [ingredient.id]);
    else if (slot.whole > 1) add("over_allocated", `"${ingredient.name}" is used whole in ${slot.whole} steps. Split it into portions instead.`, [ingredient.id, ...slot.steps]);
    else if (slot.whole && slot.count) add("over_allocated", `"${ingredient.name}" is used whole and also in portions. Use portions everywhere or the whole amount once.`, [ingredient.id, ...slot.steps]);
    else if (slot.count && slot.portions > ingredient.quantity + EPSILON) {
      add("over_allocated", `Portions of "${ingredient.name}" add up to ${formatQuantity(slot.portions)}${unit}, but the ingredient list has ${formatQuantity(ingredient.quantity)}${unit}.`, [ingredient.id, ...slot.steps]);
    } else if (slot.count && slot.portions < ingredient.quantity - EPSILON) {
      add("under_allocated", `${formatQuantity(ingredient.quantity - slot.portions)}${unit} of "${ingredient.name}" is not assigned to any step.`, [ingredient.id, ...slot.steps]);
    }
  }

  for (const [actionId, users] of consumers) {
    if (users.length > 1) {
      add("consumed_twice", `The result of step ${stepName(actions.get(actionId))} is used by more than one step (${users.map((user) => stepName(actions.get(user))).join(", ")}). A mixture can only go into one later step.`, [actionId, ...users]);
    }
  }

  // Cycle detection over action -> input action edges.
  const state = new Map();
  const reported = new Set();
  const visit = (actionId, path) => {
    state.set(actionId, "active");
    for (const ref of actions.get(actionId).inputs) {
      if (ref.action === undefined || !actions.has(ref.action)) continue;
      if (state.get(ref.action) === "active") {
        const loop = [...path.slice(path.indexOf(ref.action)), ref.action];
        const key = [...new Set(loop)].sort().join("|");
        if (!reported.has(key)) {
          reported.add(key);
          add("cycle", `Steps form a loop: ${loop.map((item) => stepName(actions.get(item))).join(" -> ")}. A step cannot use its own result.`, [...new Set(loop)]);
        }
      } else if (!state.has(ref.action)) visit(ref.action, [...path, ref.action]);
    }
    state.set(actionId, "done");
  };
  for (const action of content.actions) if (!state.has(action.id)) visit(action.id, [action.id]);

  const sinks = content.actions.filter((action) => consumers.get(action.id).length === 0);
  let finalId = null;
  if (!sinks.length) add("no_final", "No step produces the finished dish. Make sure the last step is not used as an input anywhere.", []);
  else if (sinks.length > 1) {
    add("unreachable", `These steps do not lead to the final result: ${sinks.slice(0, -1).map(stepName).join(", ")}. Use them as inputs of a later step so everything ends in one dish (currently ${stepName(sinks.at(-1))} is the last step).`, sinks.slice(0, -1).map((action) => action.id));
  } else finalId = sinks[0].id;
  return { errors, finalId };
}

export function formatQuantity(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0 && value !== 0) return String(Number(value.toPrecision(2)));
  return String(rounded);
}

/** Never rounds piece counts to whole numbers: 1.5 eggs stay 1.5. */
export function formatAmount(quantity, unit) {
  if (quantity === null || quantity === undefined) return "";
  const number = formatQuantity(quantity);
  const label = quantity !== 1 && PLURAL[unit] ? PLURAL[unit] : UNIT_LABELS[unit] ?? unit;
  return label ? `${number} ${label}` : number;
}

export function parseMultiplier(value) {
  const number = typeof value === "string" ? Number(value.trim().replace(/x$/i, "").replace(",", ".")) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0 || number > 100) {
    throw new InputError("Enter a multiplier greater than 0 and at most 100, such as 0.5 or 2.");
  }
  return number;
}

/** Multiplies ingredient and portion quantities. Times and temperatures are never scaled. */
export function scaleContent(content, multiplier) {
  const factor = parseMultiplier(multiplier);
  const scale = (value) => (value === null || value === undefined ? value : value * factor);
  return {
    ...content,
    ingredients: content.ingredients.map((item) => ({ ...item, quantity: scale(item.quantity) })),
    actions: content.actions.map((action) => ({
      ...action,
      inputs: action.inputs.map((ref) => (ref.quantity === undefined ? { ...ref } : { ...ref, quantity: scale(ref.quantity) })),
    })),
  };
}

export function actionMeta(action) {
  const parts = [];
  if (action.durationMinutes !== null && action.durationMinutes !== undefined) parts.push(formatDuration(action.durationMinutes));
  if (action.temperatureC !== null && action.temperatureC !== undefined) parts.push(`${formatQuantity(action.temperatureC)} °C`);
  if (action.ovenMode) parts.push(OVEN_MODE_LABELS[action.ovenMode]);
  return parts.join(" · ");
}

export function formatDuration(minutes) {
  if (minutes < 60) return `${formatQuantity(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes - hours * 60;
  return rest ? `${hours} h ${formatQuantity(rest)} min` : `${hours} h`;
}

/**
 * "Cooking for Engineers" layout. Leaves (ingredient portions) are rows in
 * depth-first order from the final step. An action's column is its height
 * above the leaves (ingredients are height 0), so the final step is always the
 * last column. Gaps between a node and its consumer become empty spanning cells.
 * The result is a grid of cells with rowspan/colspan, covering every position once.
 */
export function layoutTable(content, multiplier = 1) {
  const factor = parseMultiplier(multiplier);
  const { errors, finalId } = validateDiagram(content);
  if (errors.length) return { ok: false, errors };
  if (!finalId) return { ok: true, empty: true, rows: [], columnCount: 0, errors: [] };
  const ingredients = new Map(content.ingredients.map((item) => [item.id, item]));
  const actions = new Map(content.actions.map((item) => [item.id, item]));
  const leaves = [];
  const build = (actionId) => {
    const action = actions.get(actionId);
    const children = action.inputs.map((ref) => {
      if (ref.action !== undefined) return build(ref.action);
      const ingredient = ingredients.get(ref.ingredient);
      const leaf = { type: "leaf", ingredient, quantity: ref.quantity ?? ingredient.quantity, portion: ref.quantity !== undefined, height: 0 };
      leaf.row = leaves.length;
      leaf.rows = 1;
      leaves.push(leaf);
      return leaf;
    });
    const row = children[0].row;
    return { type: "action", action, children, height: 1 + Math.max(...children.map((child) => child.height)), row, rows: children.reduce((sum, child) => sum + child.rows, 0) };
  };
  const root = build(finalId);
  const height = root.height;
  const cells = [];
  const place = (node, parentColumn) => {
    if (node.type === "leaf") {
      const { ingredient } = node;
      cells.push({ row: node.row, column: 0, rowspan: 1, colspan: 1, kind: "amount", text: formatAmount(node.quantity === null ? null : node.quantity * factor, ingredient.unit), ingredientId: ingredient.id });
      cells.push({ row: node.row, column: 1, rowspan: 1, colspan: 1, kind: "ingredient", name: ingredient.name, note: ingredient.note, portion: node.portion, ingredientId: ingredient.id });
      if (parentColumn > 2) cells.push({ row: node.row, column: 2, rowspan: 1, colspan: parentColumn - 2, kind: "gap" });
      return;
    }
    const column = node.height + 1;
    cells.push({ row: node.row, column, rowspan: node.rows, colspan: 1, kind: "action", actionId: node.action.id, text: node.action.text, meta: actionMeta(node.action), final: node === root });
    if (parentColumn !== null && parentColumn > column + 1) cells.push({ row: node.row, column: column + 1, rowspan: node.rows, colspan: parentColumn - column - 1, kind: "gap" });
    for (const child of node.children) place(child, column);
  };
  place(root, null);
  const rows = leaves.map(() => []);
  for (const cell of cells) rows[cell.row].push(cell);
  for (const row of rows) row.sort((a, b) => a.column - b.column);
  return { ok: true, empty: false, errors: [], finalId, columnCount: height + 2, rows };
}

export function tableHtml(layout, escape = escapeHtml) {
  if (!layout.ok) {
    return `<div class="diagram-errors" role="alert"><p><strong>The preparation table cannot be drawn yet.</strong></p><ul>${layout.errors.map((error) => `<li>${escape(error.message)}</li>`).join("")}</ul></div>`;
  }
  if (layout.empty) return `<p class="muted">No preparation steps yet.</p>`;
  const body = layout.rows.map((row) => `<tr>${row.map((cell) => {
    const span = `${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ""}${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ""}`;
    if (cell.kind === "amount") return `<td class="cfe-amount"${span}>${escape(cell.text)}</td>`;
    if (cell.kind === "ingredient") return `<th scope="row" class="cfe-ingredient${cell.portion ? " portion" : ""}"${span}>${escape(cell.name)}${cell.note ? `<span class="cfe-note">${escape(cell.note)}</span>` : ""}</th>`;
    if (cell.kind === "gap") return `<td class="cfe-gap"${span}></td>`;
    return `<td class="cfe-action${cell.final ? " final" : ""}"${span}><span class="cfe-text">${escape(cell.text)}</span>${cell.meta ? `<span class="cfe-meta">${escape(cell.meta)}</span>` : ""}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="cfe-scroll" tabindex="0" role="region" aria-label="Preparation table"><table class="cfe"><caption class="visually-hidden">Preparation table: read from left to right. Each step combines the rows it spans.</caption><tbody>${body}</tbody></table></div>`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** Compares a child snapshot with its parent. When the child was cooked at a multiplier, the parent is scaled first. */
export function diffContent(parent, child, multiplier = 1) {
  const base = multiplier === 1 ? parent : scaleContent(parent, multiplier);
  const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);
  const before = new Map(base.ingredients.map((item) => [item.id, item]));
  const after = new Map(child.ingredients.map((item) => [item.id, item]));
  const ingredients = {
    added: child.ingredients.filter((item) => !before.has(item.id)),
    removed: base.ingredients.filter((item) => !after.has(item.id)),
    changed: child.ingredients.filter((item) => before.has(item.id)).flatMap((item) => {
      const old = before.get(item.id);
      if (near(old.quantity, item.quantity) && old.unit === item.unit && old.name === item.name && old.note === item.note) return [];
      return [{ id: item.id, from: old, to: item }];
    }),
  };
  const oldSteps = new Map(base.actions.map((item) => [item.id, item]));
  const newSteps = new Map(child.actions.map((item) => [item.id, item]));
  const oven = [];
  const textChanged = [];
  const inputsChanged = [];
  for (const action of child.actions) {
    const old = oldSteps.get(action.id);
    if (!old) continue;
    if (old.text !== action.text) textChanged.push({ id: action.id, from: old.text, to: action.text });
    for (const field of ["temperatureC", "durationMinutes", "ovenMode"]) {
      if ((old[field] ?? null) !== (action[field] ?? null)) oven.push({ id: action.id, text: action.text, field, from: old[field] ?? null, to: action[field] ?? null });
    }
    if (JSON.stringify(old.inputs) !== JSON.stringify(action.inputs)) inputsChanged.push({ id: action.id, text: action.text });
  }
  const fields = ["title", "description", "attribution", "sourceUrl", "yield", "notes"].filter((field) => base[field] !== child[field]);
  if (JSON.stringify(base.photos) !== JSON.stringify(child.photos)) fields.push("photos");
  return {
    multiplier,
    ingredients,
    steps: { added: child.actions.filter((item) => !oldSteps.has(item.id)), removed: base.actions.filter((item) => !newSteps.has(item.id)), textChanged, inputsChanged },
    oven,
    fields,
    empty: !ingredients.added.length && !ingredients.removed.length && !ingredients.changed.length && !oven.length && !textChanged.length && !inputsChanged.length && !fields.length
      && child.actions.length === base.actions.length && child.actions.every((item) => oldSteps.has(item.id)),
  };
}

const fold = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en");

/** Search and category filter. Several selected categories always means: match ALL of them. */
export function filterRecipes(recipes, { query = "", categoryIds = [] } = {}) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  return recipes.filter((recipe) => {
    if (!categoryIds.every((categoryId) => recipe.categoryIds.includes(categoryId))) return false;
    if (!terms.length) return true;
    const haystack = fold([recipe.title, recipe.description, recipe.attribution, ...(recipe.ingredientNames ?? [])].join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}

export function normalizeAttempt(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Cooking attempt details are missing.");
  const date = text(input.date, "Cooking date", 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new InputError("Cooking date must be a valid date (YYYY-MM-DD).");
  }
  let rating = input.rating ?? null;
  if (rating === "") rating = null;
  if (rating !== null && (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)) throw new InputError("Rating must be 1 to 5 stars.");
  return {
    date,
    multiplier: parseMultiplier(input.multiplier ?? 1),
    outcome: text(input.outcome, "Outcome note", 4000),
    rating: rating === null ? null : Number(rating),
    photos: photoIds(input.photos, "Attempt photos", 10),
  };
}
