import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

// Child-only fixture filesystem: outside temporary parents are unavailable, even if
// the developer's machine happens to have them. Never touch those host directories.
const mkdtemp = fs.mkdtemp;
fs.mkdtemp = async (prefix, ...options) => {
  if (dirname(resolve(prefix)) !== resolve(tmpdir())) {
    throw Object.assign(new Error(`ENOENT: fixture temporary parent outside controlled os.tmpdir(): ${prefix}`),
      { code: "ENOENT" });
  }
  return mkdtemp(prefix, ...options);
};
syncBuiltinESMExports();
