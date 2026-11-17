import { cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Cookbook, checkPhoto, newPhotoId, sniffImage } from "./store.mjs";
import { GitSync } from "./sync.mjs";
import { DEMO_SOURCE, checkDataDir, resolveDataDir, saveConfig } from "./config.mjs";
import { InputError, normalizeContent, text, validateDiagram } from "./model.mjs";
import { startServer } from "./server.mjs";
import { MAX_DRAFTS, checkSchema } from "./drafts.mjs";
import { agentDir, listInstances, startAgentServer } from "./agent.mjs";

/**
 * One runtime per process: a single cookbook, sync engine and draft review
 * area shared by every open panel (canvas instance or standalone browser),
 * plus the local agent interface (started with the first panel).
 * `surface` ("standalone" or "canvas") prefixes this instance's id and endpoint file name.
 */
export async function createRuntime({ env = process.env, surface = "standalone", now = Date.now } = {}) {
  // cookbookId identifies one use() of one cookbook in this process. Panels send it with every
  // write, and drafts and staged photos carry it, so nothing opened for one cookbook can be saved
  // into another after a setup change (see README "Changing the cookbook folder").
  const state = { cookbook: null, cookbookId: null, sync: null, source: null, setupError: null, agent: null, agentError: null };
  const agentEnabled = env.OPEN_SAUCE_AGENT !== "off";
  const drafts = new Map();
  // Photos added while reviewing or editing: memory only, never the cookbook folder, until Save.
  const staged = new Map();
  const MAX_STAGED = 30;
  const MAX_STAGED_BYTES = 120 * 1024 * 1024;
  const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
  const servers = new Map();

  const use = (cookbook, source) => {
    state.cookbook = cookbook;
    state.cookbookId = `cb_${randomBytes(6).toString("hex")}`;
    state.sync = new GitSync(cookbook);
    state.source = source;
    state.setupError = null;
    try { state.agent?.update(); } catch (error) { state.agentError = `The agent endpoint file could not be updated: ${error.message}`; }
  };

  try {
    const resolved = resolveDataDir(env);
    if (resolved) use(Cookbook.open(resolved.dir, { create: true }), resolved.source);
  } catch (error) {
    state.setupError = error.message;
  }

  /** Staged photos of the current cookbook that have not expired. Expired ones are dropped on every read. */
  const liveStaged = () => {
    const cutoff = now() - STAGED_TTL_MS;
    const live = new Map();
    for (const [id, photo] of staged) {
      if (photo.at < cutoff) staged.delete(id);
      else if (photo.cookbookId === state.cookbookId) live.set(id, photo);
    }
    return live;
  };

  const runtime = {
    get cookbook() { return state.cookbook; },
    get sync() { return state.sync; },
    requireCookbook() {
      if (!state.cookbook) throw new InputError("No cookbook is set up yet. Open the app and choose a cookbook folder or the demo cookbook.", 412);
      return state.cookbook;
    },
    info() {
      return {
        configured: Boolean(state.cookbook),
        dataDir: state.cookbook?.dir ?? null,
        cookbookId: state.cookbookId,
        source: state.source,
        setupError: state.setupError,
        canChange: state.source !== "env",
        lastSavedAt: state.cookbook?.lastSavedAt ?? null,
        // Where an assistant finds the address and token. The token itself is never sent to the UI.
        agent: {
          enabled: agentEnabled,
          running: Boolean(state.agent),
          instanceId: state.agent?.instanceId ?? null,
          surface,
          file: state.agent?.file ?? null,
          dir: agentDir(env),
          error: state.agentError,
          others: state.agent ? listInstances(env).filter((other) => other.instanceId !== state.agent.instanceId) : [],
        },
      };
    },
    /**
     * Writes from panels must name the cookbook they were opened for. Without this, a panel that
     * loaded cookbook A could save an edit (or a reviewed draft) into cookbook B after another panel
     * switched folders, for example when both have a recipe with the same id and version.
     */
    checkCookbook(cookbookId) {
      if (!state.cookbook) return;
      if (cookbookId !== state.cookbookId) {
        throw new InputError(`This window was opened for a different cookbook. Open Sauce now uses ${state.cookbook.dir}. Nothing was saved; your edits are still on screen. Copy anything you need, then reload.`, 409, { code: "cookbook_changed", cookbook: state.cookbook.dir });
      }
    },
    async setup(input) {
      if (state.source === "env") throw new InputError("The cookbook folder is set by the OPEN_SAUCE_DATA environment variable. Change it there.", 409);
      if (state.cookbook) {
        if (input?.mode === "folder" && typeof input.path === "string" && checkDataDir(input.path) === state.cookbook.dir) return runtime.info();
        const waiting = runtime.drafts().length;
        if (waiting) {
          throw new InputError(`${waiting} draft${waiting === 1 ? " is" : "s are"} waiting for review in ${state.cookbook.dir}. Save or dismiss ${waiting === 1 ? "it" : "them"} before changing the cookbook folder; nothing was changed.`, 409);
        }
      }
      if (input?.mode === "demo") {
        const root = env.OPEN_SAUCE_DEMO_DIR || tmpdir();
        mkdirSync(root, { recursive: true });
        const dir = join(root, `open-sauce-demo-${randomBytes(4).toString("hex")}`);
        cpSync(DEMO_SOURCE, dir, { recursive: true, errorOnExist: true });
        use(Cookbook.open(dir), "demo");
      } else if (input?.mode === "folder") {
        const dir = checkDataDir(input.path);
        const cookbook = Cookbook.open(dir, { create: true });
        saveConfig(dir, env);
        use(cookbook, "config");
      } else throw new InputError("Choose a cookbook folder or the demo cookbook.");
      return runtime.info();
    },

    // ---- Draft review area. Copilot (canvas action) and local agents (agent.mjs) both end up
    // here with identical validation. Drafts live only in memory: nothing is written, made
    // current or synced until the user opens the draft in the editor and presses Save.
    submitDraft(input, { source = "copilot" } = {}) {
      checkSchema(input);
      const cookbook = runtime.requireCookbook();
      if (drafts.size >= MAX_DRAFTS) {
        throw new InputError(`The review area already holds ${MAX_DRAFTS} drafts. Ask the user to review or dismiss some first; nothing was added.`, 429);
      }
      let recipeId = null;
      let baseSnapshotId = null;
      if (input.recipeId !== undefined) {
        const doc = cookbook.getRecipe(input.recipeId);
        recipeId = doc.id;
        baseSnapshotId = input.baseSnapshotId ?? doc.current;
        if (!doc.snapshots.some((snapshot) => snapshot.id === baseSnapshotId)) throw new InputError("draft.baseSnapshotId does not exist in that recipe.");
        if (input.categories !== undefined) throw new InputError("draft.categories is only for new recipes. Categories of an existing recipe are changed on its page.");
      } else if (input.baseSnapshotId !== undefined) throw new InputError("draft.baseSnapshotId needs recipeId.");
      const content = normalizeContent(input.recipe);
      if (recipeId) {
        // Assistants never send photo ids (schema), so a revision keeps the photos of the exact
        // snapshot it is based on. The user sees them in review and may remove them there.
        const base = cookbook.getRecipe(recipeId).snapshots.find((snapshot) => snapshot.id === baseSnapshotId);
        content.photos = [...(base.content.photos ?? [])];
      }
      const existing = cookbook.readCategories().categories;
      const suggestedCategoryIds = [];
      const unmatchedCategories = [];
      for (const name of new Set((input.categories ?? []).map((item) => item.trim()).filter(Boolean))) {
        const match = existing.find((category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (match) { if (!suggestedCategoryIds.includes(match.id)) suggestedCategoryIds.push(match.id); } else unmatchedCategories.push(name);
      }
      const draft = {
        id: `d_${randomBytes(5).toString("hex")}`,
        cookbookId: state.cookbookId, cookbook: cookbook.dir,
        createdAt: new Date().toISOString(),
        source, submittedBy: text(input.submittedBy, "draft.submittedBy", 80),
        recipeId, baseSnapshotId,
        message: text(input.message, "draft.message", 300),
        content,
        suggestedCategoryIds, unmatchedCategories,
        diagramErrors: validateDiagram(content).errors,
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    drafts: () => [...drafts.values()].filter((draft) => draft.cookbookId === state.cookbookId).reverse(),

    // ---- Staged photos (see Cookbook#publishPhotos). Lost on restart, like drafts.
    stagePhoto(bytes, declaredType) {
      const extension = checkPhoto(bytes, declaredType);
      runtime.requireCookbook();
      liveStaged();
      const total = [...staged.values()].reduce((sum, photo) => sum + photo.bytes.length, 0);
      if (staged.size >= MAX_STAGED || total + bytes.length > MAX_STAGED_BYTES) {
        throw new InputError("Too many unsaved photos are waiting. Save or cancel open edits first; nothing was added.", 429);
      }
      const id = newPhotoId(extension);
      staged.set(id, { bytes, at: now(), cookbookId: state.cookbookId });
      return { id, staged: true };
    },
    stagedPhoto(id) {
      const photo = liveStaged().get(id);
      return photo ? { bytes: photo.bytes, mime: sniffImage(photo.bytes) } : null;
    },
    /** Only this cookbook's unexpired photos, so an expired or foreign one is never published. */
    get stagedPhotos() { return liveStaged(); },
    discardStagedPhoto(id) { return staged.delete(id); },
    releasePublished(ids = []) { for (const id of ids) staged.delete(id); },
    dismissDraft(id) {
      if (!drafts.delete(id)) throw new InputError("That draft is no longer in the review area.", 404);
    },

    async startAgent() {
      if (!agentEnabled || state.agent) return state.agent;
      try {
        state.agent = await startAgentServer({ runtime, env, surface });
        state.agentError = null;
      } catch (error) {
        state.agentError = `The agent interface could not start: ${error.message}`;
      }
      return state.agent;
    },

    async open(instanceId, options = {}) {
      await runtime.startAgent();
      let pending = servers.get(instanceId);
      if (!pending) {
        pending = startServer({ runtime, ...options });
        servers.set(instanceId, pending);
        try { await pending; } catch (error) { servers.delete(instanceId); throw error; }
      }
      return pending;
    },
    async close(instanceId) {
      const pending = servers.get(instanceId);
      if (pending) {
        servers.delete(instanceId);
        await (await pending).close();
      }
    },
    async dispose() {
      await Promise.all([...servers.keys()].map((key) => runtime.close(key)));
      const agent = state.agent;
      state.agent = null;
      await agent?.close();
    },
  };
  return runtime;
}
