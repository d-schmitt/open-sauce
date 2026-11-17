// The one draft contract shared by the Copilot canvas action `submit_draft` and the
// local agent endpoint `POST /agent/v1/drafts`. The published JSON Schema below is
// the schema the server validates against (see checkSchema), so documentation and
// validation cannot drift apart. After this structural check, every draft also goes
// through normalizeContent and validateDiagram in runtime.submitDraft.
import { ID, InputError, OVEN_MODES, RECIPE_ID, SNAPSHOT_ID, UNITS } from "./model.mjs";

export const MAX_DRAFTS = 20;

const idSchema = { type: "string", pattern: ID.source, description: "Your own short id, unique within the recipe, used to connect steps." };
const optionalText = (maxLength, description) => ({ type: "string", maxLength, ...(description ? { description } : {}) });

const ingredientSchema = {
  type: "object", required: ["id", "name"], additionalProperties: false,
  properties: {
    id: idSchema,
    name: { type: "string", minLength: 1, maxLength: 120 },
    quantity: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1000000, description: "Total amount in the recipe. Use null for 'to taste'." },
    unit: { type: "string", enum: UNITS, description: "Metric unit. Empty string for no unit." },
    note: optionalText(200, "For example 'room temperature'."),
  },
};

const inputSchema = {
  type: "object", additionalProperties: false,
  description: "Exactly one of: {ingredient} (all of it), {ingredient, quantity} (a portion of a split ingredient), {action} (the result of an earlier step).",
  properties: {
    ingredient: idSchema,
    quantity: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1000000 },
    action: idSchema,
  },
};

const actionSchema = {
  type: "object", required: ["id", "text", "inputs"], additionalProperties: false,
  properties: {
    id: idSchema,
    text: { type: "string", minLength: 1, maxLength: 500 },
    inputs: { type: "array", maxItems: 60, items: inputSchema },
    durationMinutes: { type: ["number", "null"], minimum: 0, maximum: 10080 },
    temperatureC: { type: ["number", "null"], minimum: 0, maximum: 500 },
    ovenMode: { type: "string", enum: OVEN_MODES },
  },
};

export const DRAFT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "open-sauce/agent/v1/draft",
  title: "Open Sauce recipe draft",
  description: "A proposed new recipe or a proposed revision of an existing one. It is placed in the review area of the running app and is never saved, made current or synced until the user reviews it and presses Save.",
  type: "object", required: ["recipe"], additionalProperties: false,
  properties: {
    recipeId: { type: "string", pattern: RECIPE_ID.source, description: "Existing recipe to revise. Omit for a new recipe." },
    baseSnapshotId: { type: "string", pattern: SNAPSHOT_ID.source, description: "History entry the revision starts from. Defaults to the current one. Only with recipeId." },
    message: optionalText(300, "Short summary of the proposal, for example 'Transcribed from Grandma's card'."),
    submittedBy: optionalText(80, "Name of the assistant or tool, shown to the reviewer."),
    categories: {
      type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 40 },
      description: "Suggested category names for a new recipe. Matched to existing categories ignoring case; unknown names are shown to the reviewer, never created. Not allowed with recipeId.",
    },
    recipe: {
      type: "object", required: ["title", "ingredients", "actions"], additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: optionalText(4000),
        attribution: optionalText(200, "Family member or source."),
        sourceUrl: optionalText(2000, "http:// or https:// address, or empty."),
        yield: optionalText(100, "For example '1 cake (26 cm)'."),
        notes: optionalText(8000),
        photos: { type: "array", maxItems: 0, description: "Must be empty. New photos are added by the user while reviewing. A revision draft automatically keeps the photos of its base snapshot; only the user can remove them." },
        ingredients: { type: "array", maxItems: 150, items: ingredientSchema },
        actions: {
          type: "array", maxItems: 150, items: actionSchema,
          description: "Steps in order. Every ingredient (or all its portions) and every step result must be used exactly once; the last step produces the dish.",
        },
      },
    },
  },
};

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value);

/** Validates exactly the JSON Schema keywords used above. Throws InputError naming the JSON path. */
export function checkSchema(value, schema = DRAFT_SCHEMA, path = "draft") {
  const fail = (message) => { throw new InputError(`${path} ${message}`); };
  const types = [schema.type].flat().filter(Boolean);
  const actual = typeOf(value);
  if (types.length && !types.some((type) => type === actual || (type === "number" && actual === "integer"))) fail(`must be ${types.join(" or ")}.`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of: ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`);
  if (actual === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail("must not be empty.");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`is too long (maximum ${schema.maxLength} characters).`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`has an invalid format (expected ${schema.pattern}).`);
  }
  if (actual === "number" || actual === "integer") {
    if (!Number.isFinite(value)) fail("must be a finite number.");
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(`must be greater than ${schema.exclusiveMinimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}.`);
  }
  if (actual === "array") {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(schema.maxItems === 0 ? "must be empty." : `has too many entries (maximum ${schema.maxItems}).`);
    if (schema.items) value.forEach((item, index) => checkSchema(item, schema.items, `${path}[${index}]`));
  }
  if (actual === "object") {
    for (const key of schema.required ?? []) if (value[key] === undefined) fail(`needs "${key}".`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (!child) { if (schema.additionalProperties === false) fail(`has an unknown field "${key}".`); continue; }
      checkSchema(item, child, `${path}.${key}`);
    }
  }
  return value;
}

/** Operation descriptions published by GET /agent/v1/schema. */
export const AGENT_OPERATIONS = [
  { method: "GET", path: "/agent/v1/schema", description: "This document." },
  { method: "GET", path: "/agent/v1/instance", description: "Which running instance this is: instanceId, surface (standalone or canvas) and cookbook folder. Several instances can run at once, each with its own endpoint file and token." },
  { method: "GET", path: "/agent/v1/recipes", description: "Read-only list of recipes: id, title, categories, currentSnapshotId." },
  { method: "GET", path: "/agent/v1/recipes/{recipeId}", description: "Read-only current version of one recipe, in the same shape as draft.recipe (photos is always empty; photoCount says how many it has). A revision draft keeps the photos of its base snapshot automatically." },
  { method: "GET", path: "/agent/v1/categories", description: "Read-only list of category names." },
  {
    method: "POST", path: "/agent/v1/drafts", requestSchema: "draft",
    description: "Place a draft in the review area. Responds 202 with {draftId, status: \"in_review\", instance: {id, cookbook}, diagramErrors, unmatchedCategories}. Optional header X-Open-Sauce-Instance: <instanceId> makes the request fail with 409 if it reached a different instance. Nothing is saved: the user reviews, corrects and saves it in the app.",
    errors: { 400: "invalid draft (message names the field)", 401: "missing or wrong token", 403: "browser or foreign-host request", 404: "unknown recipeId", 409: "X-Open-Sauce-Instance names a different instance", 412: "no cookbook set up", 415: "not JSON", 429: "review area full" },
  },
];
