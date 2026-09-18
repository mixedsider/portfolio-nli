import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { sha256 } from "./qwen-verification-proof.mjs";

// Local operational trust, not a cryptographic signature. Never follow a receipt/report symlink or FIFO.
export async function readProofFile(path, limit = 1048576) {
  if (typeof path !== "string" || !path) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || (info.mode & 0o022) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) return null;
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead > limit || bytesRead !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs) return null;
    const data = bytes.subarray(0, bytesRead);
    const value = JSON.parse(data.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { value, digest: sha256(data) };
  } catch { return null; }
  finally { await handle?.close(); }
}
