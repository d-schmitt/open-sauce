// Cross-process lock for one cookbook folder.
//
// Protocol (see README "Locking"):
// - Acquire: write a complete owner record to a private temp file, then hard-link it
//   to the lock path. link() fails with EEXIST if the lock exists, so creation is
//   atomic and the lock file is never observed half-written. Filesystems without
//   hard links fall back to an exclusive create (O_EXCL) followed by a write.
// - Release: remove the lock only if it still carries our random token, so a
//   holder can never delete a lock it no longer owns.
// - Live owners are never displaced, however old the lock is. Waiters give up
//   after a timeout with HTTP 423 and leave the lock alone.
// - A lock is reclaimed only when its owner is provably dead: same machine, and the
//   pid no longer exists or now belongs to a different process (start time differs).
//   Locks from another machine, or unreadable locks, are never reclaimed
//   automatically, because their owner's liveness cannot be checked.
// - Competing recovery: removing a dead owner's lock happens only while holding a
//   separate recovery marker (created the same atomic way), after re-reading the
//   lock and confirming it still carries the dead owner's token. While the dead
//   lock exists nobody else can create a new one, and only the marker holder may
//   remove it, so the unlink cannot hit a fresh lock. The marker section is fully
//   synchronous (microseconds). A marker left by a crash inside that section is
//   reported, not reclaimed, because reclaiming it safely would need a further
//   lock of its own.
//
// Rejected alternatives: age-based expiry (can displace a slow live sync or save),
// rename-then-verify stealing (cannot be undone safely if the renamed lock turns
// out to be live), and OS advisory locks (flock/fcntl are not exposed by Node
// without native modules and are unreliable on network filesystems).
import { closeSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { APP_NAME, InputError } from "./model.mjs";

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/** Start time of a process as reported by ps, or null when it cannot be determined. */
export function processStart(pid) {
  if (process.platform === "win32") return null;
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    });
    const value = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    return value || null;
  } catch {
    return null;
  }
}

let selfStart;
const ownStart = () => (selfStart === undefined ? (selfStart = processStart(process.pid)) : selfStart);

let machine;
/** Best-effort stable machine id; hostnames can change (for example on macOS when the network changes). */
export function machineId() {
  if (machine !== undefined) return machine;
  machine = null;
  try {
    if (process.platform === "linux") machine = readFileSync("/etc/machine-id", "utf8").trim() || null;
    else if (process.platform === "darwin") {
      const out = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
      machine = out.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? null;
    }
  } catch { machine = null; }
  return machine;
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function ownerRecord(token) {
  return { app: "open-sauce", token, pid: process.pid, procStart: ownStart(), host: hostname(), machineId: machineId(), createdAt: new Date().toISOString() };
}

/**
 * Classify the owner of a lock record.
 * Returns { state: "alive" | "dead" | "unknown", reason }.
 */
export function ownerState(record) {
  if (!record || typeof record !== "object" || typeof record.token !== "string" || !Number.isInteger(record.pid) || record.pid <= 0) {
    return { state: "unknown", reason: "unreadable" };
  }
  const here = machineId();
  const sameMachine = record.machineId && here ? record.machineId === here : record.host === hostname();
  if (!sameMachine) return { state: "unknown", reason: "other-machine" };
  if (!pidExists(record.pid)) return { state: "dead", reason: "process-gone" };
  if (record.procStart) {
    const current = record.pid === process.pid ? ownStart() : processStart(record.pid);
    // The pid exists but belongs to a different process: the owner died and the pid was reused.
    if (current && current !== record.procStart) return { state: "dead", reason: "pid-reused" };
  }
  return { state: "alive", reason: record.pid === process.pid ? "this-process" : "running" };
}

function readRecord(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return { missing: true }; throw error; }
  try { return { record: JSON.parse(raw) }; } catch { return { record: null }; }
}

/** Atomically create `path` containing `record`. Returns false if it already exists. */
function createExclusive(path, record) {
  const data = `${JSON.stringify(record)}\n`;
  const temp = `${path}.${record.token}.tmp`;
  let fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, data); } finally { closeSync(fd); }
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    if (!NO_HARD_LINKS.has(error.code)) throw error;
  } finally {
    rmSync(temp, { force: true });
  }
  // Fallback without hard links: a reader may briefly see an empty file and treat it as unreadable (it waits, never reclaims).
  try { fd = openSync(path, "wx", 0o600); } catch (error) { if (error.code === "EEXIST") return false; throw error; }
  try { writeSync(fd, data); } finally { closeSync(fd); }
  return true;
}

