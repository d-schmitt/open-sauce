// Local machine interface for other AI assistants ("agents") that can run tools on
// this computer, for example a coding agent that can call curl. It is deliberately
// narrow: read the cookbook and place drafts in the review area of THIS running app.
// It cannot save, change Current, upload photos, touch categories or sync.
//
// Why a separate server and token instead of the UI's capability URL:
// - The UI token can save and sync; giving it to an agent would bypass review.
// - The agent token travels in an Authorization header, never in a URL, so it does
//   not end up in shell history of URLs, proxy logs or the browser.
// - The token and address are written only to a 0600 file in the user's config
//   folder (never printed). Any program running as this user can read that file;
//   that is the trust boundary, the same as for the recipe files themselves.
//
// One endpoint file PER RUNNING INSTANCE, in <config folder>/agents/<instanceId>.json.
// The standalone app and one or more Copilot canvases are expected to run at the same
// time, possibly on different cookbooks. A single shared file ("last started wins")
// could route a draft to the wrong live app, and stopping one instance removed the
// file the other still needed. Now each instance:
// - picks a random, non-secret instance id (surface + 12 hex characters) and only
//   ever writes, rewrites or deletes the file with its own id;
// - records its cookbook folder in the file, so the user or assistant can pick the
//   right one, and answers GET instance plus an optional X-Open-Sauce-Instance header
//   check so a request aimed at one instance can never land in another;
// - on start, removes files of instances whose process no longer exists (crash or
//   kill -9). Files of live processes are never touched; with pid reuse a stale file
//   can survive, which is harmless because its port and token are dead.
// Rejected: a shared registry file with a lock (more failure modes than one file per
// instance), keeping the first instance as the owner (same misrouting, reversed).
// Rejected: a fixed port or token (other users' processes could guess or squat it),
// an MCP server bundled with the app (ties it to one client), hosted endpoints
// (cookbook data would leave the machine).
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { APP_NAME, InputError, RECIPE_ID } from "./model.mjs";
import { AGENT_OPERATIONS, DRAFT_SCHEMA } from "./drafts.mjs";
import { configPath } from "./config.mjs";
import { writeFileAtomic } from "./fsutil.mjs";

const MAX_JSON = 2 * 1024 * 1024;

const INSTANCE_ID = /^(standalone|canvas)-[0-9a-f]{12}$/;

/** Folder holding one endpoint file per running instance. */
export function agentDir(env = process.env) {
  return env.OPEN_SAUCE_AGENT_DIR || join(dirname(configPath(env)), "agents");
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown: keep the file
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function readEndpoints(dir) {
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || !INSTANCE_ID.test(name.slice(0, -5))) continue;
    const file = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record.instanceId === name.slice(0, -5)) result.push({ file, record });
    } catch { /* unreadable or vanished: ignore, never delete what we cannot read */ }
  }
  return result;
}

/** Running instances without their tokens, for the help page. */
export function listInstances(env = process.env) {
  return readEndpoints(agentDir(env))
    .filter(({ record }) => processAlive(record.pid))
    .map(({ file, record }) => ({ instanceId: record.instanceId, surface: record.surface, cookbook: record.cookbook ?? null, startedAt: record.startedAt, file }));
}

