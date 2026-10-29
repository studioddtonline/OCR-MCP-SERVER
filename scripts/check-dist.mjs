import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const root = "dist";
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) await walk(path);
    else files.push(relative(root, path).split(sep).join("/"));
  }
}
await walk(root);
const forbiddenBasenames = new Set([
  "oauth-kit.js",
  "ocr-fixture.js",
  "temp-dir.js",
  "http-server.js",
  "test-kit.js",
]);
const forbidden = files.filter((file) =>
  /(?:^|\/)test\//.test(file) ||
  /\.test\.(?:js|mjs|cjs)$/.test(file) ||
  forbiddenBasenames.has(file.slice(file.lastIndexOf("/") + 1))
);
const required = ["index.js", "cli/tokens.js"];
const missing = required.filter((file) => !files.includes(file));
if (forbidden.length || missing.length) {
  if (forbidden.length) console.error("Forbidden test/support files in dist:", forbidden.join(", "));
  if (missing.length) console.error("Required runtime entrypoints missing from dist:", missing.join(", "));
  process.exitCode = 1;
} else {
  console.log(`dist check passed (${files.length} runtime files; no tests or test-support helpers included)`);
}