/** Remove `path` only if it still carries `token`. Returns true if removed. */
function removeIfOwned(path, token) {
  const { record } = readRecord(path);
  if (record?.token !== token) return false;
  rmSync(path, { force: true });
  return true;
}

const describe = (record) => {
  if (!record) return "";
  const since = Date.parse(record.createdAt);
  return `${record.host ? ` on ${record.host}` : ""}${Number.isInteger(record.pid) ? ` (process ${record.pid})` : ""}${Number.isFinite(since) ? ` since ${new Date(since).toISOString()}` : ""}`;
};

export class FileLock {
  constructor(path, { timeoutMs = 5000, pollMs = 40 } = {}) {
    this.path = path;
    this.recoveryPath = `${path}.recover`;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
  }

  /** Wait for the lock. Resolves to a handle for release() and isHeld(). Rejects with 423 on timeout. */
  async acquire() {
    const token = randomBytes(16).toString("hex");
    const deadline = Date.now() + this.timeoutMs;
    let blocker = null;
    for (;;) {
      if (createExclusive(this.path, ownerRecord(token))) return { token };
      blocker = this.#tryRecover() ?? blocker;
      if (blocker?.recovered) continue;
      if (Date.now() >= deadline) throw this.#busyError(blocker);
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  isHeld(handle) {
    return Boolean(handle) && readRecord(this.path).record?.token === handle.token;
  }

  /** Release only our own lock. Returns false (and leaves the file alone) if someone else's lock is there. */
  release(handle) {
    return removeIfOwned(this.path, handle.token);
  }

  // Returns { recovered: true } after removing a dead owner's lock, otherwise a description of what blocks us.
  #tryRecover() {
    const first = readRecord(this.path);
    if (first.missing) return { recovered: true };
    const owner = ownerState(first.record);
    if (owner.state !== "dead") return { record: first.record, ...owner };

    const marker = ownerRecord(randomBytes(16).toString("hex"));
    if (!createExclusive(this.recoveryPath, marker)) {
      const { record } = readRecord(this.recoveryPath);
      return { record: first.record, state: "recovering", reason: "recovery-in-progress", marker: record };
    }
    try {
      // Re-check under the marker: only the dead owner's exact lock may be removed.
      const again = readRecord(this.path);
      if (again.missing) return { recovered: true };
      if (again.record?.token !== first.record.token || ownerState(again.record).state !== "dead") return { record: again.record, ...ownerState(again.record) };
      rmSync(this.path, { force: true });
      return { recovered: true };
    } finally {
      removeIfOwned(this.recoveryPath, marker.token);
    }
  }

  #busyError(blocker) {
    const details = { lockFile: this.path, reason: blocker?.reason ?? "busy", owner: blocker?.record ?? null };
    if (blocker?.reason === "recovery-in-progress" && blocker.marker && ownerState(blocker.marker).state === "dead") {
      details.recoveryFile = this.recoveryPath;
      return new InputError(`The cookbook is locked: a crashed ${APP_NAME} process left the recovery file ${this.recoveryPath}. No ${APP_NAME} process is using it. Delete that file and try again; your recipes are not affected.`, 423, details);
    }
    if (blocker?.reason === "other-machine") {
      return new InputError(`The cookbook is locked by ${APP_NAME}${describe(blocker.record)}. ${APP_NAME} cannot check whether that process is still running, so it never takes the lock over. If you are sure ${APP_NAME} is not saving or syncing there, delete ${this.path} and try again.`, 423, details);
    }
    if (blocker?.reason === "unreadable") {
      return new InputError(`The cookbook is locked, but the lock file ${this.path} cannot be read. If no ${APP_NAME} window is saving or syncing, delete that file and try again.`, 423, details);
    }
    return new InputError(`The cookbook is busy: another ${APP_NAME} window${describe(blocker?.record)} is saving or syncing. Try again in a moment. ${APP_NAME} never takes over a lock from a running process; if it stays busy, close that window.`, 423, details);
  }
}
