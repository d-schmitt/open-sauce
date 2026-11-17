import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cookbook } from "../.github/extensions/open-sauce/store.mjs";
import { GitSync, parseGitHubRemote, recognizeGitHubDestination, runCommand, verifyGitHubDestination } from "../.github/extensions/open-sauce/sync.mjs";
import { A, I, PNG_1PX, content, ing, scratch, step } from "./helpers.mjs";

// Throwaway repositories live under tests/.tmp and are deleted after each test.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const bare = (dir, ...args) => git(dir, `--git-dir=${dir}`, ...args);
const identity = (cwd) => {
  git(cwd, "config", "user.name", "Test Cook");
  git(cwd, "config", "user.email", "cook@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
};
const recipe = (title) => content([ing("i1", "Flour", 100)], [step("a1", "Mix", [I("i1")]), step("a2", "Bake", [A("a1")])], { title });
const rejects = (promise, pattern) => assert.rejects(promise, (error) => error.status === 409 && pattern.test(error.message));

// Test-only destination: the real app verifies GitHub privacy and refuses local remotes.
// Here, exactly the throwaway bare repository of the test is accepted, nothing else.
const localOnly = (remote) => {
  const check = async ({ urls }) => {
    if (!urls.length || urls.some((url) => url !== remote)) throw Object.assign(new Error(`unexpected test remote ${urls}`), { status: 500 });
    return { owner: "test", repo: "local" };
  };
  return { recognize: check, verify: check };
};

/** Real git, scripted ssh -G and gh answers. */
const fakeTools = ({ hosts = {}, repo = null } = {}) => async (command, args, options) => {
  if (command === "ssh") return hosts[args.at(-1)] ? { code: 0, stdout: `user git\nhostname ${hosts[args.at(-1)]}\nport 22\n`, stderr: "" } : { code: 255, stdout: "", stderr: "unknown" };
  if (command === "gh") return repo ? { code: 0, stdout: JSON.stringify(repo), stderr: "" } : { code: 1, stdout: "", stderr: "not logged in" };
  return runCommand(command, args, options);
};

function setup(t) {
  const root = scratch(t, "sync");
  const remote = join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  const dirA = join(root, "device-a");
  const bookA = Cookbook.open(dirA, { create: true });
  git(dirA, "init", "--quiet", "-b", "main");
  identity(dirA);
  git(dirA, "remote", "add", "origin", remote);
  return { root, remote, bookA, syncA: new GitSync(bookA, { destination: localOnly(remote) }) };
}
async function secondDevice(root, remote) {
  const dirB = join(root, "device-b");
  git(root, "clone", "--quiet", remote, dirB);
  identity(dirB);
  const bookB = Cookbook.open(dirB);
  return { bookB, syncB: new GitSync(bookB, { destination: localOnly(remote) }) };
}

test("clean push commits only app-managed files", async (t) => {
  const { remote, bookA, syncA } = setup(t);
  writeFileSync(join(bookA.dir, "shopping-notes.txt"), "not part of the cookbook");
  await bookA.createRecipe({ content: recipe("Bread") });
  const before = await syncA.status();
  assert.equal(before.available, true);
  assert.ok(before.pendingChanges >= 3);
  const result = await syncA.sync();
  assert.equal(result.outcome, "pushed");
  const files = bare(remote, "ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(files.includes("categories.json") && files.includes("cookbook.json"));
  assert.ok(files.some((file) => /^recipes\/bread-[a-f0-9]{6}\.json$/.test(file)));
  assert.ok(!files.includes("shopping-notes.txt"), "unrelated files are never staged");
  assert.ok(!files.includes(".open-sauce.lock"));
  const after = await syncA.status();
  assert.equal(after.pendingChanges, 0);
  assert.equal(after.ahead, 0);
  assert.equal((await syncA.sync()).outcome, "up-to-date");
});

test("fast-forwards changes from another device", async (t) => {
  const { root, remote, bookA, syncA } = setup(t);
  await bookA.createRecipe({ content: recipe("Bread") });
  await syncA.sync();
  const { bookB, syncB } = await secondDevice(root, remote);
  const { recipe: created } = await bookB.createRecipe({ content: recipe("Soup") });
  assert.equal((await syncB.sync()).outcome, "pushed");
  const result = await syncA.sync();
  assert.equal(result.outcome, "pulled");
  assert.equal(bookA.getRecipe(created.id).snapshots[0].content.title, "Soup");
});

test("divergence is blocked and explained, never forced or reset", async (t) => {
  const { root, remote, bookA, syncA } = setup(t);
  await bookA.createRecipe({ content: recipe("Bread") });
  await syncA.sync();
  const { bookB, syncB } = await secondDevice(root, remote);
  await bookB.createRecipe({ content: recipe("Soup") });
  await syncB.sync();
  const { recipe: local } = await bookA.createRecipe({ content: recipe("Stew") });
  const remoteHead = bare(remote, "rev-parse", "main");
  await assert.rejects(syncA.sync(), (error) => error.status === 409 && error.details.diverged === true && /never merges, force-pushes or resets/.test(error.message));
  assert.equal(bare(remote, "rev-parse", "main"), remoteHead, "remote untouched");
  assert.ok(existsSync(join(bookA.dir, "recipes", `${local.id}.json`)), "local work kept");
  assert.match(git(bookA.dir, "log", "-1", "--format=%s"), /Open Sauce sync/, "local changes committed and safe");
  assert.equal(syncA.lastResult.outcome, "blocked");
});

test("refuses when unrelated files are already staged", async (t) => {
  const { bookA, syncA } = setup(t);
  writeFileSync(join(bookA.dir, "private.txt"), "staged by the user");
  git(bookA.dir, "add", "private.txt");
  await rejects(syncA.sync(), /other files are already staged.*private\.txt/);
  assert.equal(git(bookA.dir, "rev-list", "--all").length, 0, "nothing was committed");
});

test("refuses detached HEAD and a merge in progress", async (t) => {
  const { bookA, syncA } = setup(t);
  await syncA.sync();
  git(bookA.dir, "checkout", "--quiet", "--detach");
  await rejects(syncA.sync(), /detached HEAD/);
  git(bookA.dir, "checkout", "--quiet", "main");
  writeFileSync(join(git(bookA.dir, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), `${git(bookA.dir, "rev-parse", "HEAD")}\n`);
  await rejects(syncA.sync(), /merge, rebase or cherry-pick is in progress/);
});

const nothingSent = (bookA, remote) => {
  assert.equal(git(bookA.dir, "rev-list", "--all").length, 0, "nothing was committed");
  assert.equal(git(bookA.dir, "diff", "--cached", "--name-only"), "", "nothing was staged");
  assert.equal(bare(remote, "for-each-ref").length, 0, "nothing reached the remote");
};

test("the real app refuses any remote whose privacy it cannot verify, before staging or committing", async (t) => {
  const { remote, bookA } = setup(t);
  await bookA.createRecipe({ content: recipe("Bread") });
  const production = new GitSync(bookA); // no test injection: local bare remotes are not verifiable
  const status = await production.status();
  assert.equal(status.available, false);
  assert.match(status.reason, /not a recognised GitHub address/);
  await assert.rejects(production.sync(), (error) => error.status === 409 && error.details.unverifiedDestination === remote);
  nothingSent(bookA, remote);

  // A GitHub-looking URL that git rewrites (url.insteadOf) to somewhere else is judged by its real target.
  git(bookA.dir, "remote", "set-url", "origin", "https://github.com/example-family/open-sauce-files.git");
  git(bookA.dir, "config", `url.${remote}.insteadOf`, "https://github.com/example-family/open-sauce-files.git");
  await assert.rejects(new GitSync(bookA, { run: fakeTools({ repo: { nameWithOwner: "example-family/open-sauce-files", visibility: "PRIVATE", isPrivate: true } }) }).sync(), (error) => error.status === 409 && error.details.unverifiedDestination === remote);
  git(bookA.dir, "config", "--unset", `url.${remote}.insteadOf`);

  // A separate push URL must be verified too.
  git(bookA.dir, "remote", "set-url", "--push", "origin", "https://gitlab.example.com/family/open-sauce-files.git");
  await assert.rejects(new GitSync(bookA, { run: fakeTools({ repo: { nameWithOwner: "example-family/open-sauce-files", visibility: "PRIVATE", isPrivate: true } }) }).sync(), (error) => error.status === 409 && /gitlab\.example\.com/.test(error.message));
  nothingSent(bookA, remote);
});

test("GitHub privacy is confirmed through gh for the exact repository; public, internal, renamed or unknown are refused", async (t) => {
  const { remote, bookA } = setup(t);
  await bookA.createRecipe({ content: recipe("Bread") });
  git(bookA.dir, "remote", "set-url", "origin", "git@github.com:example-family/open-sauce-files.git");
  const hosts = { "github.com": "github.com" };
  const cases = [
    [{ nameWithOwner: "example-family/open-sauce-files", visibility: "PUBLIC", isPrivate: false }, /public on GitHub/],
    [{ nameWithOwner: "example-family/open-sauce-files", visibility: "INTERNAL", isPrivate: false }, /internal on GitHub/],
    [{ nameWithOwner: "someone-else/open-sauce-files", visibility: "PRIVATE", isPrivate: true }, /renamed or moved/],
    [null, /could not confirm/],
  ];
  for (const [repo, pattern] of cases) await rejects(new GitSync(bookA, { run: fakeTools({ hosts, repo }) }).sync(), pattern);
  nothingSent(bookA, remote);

  const calls = [];
  const run = async (command, args, options) => { calls.push([command, ...args]); return fakeTools({ hosts, repo: { nameWithOwner: "Example-Family/open-sauce-files", visibility: "PRIVATE", isPrivate: true } })(command, args, options); };
  assert.deepEqual(await verifyGitHubDestination({ urls: ["git@github.com:example-family/open-sauce-files.git"], run }), { owner: "example-family", repo: "open-sauce-files" });
  assert.ok(calls.some((call) => call.join(" ") === "gh repo view github.com/example-family/open-sauce-files --json nameWithOwner,visibility,isPrivate"));
});

test("SSH aliases are resolved like ssh does; unknown hosts, other hosts and custom ssh commands fail closed", async () => {
  const run = fakeTools({ hosts: { "github-family": "github.com", "github.com": "github.com", "gitlab.com": "gitlab.com" } });
  const recognize = (urls, sshCommand = null) => recognizeGitHubDestination({ urls, sshCommand, run });
  assert.deepEqual(await recognize(["github-family:example-family/open-sauce-files.git"]), { owner: "example-family", repo: "open-sauce-files" });
  assert.deepEqual(await recognize(["ssh://git@github.com/example-family/open-sauce-files.git", "https://github.com/Example-Family/open-sauce-files"]), { owner: "example-family", repo: "open-sauce-files" });
  const refused = async (urls, pattern, sshCommand) => assert.rejects(recognize(urls, sshCommand), (error) => error.status === 409 && pattern.test(error.message));
  await refused(["git@gitlab.com:family/open-sauce-files.git"], /resolves to gitlab\.com/);
  await refused(["git@unknown-alias:family/open-sauce-files.git"], /could not be resolved/);
  await refused(["https://github.example.com/family/open-sauce-files.git"], /not github\.com/);
  await refused(["git://github.com/family/open-sauce-files.git"], /not a recognised GitHub address/);
  await refused(["/srv/git/open-sauce-files.git"], /not a recognised GitHub address/);
  await refused(["git@github.com:family/open-sauce-files.git"], /custom ssh command/, "ssh -o Hostname=elsewhere");
  await refused(["git@github.com:family/a.git", "git@github.com:family/b.git"], /different repository/);
  await refused([], /no URL/);
  assert.deepEqual(parseGitHubRemote("git@github.com:me/open-sauce-files.git"), { owner: "me", repo: "open-sauce-files" });
  assert.equal(parseGitHubRemote("/srv/git/cookbook.git"), null);
});

test("sync is unavailable (not an error) when the folder is not its own git repository", async (t) => {
  const book = Cookbook.open(join(scratch(t, "nogit"), "book"), { create: true });
  const status = await new GitSync(book).status();
  assert.equal(status.available, false);
  assert.match(status.reason, /not a git repository|inside another git repository/);
});

test("only photos referenced by a saved recipe are synced; an orphan from an interrupted save stays local", async (t) => {
  const { remote, bookA, syncA } = setup(t);
  const id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png";
  const orphan = "cccccccccccccccccccccccccccccccc.png";
  await bookA.createRecipe({ content: { ...recipe("Bread"), photos: [id] } }, { stagedPhotos: new Map([[id, { bytes: PNG_1PX }]]) });
  writeFileSync(join(bookA.dir, "assets", orphan), PNG_1PX);
  assert.equal((await syncA.sync()).outcome, "pushed");
  const files = bare(remote, "ls-tree", "-r", "--name-only", "main").split("\n");
  assert.ok(files.includes(`assets/${id}`));
  assert.ok(!files.includes(`assets/${orphan}`));
  assert.equal((await syncA.status()).pendingChanges, 0, "the orphan is not reported as pending");
});
