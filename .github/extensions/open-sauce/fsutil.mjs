import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

/** Write to a temp file in the same folder, fsync, then rename over the target. */
export function writeFileAtomic(path, data) {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
  try {
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* directory fsync is best effort on some platforms */ }
}
