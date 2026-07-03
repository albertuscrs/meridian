/**
 * Shared JSON file store — atomic writes + corrupt-file protection.
 *
 * Every persistent JSON file in the repo (state.json, lessons.json, user-config.json, ...)
 * should be written through atomicWriteJson and read through readJsonSafe:
 * - atomicWriteJson writes to `<file>.tmp` then renames, so a crash mid-write can never
 *   leave a half-written file behind.
 * - readJsonSafe never lets a corrupt file be silently replaced: the broken original is
 *   copied to `<file>.corrupt-<timestamp>` before the fallback is returned, so data can
 *   be recovered by hand.
 */

import fs from "fs";
import { log } from "./logger.js";

export function atomicWriteJson(filePath, data, { pretty = 2 } = {}) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, pretty));
  fs.renameSync(tmpPath, filePath);
}

export function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.copyFileSync(filePath, backupPath);
      log("store_error", `Corrupt JSON at ${filePath}: ${err.message} — original preserved at ${backupPath}`);
    } catch (backupErr) {
      log("store_error", `Corrupt JSON at ${filePath}: ${err.message} — backup also failed: ${backupErr.message}`);
    }
    return fallback;
  }
}
