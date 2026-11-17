import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { FileLock, machineId, ownerState, processStart } from "../.github/extensions/open-sauce/lock.mjs";
import { Cookbook, LOCK_FILE } from "../.github/extensions/open-sauce/store.mjs";
import { content, I, ing, scratch, step } from "./helpers.mjs";

const WORKER = new URL("./fixtures/lock-worker.mjs", import.meta.url).pathname;
const busy = (promise, reason) => assert.rejects(promise, (error) => error.status === 423 && error.details?.reason === reason);

function run(args) {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  return { child, exited };
}

async function waitFor(path) {
  for (let i = 0; i < 500 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(path), `${path} did not appear`);
}

async function deadOwnerLock(path) {
  const { exited } = run(["crash", path]);
  assert.equal((await exited).code, 0);
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(ownerState(record).state, "dead");
  return record;
}

const record = (extra) => ({ app: "open-sauce", token: "f".repeat(32), host: hostname(), machineId: machineId(), createdAt: new Date().toISOString(), ...extra });

test("a live owner is never displaced, even when its lock is years old", async (t) => {
  const dir = scratch(t, "lock-live");
  const path = join(dir, LOCK_FILE);
  const { child, exited } = run(["hold", path, join(dir, "ready")]);
  t.after(() => child.kill());
  await waitFor(join(dir, "ready"));
  const before = readFileSync(path, "utf8");
  assert.match(before, /2001-01-01/);

  const waiter = new FileLock(path, { timeoutMs: 300 });
  await busy(waiter.acquire(), "running");
  assert.equal(readFileSync(path, "utf8"), before, "the live owner's lock is untouched");

  // Once the owner is gone, its leftover lock is reclaimed.
  child.kill("SIGKILL");
  await exited;
  const handle = await new FileLock(path, { timeoutMs: 2000 }).acquire();
  assert.ok(handle.token);
});

test("this process's own lock is live, so a second writer waits instead of stealing it", async (t) => {
  const path = join(scratch(t, "lock-self"), LOCK_FILE);
  const first = new FileLock(path, { timeoutMs: 200 });
  const handle = await first.acquire();
  await busy(new FileLock(path, { timeoutMs: 200 }).acquire(), "this-process");
  assert.ok(first.release(handle));
  assert.ok(!existsSync(path));
});

test("a lock from a dead process is reclaimed", async (t) => {
  const path = join(scratch(t, "lock-dead"), LOCK_FILE);
  const dead = await deadOwnerLock(path);
  const lock = new FileLock(path, { timeoutMs: 2000 });
  const handle = await lock.acquire();
  assert.notEqual(handle.token, dead.token);
  assert.ok(lock.isHeld(handle));
});

test("a reused pid (same number, different process start) counts as dead", { skip: !processStart(process.pid) && "ps is unavailable" }, async (t) => {
  const path = join(scratch(t, "lock-reuse"), LOCK_FILE);
  writeFileSync(path, JSON.stringify(record({ pid: process.pid, procStart: "Thu Jan 1 00:00:00 1970" })));
  assert.deepEqual(ownerState(JSON.parse(readFileSync(path, "utf8"))), { state: "dead", reason: "pid-reused" });
  await new FileLock(path, { timeoutMs: 1000 }).acquire();
});

test("locks from another machine and unreadable locks are never reclaimed automatically", async (t) => {
  const dir = scratch(t, "lock-unknown");
  const path = join(dir, LOCK_FILE);
  const foreign = JSON.stringify(record({ pid: 1234, host: "kitchen-laptop", machineId: "another-machine", createdAt: "2001-01-01T00:00:00.000Z" }));
  writeFileSync(path, foreign);
  await assert.rejects(new FileLock(path, { timeoutMs: 150 }).acquire(), (error) => error.status === 423 && /kitchen-laptop/.test(error.message) && error.message.includes(path));
  assert.equal(readFileSync(path, "utf8"), foreign);

  writeFileSync(path, "{");
  await busy(new FileLock(path, { timeoutMs: 150 }).acquire(), "unreadable");
  assert.equal(readFileSync(path, "utf8"), "{");
});

test("competing recovery: many processes racing for a dead owner's lock never overlap", async (t) => {
  const dir = scratch(t, "lock-race");
  const path = join(dir, LOCK_FILE);
  await deadOwnerLock(path);
  writeFileSync(join(dir, "counter"), "0");
  const workers = Array.from({ length: 6 }, () => run(["count", path, dir, "8"]));
  const results = await Promise.all(workers.map((worker) => worker.exited));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(dir, "counter"), "utf8"), "48", "every increment survived, none overlapped");
  assert.deepEqual(readdirSync(dir).sort(), ["counter"], "no lock, recovery marker or temp file is left behind");
});

test("a recovery marker left by a crashed recoverer blocks with instructions instead of guessing", async (t) => {
  const path = join(scratch(t, "lock-marker"), LOCK_FILE);
  const dead = await deadOwnerLock(path);
  const marker = await deadOwnerLock(`${path}.recover`);
  await assert.rejects(new FileLock(path, { timeoutMs: 150 }).acquire(), (error) => error.status === 423 && error.details.recoveryFile === `${path}.recover`);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).token, dead.token, "the dead lock stays until the marker is resolved");
  assert.equal(JSON.parse(readFileSync(`${path}.recover`, "utf8")).token, marker.token);
});

test("release never deletes a lock that now belongs to someone else, and writes stop when the lock is lost", async (t) => {
  const book = Cookbook.open(join(scratch(t, "lock-store"), "book"), { create: true });
  const { recipe } = await book.createRecipe({ content: content([ing("i1", "Flour", 100)], [step("a1", "Bake", [I("i1")])], { title: "Bread" }) });
  const lockPath = join(book.dir, LOCK_FILE);
  const intruder = JSON.stringify(record({ pid: process.pid, procStart: processStart(process.pid) }));
  const recipeFile = join(book.dir, "recipes", `${recipe.id}.json`);
  const before = readFileSync(recipeFile, "utf8");

  await book.withLock(async () => {
    writeFileSync(lockPath, intruder);
    assert.throws(() => book.assertLockHeld(), (error) => error.status === 423);
  });
  assert.equal(readFileSync(lockPath, "utf8"), intruder, "the other owner's lock was left in place");
  assert.equal(readFileSync(recipeFile, "utf8"), before);

  // While that live owner holds the lock, saves wait and then fail with 423 without writing anything.
  const waiting = new Cookbook(book.dir, { lockTimeoutMs: 150 });
  await assert.rejects(waiting.setCurrent(recipe.id, { expectedVersion: 1, snapshotId: recipe.current }), (error) => error.status === 423);
  assert.equal(readFileSync(recipeFile, "utf8"), before);
});
