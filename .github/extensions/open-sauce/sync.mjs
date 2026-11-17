import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_NAME, InputError, PHOTO_ID, RECIPE_ID } from "./model.mjs";

/** Only these paths are ever staged. Nothing else in the folder is touched. */
export const MANAGED_ROOTS = ["cookbook.json", "categories.json", "recipes", "assets"];
const MANAGED_FILE = /^(cookbook\.json|categories\.json|recipes\/[a-z0-9][a-z0-9-]{0,79}\.json|assets\/[a-f0-9]{32}\.(png|jpg|webp))$/;
export const isManagedPath = (path) => MANAGED_FILE.test(path);

/** Argument-array process runner. Never uses a shell. */
export function runCommand(command, args, { cwd, env = {}, timeoutMs = 120000, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", LC_ALL: "C", ...env },
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code: signal ? 124 : code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
    child.stdin.end(input ?? "");
  });
}

// ---- destination privacy -------------------------------------------------
// Sync fails closed: every fetch and push URL of the remote (after git's own
// insteadOf/pushInsteadOf rewriting) must resolve to one github.com repository, and
// GitHub must confirm through gh that this exact repository is private. Anything else
// (other hosts, GitHub Enterprise, local paths, unknown SSH aliases, custom ssh
// commands, renamed repositories) is refused. There is deliberately no user override.

const REPO_PATH = /^\/?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_HOSTS = new Set(["github.com", "ssh.github.com"]);

/** Split a git remote URL into transport, host and owner/repo. Returns null for anything not recognised. */
export function parseRemoteUrl(url) {
  if (typeof url !== "string") return null;
  url = url.trim();
  let match = /^https:\/\/(?:[^@/]+@)?([^/:]+)(?::443)?(\/.*)$/i.exec(url);
  if (match) {
    const path = REPO_PATH.exec(match[2]);
    return path ? { transport: "https", host: match[1].toLowerCase(), owner: path[1], repo: path[2] } : null;
  }
  match = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?(\/.*)$/i.exec(url);
  if (match) {
    const path = REPO_PATH.exec(match[4]);
    return path ? { transport: "ssh", user: match[1] ?? null, host: match[2], port: match[3] ?? null, owner: path[1], repo: path[2] } : null;
  }
  if (url.includes("://")) return null; // git://, http://, file://, ext:: and other transports are not accepted
  match = /^(?:([^@/:]+)@)?([^@/:]+):(?!\/)(.+)$/.exec(url); // scp-like: [user@]host:owner/repo
  if (match) {
    const path = REPO_PATH.exec(match[3]);
    return path ? { transport: "ssh", user: match[1] ?? null, host: match[2], port: null, owner: path[1], repo: path[2] } : null;
  }
  return null;
}

/** Kept for callers that only need the github.com owner/repo of a plain URL. */
export function parseGitHubRemote(url) {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return null;
  if (parsed.transport === "https" ? parsed.host === "github.com" : GITHUB_SSH_HOSTS.has(parsed.host.toLowerCase())) return { owner: parsed.owner, repo: parsed.repo };
  return null;
}

/** Effective SSH host name for a host or ~/.ssh/config alias, as ssh itself would resolve it (no network). */
async function sshHostname(host, run) {
  if (host.startsWith("-")) return null;
  let result;
  try { result = await run("ssh", ["-G", "--", host], { timeoutMs: 10000 }); } catch { return null; }
  if (result.code !== 0) return null;
  return /^hostname\s+(\S+)\s*$/m.exec(result.stdout)?.[1]?.toLowerCase() ?? null;
}

/**
 * Resolve every URL to a github.com owner/repo. Local check only (git config and ssh -G), no network.
 * Throws a 409 InputError naming the URL that cannot be verified.
 */
export async function recognizeGitHubDestination({ urls, sshCommand, run = runCommand }) {
  if (!urls.length) throw new InputError("Sync is blocked: the remote has no URL.", 409);
  let identity = null;
  for (const url of urls) {
    const shown = url.replace(/\/\/[^@/]+@/, "//");
    const parsed = parseRemoteUrl(url);
    const refuse = (why) => new InputError(`Sync is blocked: ${APP_NAME} can only sync to a private repository on github.com whose privacy it can verify, and ${shown} ${why}. Family recipes are never sent to a destination that cannot be checked.`, 409, { unverifiedDestination: shown });
    if (!parsed) throw refuse("is not a recognised GitHub address");
    if (parsed.transport === "https") {
      if (parsed.host !== "github.com") throw refuse(`points to ${parsed.host}, not github.com`);
    } else {
      if (sshCommand) throw refuse("would be reached through a custom ssh command (core.sshCommand, GIT_SSH or GIT_SSH_COMMAND) that cannot be checked");
      if (parsed.port && !(parsed.port === "22" || (parsed.port === "443" && parsed.host === "ssh.github.com"))) throw refuse("uses an unexpected SSH port");
      const resolved = await sshHostname(parsed.host, run);
      if (!resolved || !GITHUB_SSH_HOSTS.has(resolved)) throw refuse(resolved ? `resolves to ${resolved}, not github.com` : "uses an SSH host that could not be resolved");
    }
    const current = { owner: parsed.owner, repo: parsed.repo };
    if (identity && `${identity.owner}/${identity.repo}`.toLowerCase() !== `${current.owner}/${current.repo}`.toLowerCase()) {
      throw refuse(`names a different repository than ${identity.owner}/${identity.repo} (fetch and push must go to the same private repository)`);
    }
    identity ??= current;
  }
  return identity;
}

