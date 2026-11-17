import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { APP_NAME, InputError } from "./model.mjs";
import { MAX_PHOTO_BYTES } from "./store.mjs";

const WEB = new URL("./web/", import.meta.url);
const STATIC = {
  "": ["web/index.html", "text/html"],
  "app.js": ["web/app.js", "text/javascript"],
  "styles.css": ["web/styles.css", "text/css"],
  "model.mjs": ["model.mjs", "text/javascript"],
};
const MAX_JSON = 2 * 1024 * 1024;

async function readBody(request, limit) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new InputError(`The request is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new InputError("Send JSON with Content-Type: application/json.", 415);
  let value;
  try { value = JSON.parse((await readBody(request, MAX_JSON)).toString("utf8")); }
  catch (error) { if (error instanceof InputError) throw error; throw new InputError("The request body is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("A JSON object is required.");
  return value;
}

/**
 * Loopback-only HTTP server. Every URL must start with a random per-panel
 * token (a capability URL); the Host header must be the loopback origin
 * (DNS rebinding) and mutations must not come from another origin (CSRF).
 */
export async function startServer({ runtime, port = 0, onError = console.error }) {
  const token = randomBytes(24).toString("hex");
  let origin;
  const tokenMatches = (candidate) => candidate.length === token.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(token));

  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const json = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host) throw new InputError("Unexpected Host header.", 403);
      const mutating = !["GET", "HEAD"].includes(request.method);
      if (request.headers.origin && request.headers.origin !== origin) throw new InputError("Cross-origin requests are not allowed.", 403);
      if (mutating && request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])) {
        throw new InputError("Cross-origin requests are not allowed.", 403);
      }
      const url = new URL(request.url, origin);
      const [, candidate = "", ...rest] = url.pathname.split("/");
      if (!tokenMatches(candidate)) throw new InputError("Missing or invalid access token. Open the app through the URL printed at startup or the Copilot canvas.", 401);
      if (!url.pathname.startsWith(`/${candidate}/`) && url.pathname !== `/${candidate}`) throw new InputError("Not found.", 404);
      if (url.pathname === `/${candidate}`) { response.writeHead(302, { Location: `/${candidate}/` }); return response.end(); }
      const path = rest.join("/");
      let parts;
      try { parts = path.split("/").map((part) => decodeURIComponent(part)); }
      catch { throw new InputError("Malformed URL.", 400); }

      if (request.method === "GET") {
        if (STATIC[path]) {
          const [file, type] = STATIC[path];
          const content = await readFile(new URL(`../${file}`, WEB));
          response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
          return response.end(content);
        }
        if (path === "api/info") return json({ appName: APP_NAME, ...runtime.info() });
        if (path === "api/drafts") return json({ drafts: runtime.drafts() });
        const cookbook = runtime.requireCookbook();
        if (path === "api/recipes") return json({ ...cookbook.listRecipes(), categories: cookbook.readCategories(), lastSavedAt: cookbook.lastSavedAt });
        if (parts[0] === "api" && parts[1] === "recipes" && parts.length === 3) return json({ recipe: cookbook.getRecipe(parts[2]) });
        if (path === "api/categories") return json(cookbook.readCategories());
        if (parts[0] === "api" && parts[1] === "photos" && parts.length === 3) {
          const photo = runtime.stagedPhoto(parts[2]) ?? cookbook.photo(parts[2]);
          response.writeHead(200, { "Content-Type": photo.mime, "Cache-Control": "private, max-age=86400, immutable" });
          return response.end(photo.bytes);
        }
        if (path === "api/sync/status") return json(await runtime.sync.status());
        throw new InputError("Not found.", 404);
      }
      if (request.method !== "POST") throw new InputError("Method not allowed.", 405);

      if (path === "api/photos") {
        runtime.checkCookbook(request.headers["x-open-sauce-cookbook"]);
        const type = request.headers["content-type"]?.split(";")[0].trim() ?? "";
        runtime.requireCookbook();
        const bytes = await readBody(request, MAX_PHOTO_BYTES + 1);
        // Staged in memory only; written to the cookbook folder when the entry is saved.
        return json(runtime.stagePhoto(bytes, type), 201);
      }
      if (path !== "api/setup") runtime.checkCookbook(request.headers["x-open-sauce-cookbook"]);
      const input = await readJson(request);
      if (path === "api/setup") return json(await runtime.setup(input));
      if (parts[0] === "api" && parts[1] === "drafts" && parts[3] === "dismiss" && parts.length === 4) {
        runtime.dismissDraft(parts[2]);
        return json({ drafts: runtime.drafts() });
      }
      if (parts[0] === "api" && parts[1] === "photos" && parts[3] === "discard" && parts.length === 4) {
        return json({ discarded: runtime.discardStagedPhoto(parts[2]) });
      }
      const cookbook = runtime.requireCookbook();
      const withPhotos = async (result) => { runtime.releasePublished(result.publishedPhotos); return result; };
      if (path === "api/recipes") return json(await withPhotos(await cookbook.createRecipe(input, { stagedPhotos: runtime.stagedPhotos })), 201);
      if (parts[0] === "api" && parts[1] === "recipes" && parts.length === 4) {
        const [, , id, verb] = parts;
        if (verb === "entries") return json(await withPhotos(await cookbook.saveEntry(id, input, { stagedPhotos: runtime.stagedPhotos })), 201);
        if (verb === "current") return json(await cookbook.setCurrent(id, input));
        if (verb === "categories") return json(await cookbook.setRecipeCategories(id, input));
      }
      if (path === "api/categories") return json(await cookbook.createCategory(input), 201);
      if (parts[0] === "api" && parts[1] === "categories" && parts.length === 4) {
        if (parts[3] === "rename") return json(await cookbook.renameCategory(parts[2], input));
        if (parts[3] === "delete") return json(await cookbook.deleteCategory(parts[2], input));
      }
      if (path === "api/sync") return json(await runtime.sync.sync());
      throw new InputError("Not found.", 404);
    } catch (error) {
      if (!(error instanceof InputError)) onError(error);
      if (response.headersSent) return response.destroy();
      if (error instanceof InputError) json({ error: error.message, ...(error.details ?? {}) }, error.status);
      else json({ error: "Something went wrong. Nothing was overwritten; check the log and try again." }, 500);
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/${token}/`,
    origin,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}