/** Removes endpoint files whose process is gone. Safe to run concurrently: rm is idempotent and live files are skipped. */
export function pruneDeadEndpoints(env = process.env) {
  const removed = [];
  for (const { file, record } of readEndpoints(agentDir(env))) {
    if (!processAlive(record.pid)) { rmSync(file, { force: true }); removed.push(record.instanceId); }
  }
  return removed;
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new InputError("Send JSON with Content-Type: application/json.", 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON) throw new InputError("The draft is too large (limit 2 MB).", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new InputError("The request body is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("A JSON object is required.");
  return value;
}

export async function startAgentServer({ runtime, env = process.env, surface = "standalone", port = 0, onError = console.error }) {
  if (!["standalone", "canvas"].includes(surface)) throw new Error(`Unknown surface ${surface}.`);
  const token = randomBytes(32).toString("hex");
  const dir = agentDir(env);
  let instanceId;
  let file;
  do {
    instanceId = `${surface}-${randomBytes(6).toString("hex")}`;
    file = join(dir, `${instanceId}.json`);
  } while (existsSync(file));
  const expected = Buffer.from(`Bearer ${token}`);
  let origin;

  const describe = () => ({ app: APP_NAME, instanceId, surface, cookbook: runtime.cookbook?.dir ?? null, pid: process.pid });

  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const json = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value, null, 2));
    };
    try {
      if (request.headers.host !== new URL(origin).host) throw new InputError("Unexpected Host header.", 403);
      // Agents are command-line programs. Requests carrying a browser Origin or a cross-site
      // marker are refused. A web page also cannot send the Authorization header without a
      // CORS preflight, which this server never approves. (Node's fetch sends Sec-Fetch-Mode,
      // so that header alone is not treated as a browser.)
      if (request.headers.origin !== undefined || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "none")) {
        throw new InputError("Browser requests are not allowed on the agent interface.", 403);
      }
      const given = Buffer.from(request.headers.authorization ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        throw new InputError(`Missing or invalid agent token. Each running ${APP_NAME} has its own endpoint file in ${dir}; read the token from the file of the instance you want and send it as "Authorization: Bearer <token>".`, 401);
      }
      const wanted = request.headers["x-open-sauce-instance"];
      if (wanted !== undefined && wanted !== instanceId) {
        throw new InputError(`This is ${APP_NAME} instance ${instanceId}, not ${String(wanted).slice(0, 40)}. Nothing was changed; use the address and token from the endpoint file of the instance you want.`, 409);
      }
      const url = new URL(request.url, origin);
      if (url.search) throw new InputError("Query parameters are not supported.", 400);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "agent" || parts[1] !== "v1") throw new InputError("Not found. See GET /agent/v1/schema.", 404);
      const [resource, id, extra] = parts.slice(2);

      if (request.method === "GET") {
        if (resource === "instance" && !id) return json(describe());
        if (resource === "schema" && !id) return json({ app: APP_NAME, version: 1, operations: AGENT_OPERATIONS, schemas: { draft: DRAFT_SCHEMA } });
        const cookbook = runtime.requireCookbook();
        if (resource === "recipes" && !id) {
          const { recipes } = cookbook.listRecipes();
          const names = new Map(cookbook.readCategories().categories.map((category) => [category.id, category.name]));
          return json({ recipes: recipes.map((recipe) => ({ id: recipe.id, title: recipe.title, categories: recipe.categoryIds.map((categoryId) => names.get(categoryId)).filter(Boolean), currentSnapshotId: recipe.currentId })) });
        }
        if (resource === "recipes" && id && !extra) {
          if (!RECIPE_ID.test(id)) throw new InputError("Unknown recipe.", 404);
          const doc = cookbook.getRecipe(id);
          const current = doc.snapshots.find((snapshot) => snapshot.id === doc.current);
          return json({ recipeId: doc.id, snapshotId: current.id, recipe: { ...current.content, photos: [] }, photoCount: current.content.photos.length });
        }
        if (resource === "categories" && !id) return json({ categories: cookbook.readCategories().categories.map((category) => category.name) });
        throw new InputError("Not found. See GET /agent/v1/schema.", 404);
      }
      if (request.method !== "POST") throw new InputError("Method not allowed.", 405);
      if (resource !== "drafts" || id) throw new InputError("Not found. See GET /agent/v1/schema.", 404);
      const draft = runtime.submitDraft(await readJson(request), { source: "agent" });
      return json({
        draftId: draft.id,
        status: "in_review",
        instance: { id: instanceId, cookbook: runtime.cookbook?.dir ?? null },
        diagramErrors: draft.diagramErrors.map((error) => error.message),
        unmatchedCategories: draft.unmatchedCategories,
        note: `The draft is waiting in the review area of ${APP_NAME}. Nothing was saved. The user reviews it, can correct anything and saves it.`,
      }, 202);
    } catch (error) {
      if (!(error instanceof InputError)) onError(error);
      if (response.headersSent) return response.destroy();
      if (error instanceof InputError) json({ error: error.message }, error.status);
      else json({ error: "Something went wrong. Nothing was saved." }, 500);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  const startedAt = new Date().toISOString();
  let closed = false;
  const write = () => {
    if (closed) return;
    const record = { app: APP_NAME, instanceId, surface, cookbook: runtime.cookbook?.dir ?? null, url: `${origin}/agent/v1/`, token, pid: process.pid, startedAt };
    writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`); // created with mode 0600
    chmodSync(file, 0o600);
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    pruneDeadEndpoints(env);
    write();
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  return {
    origin,
    file,
    dir,
    instanceId,
    token,
    describe,
    /** Rewrites this instance's own file, for example after the cookbook folder was chosen. */
    update: write,
    close: async () => {
      closed = true;
      // The file name is unique to this instance; the token check is a second guard.
      try { if (JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file, { force: true }); } catch { /* already gone */ }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
