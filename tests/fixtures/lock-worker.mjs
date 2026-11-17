// Child process used by tests/lock.test.mjs. Modes:
//   hold <lockPath> <readyFile>          acquire, rewrite createdAt to 2001, signal ready, hold forever
//   crash <lockPath>                     acquire and exit without releasing (a dead owner)
//   count <lockPath> <dir> <rounds>      increment <dir>/counter under the lock, detecting overlap
import { readFileSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { FileLock } from "../../.github/extensions/open-sauce/lock.mjs";

const [mode, lockPath, arg1, arg2] = process.argv.slice(2);
const lock = new FileLock(lockPath, { timeoutMs: 20000, pollMs: 5 });

if (mode === "hold") {
  await lock.acquire();
  const record = JSON.parse(readFileSync(lockPath, "utf8"));
  writeFileSync(lockPath, JSON.stringify({ ...record, createdAt: "2001-01-01T00:00:00.000Z" }));
  writeFileSync(arg1, "ready");
  setInterval(() => {}, 1000);
} else if (mode === "crash") {
  await lock.acquire();
  process.exit(0);
} else if (mode === "count") {
  for (let round = 0; round < Number(arg2); round++) {
    const handle = await lock.acquire();
    closeSync(openSync(join(arg1, "inside"), "wx"));
    const value = Number(readFileSync(join(arg1, "counter"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    writeFileSync(join(arg1, "counter"), String(value + 1));
    rmSync(join(arg1, "inside"));
    if (!lock.release(handle)) throw new Error("lost the lock");
  }
}
