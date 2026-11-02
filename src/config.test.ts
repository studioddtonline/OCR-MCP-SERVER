import { createTempDir, removeTempDir } from "../test/support/temp-dir.js";
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config/load.js";

function withConfig(config: unknown, run: () => void) {
  const dir = createTempDir("ocr-mcp-config-test-");
  const file = join(dir, "config.json");
  const previous = process.env.MCP_CONFIG_PATH;
  try {
    writeFileSync(file, JSON.stringify(config));
    process.env.MCP_CONFIG_PATH = file;
    run();
  } finally {
    if (previous === undefined) delete process.env.MCP_CONFIG_PATH;
    else process.env.MCP_CONFIG_PATH = previous;
    removeTempDir(dir);
  }
}

const base = {
  server: { host: "127.0.0.1", port: 3001, publicBaseUrl: "https://ddns.s13e.net", mcpPath: "/mcp" },
  database: { path: "/tmp/ocr.sqlite" },
  search: {}
};


test("OCR writes default to disabled and can only be enabled with OAuth authentication", () => {
  withConfig({ ...base, auth: { mode: "none" } }, () => {
    assert.deepEqual(loadConfig().ocrWrite, { enabled: false });
  });
  withConfig({ ...base, auth: { mode: "none" }, ocrWrite: { enabled: true } }, () => {
    assert.throws(() => loadConfig(), /ocrWrite.enabled requires auth.mode to be "oauth"/);
  });
  withConfig({ ...oauthBase, ocrWrite: { enabled: true } }, () => {
    assert.equal(loadConfig().ocrWrite?.enabled, true);
  });
});

test("auth.mode must be explicitly configured", () => {
  withConfig(base, () => {
    assert.throws(() => loadConfig());
  });
});

const oauthBase = {
  ...base,
  auth: { mode: "oauth" },
  oauth: { databasePath: "/var/lib/ocr/oauth.sqlite" },
  staticTokens: { databasePath: "/var/lib/ocr/tokens.sqlite" }
};

test("allowedHosts defaults to the publicBaseUrl hostname", () => {
  withConfig(oauthBase, () => {
    assert.deepEqual(loadConfig().server.allowedHosts, ["ddns.s13e.net"]);
  });
});

test("allowedHosts is required when publicBaseUrl is absent", () => {
  const config = { ...base, server: { host: "127.0.0.1", port: 3001, mcpPath: "/mcp" }, auth: { mode: "none" } };
  withConfig(config, () => {
    assert.throws(() => loadConfig(), /server\.allowedHosts is required/);
  });
});

test("oauth mode requires staticTokens.databasePath (login tokens live there)", () => {
  const { staticTokens: _omit, ...withoutTokens } = oauthBase;
  withConfig(withoutTokens, () => {
    assert.throws(() => loadConfig(), /staticTokens\.databasePath is required/);
  });
});

test("staticTokens.databasePath must be absolute and a different file from the OCR and OAuth databases", () => {
  withConfig({ ...oauthBase, staticTokens: { databasePath: "relative/tokens.sqlite" } }, () => {
    assert.throws(() => loadConfig(), /must be an absolute path/);
  });
  withConfig({ ...oauthBase, staticTokens: { databasePath: "/var/lib/ocr/oauth.sqlite" } }, () => {
    assert.throws(() => loadConfig(), /three different files/);
  });
  withConfig({ ...oauthBase, staticTokens: { databasePath: "/tmp/ocr.sqlite" } }, () => {
    assert.throws(() => loadConfig(), /three different files/);
  });
  withConfig(oauthBase, () => {
    assert.equal(loadConfig().staticTokens?.databasePath, "/var/lib/ocr/tokens.sqlite");
  });
});

test("auth.mode none does not need staticTokens", () => {
  withConfig({ ...base, auth: { mode: "none" } }, () => {
    assert.equal(loadConfig().staticTokens, undefined);
  });
});

test("originalImages.rootPath must be an absolute path (a relative path would depend on the working directory)", () => {
  const withImages = (rootPath: string) => ({ ...base, auth: { mode: "none" }, server: { ...base.server, allowedHosts: ["ddns.s13e.net"] }, originalImages: { rootPath } });
  for (const bad of ["books", "./books", "../books", "relative/books"]) {
    withConfig(withImages(bad), () => {
      assert.throws(() => loadConfig(), /originalImages\.rootPath must be an absolute path/, bad);
    });
  }
  withConfig(withImages("/mnt/original-books"), () => {
    assert.equal(loadConfig().originalImages?.rootPath, "/mnt/original-books");
  });
  withConfig({ ...base, auth: { mode: "none" } }, () => {
    assert.equal(loadConfig().originalImages, undefined, "originalImages stays optional");
  });
});


test("Japanese search is disabled by default and requires separate absolute paths when enabled", () => {
  withConfig({ ...base, auth: { mode: "none" } }, () => {
    const config = loadConfig();
    assert.equal(config.japaneseSearch?.enabled, false);
    assert.equal(config.japaneseSearch?.busyTimeoutMs, 500);
    assert.equal(config.japaneseSearch?.maxLimit, 20);
  });

  const enabled = {
    ...base,
    auth: { mode: "none" },
    japaneseSearch: {
      enabled: true,
      indexPath: "/var/lib/ocr/japanese-search.sqlite",
      extensionPath: "/opt/ocr-mcp/native/sqlite-vaporetto/libsqlite_vaporetto.so",
    },
  };
  withConfig(enabled, () => {
    const config = loadConfig();
    assert.equal(config.japaneseSearch?.enabled, true);
    assert.equal(config.japaneseSearch?.maxLimit, 20);
  });
  withConfig({ ...enabled, japaneseSearch: { ...enabled.japaneseSearch, indexPath: "relative/index.sqlite" } }, () => {
    assert.throws(() => loadConfig(), /japaneseSearch\.indexPath must be an absolute path/);
  });
  withConfig({ ...enabled, japaneseSearch: { ...enabled.japaneseSearch, indexPath: base.database.path } }, () => {
    assert.throws(() => loadConfig(), /must be different from the OCR, OAuth and static-token database paths/);
  });
  withConfig({ ...enabled, japaneseSearch: { ...enabled.japaneseSearch, extensionPath: base.database.path } }, () => {
    assert.throws(() => loadConfig(), /japaneseSearch\.extensionPath must be different from all database paths/);
  });
});
