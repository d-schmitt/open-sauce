import { APP_NAME, RECIPE_ID } from "./model.mjs";
import { DRAFT_SCHEMA } from "./drafts.mjs";

// Tool parameter schemas are plain objects; the $schema/$id markers are only for the published document.
const { $schema, $id, ...toolSchema } = DRAFT_SCHEMA;
const empty = { type: "object", properties: {}, additionalProperties: false };
export function cookbookCanvas({ createCanvas, CanvasError }, runtime) {
  const guard = (fn) => (args) => {
    try { return fn(args); }
    catch (error) {
      if (error instanceof CanvasError) throw error;
      if (Number.isInteger(error?.status)) throw new CanvasError(error.status === 404 ? "not_found" : "invalid_input", error.message);
      throw error;
    }
  };
  return createCanvas({
    id: "open-sauce",
    displayName: APP_NAME,
    description: "A family cookbook with Cooking for Engineers preparation tables, recipe history and cooking attempts.",
    inputSchema: empty,
    open: async ({ instanceId }) => {
      const server = await runtime.open(instanceId);
      return { title: APP_NAME, url: server.url };
    },
    onClose: ({ instanceId }) => runtime.close(instanceId),
    actions: [
      {
        name: "list_recipes",
        description: "List recipes in the cookbook (id, title, categories). Read-only.",
        inputSchema: empty,
        handler: guard(() => {
          const cookbook = runtime.requireCookbook();
          const { recipes } = cookbook.listRecipes();
          const names = new Map(cookbook.readCategories().categories.map((category) => [category.id, category.name]));
          return recipes.map((recipe) => ({ id: recipe.id, title: recipe.title, categories: recipe.categoryIds.map((id) => names.get(id)), currentSnapshotId: recipe.currentId }));
        }),
      },
      {
        name: "get_recipe",
        description: "Read the current snapshot of one recipe. Read-only. recipe.photos is always empty (photoCount says how many it has); a revision draft keeps the base snapshot's photos automatically.",
        inputSchema: {
          type: "object", required: ["recipeId"], additionalProperties: false,
          properties: { recipeId: { type: "string", pattern: RECIPE_ID.source } },
        },
        handler: guard(({ input }) => {
          if (typeof input?.recipeId !== "string" || !RECIPE_ID.test(input.recipeId)) throw new CanvasError("invalid_input", "recipeId is invalid.");
          const doc = runtime.requireCookbook().getRecipe(input.recipeId);
          const current = doc.snapshots.find((snapshot) => snapshot.id === doc.current);
          // Photo ids are app-internal and the draft schema refuses them; a revision draft keeps the base snapshot's photos automatically.
          return { recipeId: doc.id, snapshotId: current.id, kind: current.kind, createdAt: current.createdAt, recipe: { ...current.content, photos: [] }, photoCount: current.content.photos.length };
        }),
      },
      {
        name: "submit_draft",
        description: "Use this to add a recipe the user gives you (pasted text, a transcription, a description): convert it to the draft structure and place it in the review area. Also for proposing a revision of an existing recipe. This never saves, sets Current or syncs; the user reviews every field, corrects it and saves it in the editor. Connect every ingredient (or all portions of a split ingredient) and every step result exactly once; the last step produces the dish.",
        inputSchema: toolSchema,
        handler: guard(({ input }) => {
          const draft = runtime.submitDraft(input, { source: "copilot" });
          return {
            draftId: draft.id,
            status: "in_review",
            cookbook: draft.cookbook,
            diagramErrors: draft.diagramErrors.map((error) => error.message),
            unmatchedCategories: draft.unmatchedCategories,
            note: "The draft is waiting in the review area. Nothing was saved. The user reviews it, can correct anything and saves it.",
          };
        }),
      },
    ],
  });
}