/** Ask GitHub (through gh) about exactly this repository. Returns { nameWithOwner, visibility, isPrivate } or null. */
export async function githubRepoInfo({ owner, repo }, run = runCommand) {
  let result;
  try { result = await run("gh", ["repo", "view", `github.com/${owner}/${repo}`, "--json", "nameWithOwner,visibility,isPrivate"], { timeoutMs: 30000, env: { GH_HOST: "github.com" } }); }
  catch { return null; }
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

/** Full verification: local recognition plus GitHub's own answer. Fails closed. */
export async function verifyGitHubDestination({ urls, sshCommand, run = runCommand, repoInfo = githubRepoInfo }) {
  const identity = await recognizeGitHubDestination({ urls, sshCommand, run });
  const name = `${identity.owner}/${identity.repo}`;
  const info = await repoInfo(identity, run);
  if (!info || typeof info.nameWithOwner !== "string") {
    throw new InputError(`Sync is blocked: could not confirm that ${name} is a private GitHub repository. Install the GitHub CLI, sign in with \`gh auth login\` and try again.`, 409);
  }
  if (info.nameWithOwner.toLowerCase() !== name.toLowerCase()) {
    throw new InputError(`Sync is blocked: GitHub reports ${name} as ${info.nameWithOwner} (renamed or moved). Update the remote URL to the new name in a terminal, then sync again.`, 409);
  }
  if (info.visibility !== "PRIVATE" || info.isPrivate !== true) {
    throw new InputError(`Sync is blocked: ${name} is ${String(info.visibility ?? "not private").toLowerCase()} on GitHub. Family recipes and photos are only synced to a private repository.`, 409);
  }
  return identity;
}

const short = (text) => text.trim().split("\n").slice(-3).join(" ").slice(0, 400);

export class GitSync {
  // `destination` exists so tests can sync to local bare repositories. The app itself
  // (runtime.mjs) never passes it, and there is no environment or config override.
  constructor(cookbook, { run = runCommand, destination = { recognize: recognizeGitHubDestination, verify: verifyGitHubDestination } } = {}) {
    this.cookbook = cookbook;
    this.run = run;
    this.destination = destination;
    this.lastResult = null;
  }

  async #git(args, { allowFail = false, env } = {}) {
    let result;
    try { result = await this.run("git", args, { cwd: this.cookbook.dir, env }); }
    catch (error) { throw new InputError(`git could not be started (${error.message}). Install git to use Sync.`, 503); }
    if (result.code !== 0 && !allowFail) throw new InputError(`git ${args[0]} failed: ${short(result.stderr || result.stdout) || `exit code ${result.code}`}`, 409);
    return result;
  }

  /** Read-only inspection; throws an InputError explaining why sync is unavailable. */
  async #inspect() {
    const top = await this.#git(["rev-parse", "--show-toplevel"], { allowFail: true });
    if (top.code !== 0) throw new InputError("Sync is off: the cookbook folder is not a git repository. Sync is optional; see the README to set up a private repository.", 409);
    if (realpathSync(top.stdout.trim()) !== realpathSync(this.cookbook.dir)) {
      throw new InputError("Sync is off: the cookbook folder is inside another git repository instead of being its own repository.", 409);
    }
    const head = await this.#git(["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true });
    if (head.code !== 0) throw new InputError("Sync is blocked: the cookbook repository is in detached HEAD state. Check out a branch in a terminal first.", 409);
    const branch = head.stdout.trim();
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      const path = (await this.#git(["rev-parse", "--git-path", marker])).stdout.trim();
      if (existsSync(resolve(this.cookbook.dir, path))) {
        throw new InputError("Sync is blocked: a merge, rebase or cherry-pick is in progress in the cookbook repository. Finish or abort it in a terminal first.", 409);
      }
    }
    const configured = await this.#git(["config", "--get", `branch.${branch}.remote`], { allowFail: true });
    const mergeRef = await this.#git(["config", "--get", `branch.${branch}.merge`], { allowFail: true });
    let remote = configured.code === 0 ? configured.stdout.trim() : null;
    let remoteBranch = mergeRef.code === 0 ? mergeRef.stdout.trim().replace(/^refs\/heads\//, "") : branch;
    const hasUpstream = Boolean(remote) && remote !== ".";
    if (!hasUpstream) {
      const remotes = (await this.#git(["remote"])).stdout.split("\n").filter(Boolean);
      remote = remotes.length === 1 ? remotes[0] : null;
      remoteBranch = branch;
    }
    const url = remote ? (await this.#git(["remote", "get-url", remote])).stdout.trim() : null;
    return { branch, remote, remoteBranch, hasUpstream, url, trackingRef: remote ? `refs/remotes/${remote}/${remoteBranch}` : null };
  }

  async #counts(trackingRef) {
    const exists = await this.#git(["rev-parse", "--verify", "-q", trackingRef], { allowFail: true });
    const hasHead = (await this.#git(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).code === 0;
    if (exists.code !== 0) return { ahead: hasHead ? null : 0, behind: 0, remoteExists: false };
    if (!hasHead) return { ahead: 0, behind: null, remoteExists: true };
    const [ahead, behind] = (await this.#git(["rev-list", "--left-right", "--count", `HEAD...${trackingRef}`])).stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind, remoteExists: true };
  }

  async #pendingChanges() {
    const result = await this.#git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...MANAGED_ROOTS], { env: { GIT_OPTIONAL_LOCKS: "0" } });
    let referenced = null;
    try { referenced = this.#referencedPhotos(this.#recipeFiles()); } catch { /* sync itself reports the unreadable recipe */ }
    return result.stdout.split("\0").filter(Boolean).filter((entry) => !/^R|^C/.test(entry))
      .filter((entry) => !(referenced && entry.startsWith("?? assets/") && !referenced.has(entry.slice("?? assets/".length))))
      .map((entry) => entry.slice(3)).filter(isManagedPath).length;
  }

  /** Cheap status for the UI. Does not contact the remote. */
  async status() {
    let repo;
    try { repo = await this.#inspect(); }
    catch (error) {
      if (error instanceof InputError) return { available: false, reason: error.message, lastResult: this.lastResult };
      throw error;
    }
    if (repo.remote) {
      try { await this.destination.recognize(await this.#destinationInput(repo.remote)); }
      catch (error) {
        if (error instanceof InputError) return { available: false, reason: error.message, lastResult: this.lastResult };
        throw error;
      }
    }
    const counts = repo.trackingRef ? await this.#counts(repo.trackingRef) : { ahead: null, behind: null };
    return {
      available: true, branch: repo.branch, remote: repo.remote, remoteUrl: repo.url ? repo.url.replace(/\/\/[^@/]+@/, "//") : null,
      pendingChanges: await this.#pendingChanges(), ahead: counts.ahead, behind: counts.behind, lastResult: this.lastResult,
    };
  }

  /** All URLs git would use for this remote (fetch and push, after insteadOf rewriting) plus any custom ssh command. */
  async #destinationInput(remote) {
    const fetch = (await this.#git(["remote", "get-url", "--all", remote])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const push = (await this.#git(["remote", "get-url", "--push", "--all", remote])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const configured = await this.#git(["config", "--get", "core.sshCommand"], { allowFail: true });
    const sshCommand = (configured.code === 0 && configured.stdout.trim()) || process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || null;
    return { urls: [...new Set([...fetch, ...push])], sshCommand, run: this.run };
  }

  #sameUrls(before, after) {
    return before.urls.length === after.urls.length && before.urls.every((url, index) => url === after.urls[index]) && before.sshCommand === after.sshCommand;
  }

  #listDir(dir, test) {
    try { return readdirSync(join(this.cookbook.dir, dir)).filter(test).sort().map((name) => `${dir}/${name}`); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  #recipeFiles() {
    return this.#listDir("recipes", (name) => name.endsWith(".json") && RECIPE_ID.test(name.slice(0, -5)));
  }

  // Only photos a saved recipe refers to are staged. Photos are written to assets/ only
  // on Save, but a crash between the photo and recipe writes (or an upload by an older
  // version) can leave an unreferenced file; it stays local instead of being synced.
  #referencedPhotos(recipes) {
    const referenced = new Set();
    for (const path of recipes) {
      let doc;
      try { doc = JSON.parse(readFileSync(join(this.cookbook.dir, path), "utf8")); }
      catch { throw new InputError(`Sync is blocked: ${path} cannot be read as a recipe. Nothing was staged; fix or restore that file first.`, 409); }
      for (const snapshot of doc.snapshots ?? []) {
        for (const id of [...(snapshot.content?.photos ?? []), ...(snapshot.attempt?.photos ?? [])]) referenced.add(id);
      }
    }
    return referenced;
  }

  #managedFiles() {
    const files = [];
    for (const name of ["cookbook.json", "categories.json"]) if (existsSync(join(this.cookbook.dir, name))) files.push(name);
    const recipes = this.#recipeFiles();
    files.push(...recipes);
    const referenced = this.#referencedPhotos(recipes);
    files.push(...this.#listDir("assets", (name) => PHOTO_ID.test(name) && referenced.has(name)));
    return files;
  }

  /** Explicit, user-triggered sync: commit app files, fetch, fast-forward if possible, push. Never forces or resets. */
  async sync() {
    try {
      this.lastResult = { ...(await this.#syncLocked()), at: new Date().toISOString() };
    } catch (error) {
      this.lastResult = { outcome: "blocked", message: error instanceof InputError ? error.message : "Sync failed unexpectedly.", at: new Date().toISOString() };
      throw error;
    }
    return this.lastResult;
  }

  #syncLocked() {
    return this.cookbook.withLock(async () => {
      const repo = await this.#inspect();
      const staged = (await this.#git(["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
      const unrelated = staged.filter((path) => !isManagedPath(path));
      if (unrelated.length) {
        throw new InputError(`Sync is blocked: other files are already staged in the cookbook repository (${unrelated.slice(0, 5).join(", ")}${unrelated.length > 5 ? ", ..." : ""}). Commit or unstage them in a terminal first.`, 409);
      }
      // Verify the destination before anything is staged, committed, fetched or pushed.
      const destination = repo.remote ? await this.#destinationInput(repo.remote) : null;
      if (destination) await this.destination.verify(destination);
      const assertSameDestination = async () => {
        if (!this.#sameUrls(destination, await this.#destinationInput(repo.remote))) {
          throw new InputError("Sync is blocked: the remote address changed while syncing. Nothing was sent; sync again to verify the new address.", 409);
        }
      };

      this.cookbook.assertLockHeld();
      const files = this.#managedFiles();
      if (files.length) await this.#git(["add", "--", ...files]);
      const tracked = (await this.#git(["ls-files", "-z", "--", ...MANAGED_ROOTS])).stdout.split("\0").filter(Boolean);
      const deleted = tracked.filter((path) => isManagedPath(path) && !existsSync(join(this.cookbook.dir, path)));
      if (deleted.length) await this.#git(["rm", "--cached", "--quiet", "--", ...deleted]);
      let committed = false;
      if ((await this.#git(["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0) {
        await this.#git(["commit", "--quiet", "-m", "Update cookbook (Open Sauce sync)"]);
        committed = true;
      }
      if (!repo.remote) {
        return { outcome: committed ? "committed" : "up-to-date", message: committed ? "Changes were committed locally. Add a remote to sync them elsewhere." : "Nothing to sync, and no remote is configured." };
      }
      await assertSameDestination();
      await this.#git(["fetch", "--quiet", repo.remote]);
      if ((await this.#git(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).code !== 0) {
        return { outcome: "up-to-date", message: "Nothing to sync yet." };
      }
      const { ahead, behind, remoteExists } = await this.#counts(repo.trackingRef);
      if (remoteExists && ahead > 0 && behind > 0) {
        throw new InputError(`Sync is blocked: this cookbook and ${repo.remote} both have changes the other does not have (${ahead} local, ${behind} remote). ${APP_NAME} never merges, force-pushes or resets. Your local changes are committed and safe. Reconcile them in a terminal (for example with git pull --rebase in the cookbook folder), then sync again.`, 409, { diverged: true, ahead, behind });
      }
      if (remoteExists && behind > 0) {
        this.cookbook.assertLockHeld();
        await this.#git(["merge", "--ff-only", "--quiet", repo.trackingRef]);
        return { outcome: "pulled", message: `Updated with ${behind} change${behind === 1 ? "" : "s"} from ${repo.remote}.`, committed };
      }
      if (!remoteExists || ahead > 0) {
        const args = ["push", "--quiet", repo.remote, `HEAD:refs/heads/${repo.remoteBranch}`];
        if (!repo.hasUpstream) args.splice(1, 0, "--set-upstream");
        this.cookbook.assertLockHeld();
        await assertSameDestination();
        await this.#git(args);
        return { outcome: "pushed", message: `Pushed to ${repo.remote}/${repo.remoteBranch}.`, committed };
      }
      return { outcome: "up-to-date", message: "Already in sync.", committed };
    });
  }
}
