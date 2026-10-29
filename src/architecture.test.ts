import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

function relativeImportSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) found.push(specifier);
  }
  return found;
}

function assertLayerHasNoImports(files: string[], forbiddenSegments: string[], layerName: string): void {
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      const rel = relative(SRC_ROOT, target).split(sep).join("/");
      for (const forbidden of forbiddenSegments) {
        assert.ok(
          !rel.startsWith(`${forbidden}/`) && rel !== forbidden,
          `${layerName} layer must not import ${rel} (from ${relative(SRC_ROOT, file)})`
        );
      }
    }
  }
}

test("feature modules stay independent of app, HTTP, MCP composition, and legacy data layer", () => {
  const featuresRoot = join(SRC_ROOT, "features");
  const featureFiles = typescriptFiles(featuresRoot);
  assert.ok(featureFiles.some((file) => file.endsWith("/features/ocr/repository.ts")));
  assert.ok(featureFiles.some((file) => file.endsWith("/features/original-images/repository.ts")));
  assertLayerHasNoImports(featureFiles, ["app", "http", "mcp", "data", "config", "auth"], "feature");
  assertLayerHasNoImports(typescriptFiles(join(featuresRoot, "ocr")), ["features/original-images"], "OCR feature");
  assertLayerHasNoImports(typescriptFiles(join(featuresRoot, "original-images")), ["features/ocr"], "original-image feature");

});

test("app composition does not depend on HTTP or MCP implementation details", () => {
  const appFiles = typescriptFiles(join(SRC_ROOT, "app"));
  assertLayerHasNoImports(appFiles, ["http", "mcp"], "app");
});

test("MCP composition does not reach back into HTTP or app layers", () => {
  const mcpFiles = typescriptFiles(join(SRC_ROOT, "mcp"));
  assertLayerHasNoImports(mcpFiles, ["http", "app"], "MCP composition");
});

test("HTTP layer does not depend directly on feature implementations", () => {
  const httpFiles = typescriptFiles(join(SRC_ROOT, "http"));
  assertLayerHasNoImports(httpFiles, ["features"], "HTTP");
});

test("config definitions remain independent of features and runtime layers", () => {
  const configFiles = typescriptFiles(join(SRC_ROOT, "config"));
  assertLayerHasNoImports(configFiles, ["features", "app", "http", "mcp"], "config");
});



test("feature modules cannot import any part of application config or authentication", () => {
  const featureFiles = typescriptFiles(join(SRC_ROOT, "features"));
  for (const file of featureFiles) {
    const source = readFileSync(file, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      const rel = relative(SRC_ROOT, target).split(sep).join("/");
      assert.ok(!rel.startsWith("config/") && rel !== "config", `feature must use narrow options, not config types: ${relative(SRC_ROOT, file)} -> ${rel}`);
      assert.ok(!rel.startsWith("auth/") && rel !== "auth", `feature must not depend on authentication: ${relative(SRC_ROOT, file)} -> ${rel}`);
    }
  }
});

function isReExportOnly(source: string): boolean {
  const uncommented = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .trim();
  if (!uncommented) return false;
  const statements = uncommented.split(";").map((statement) => statement.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((statement) =>
    /^export\s+(?:type\s+)?(?:\{[\s\S]*?\}|\*)\s+from\s+["'][^"']+["']$/.test(statement));
}

test("production source has no re-export-only compatibility shims", () => {
  for (const forbidden of ["config.ts", "errors.ts", "auth/oauth-http.ts"]) {
    assert.equal(existsSync(join(SRC_ROOT, forbidden)), false, `remove the compatibility shim src/${forbidden}`);
  }
  for (const file of typescriptFiles(SRC_ROOT)) {
    assert.equal(isReExportOnly(readFileSync(file, "utf8")), false,
      `production source must not contain a re-export-only shim: ${relative(SRC_ROOT, file)}`);
  }
});

test("production source has no relative-import cycles", () => {
  const files = typescriptFiles(SRC_ROOT);
  const known = new Set(files.map((file) => resolve(file)));
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const targets: string[] = [];
    for (const specifier of relativeImportSpecifiers(source)) {
      const candidate = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (known.has(candidate)) targets.push(candidate);
    }
    graph.set(resolve(file), targets);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (file: string): void => {
    state.set(file, 1);
    path.push(file);
    for (const target of graph.get(file) ?? []) {
      const targetState = state.get(target) ?? 0;
      if (targetState === 0) visit(target);
      else if (targetState === 1) {
        const start = path.indexOf(target);
        const cycle = [...path.slice(start), target].map((entry) => relative(SRC_ROOT, entry));
        assert.fail(`relative import cycle detected: ${cycle.join(" -> ")}`);
      }
    }
    path.pop();
    state.set(file, 2);
  };

  for (const file of graph.keys()) {
    if ((state.get(file) ?? 0) === 0) visit(file);
  }
});
