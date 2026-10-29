import { createTempDir, removeTempDir } from "../../test/support/temp-dir.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { TokenStore } from "../auth/token-store.js";
import { runTokenCli } from "./tokens-core.js";

function run(args: string[], store: TokenStore) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runTokenCli(args, store, { out: (l) => out.push(l), err: (l) => err.push(l) }, { mcpUrl: "https://ddns.s13e.net/mcp" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("token CLI: create / list / revoke", () => {
  const dir = createTempDir("token-cli-test-");
  const store = new TokenStore(join(dir, "tokens.sqlite"));
  try {
    const api = run(["create", "--name", "claude-code", "--purpose", "api"], store);
    assert.equal(api.code, 0);
    const token = api.out.match(/ocrmcp_api_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(token, "the token is printed once on create");
    assert.match(api.out, /README\.md.*静的 API トークンの使い方/);
    assert.doesNotMatch(api.out, /claude mcp add|Cursor \(mcp\.json\)|OCR_MCP_TOKEN|https:\/\//);
    assert.equal(store.verify(token!, "api")?.name, "claude-code");

    const login = run(["create", "--name", "owner", "--purpose", "login", "--expires-in-days", "30"], store);
    assert.equal(login.code, 0);
    assert.match(login.out, /ocrmcp_login_/);
    assert.match(login.out, /同意画面/);

    const list = run(["list"], store);
    assert.equal(list.code, 0);
    assert.match(list.out, /claude-code\s+api\s+ocr:read\s+active/);
    assert.match(list.out, /owner\s+login\s+-\s+active/);
    assert.ok(!list.out.includes(token!), "list never prints tokens");

    const write = run(["create", "--name", "writer", "--purpose", "api", "--scope", "ocr:write"], store);
    assert.match(write.out, /scope=ocr:read,ocr:write/);

    assert.equal(run(["revoke", "--name", "claude-code"], store).code, 0);
    assert.equal(store.verify(token!, "api"), undefined);
    assert.equal(run(["revoke", "--name", "claude-code"], store).code, 1);
    assert.match(run(["list"], store).out, /claude-code\s+api\s+ocr:read\s+revoked/);
  } finally { store.close(); removeTempDir(dir); }
});

test("token CLI: usage errors and failures use distinct exit codes", () => {
  const dir = createTempDir("token-cli-test-");
  const store = new TokenStore(join(dir, "tokens.sqlite"));
  try {
    assert.equal(run([], store).code, 2);
    assert.equal(run(["help"], store).code, 0);
    assert.equal(run(["bogus"], store).code, 2);
    assert.equal(run(["create", "--purpose", "api"], store).code, 2);
    assert.equal(run(["create", "--name", "x", "--purpose", "root"], store).code, 2);
    assert.equal(run(["create", "--name", "x", "--purpose", "api", "--wat"], store).code, 2);
    assert.equal(run(["revoke"], store).code, 2);
    assert.equal(run(["create", "--name", "bad name", "--purpose", "api"], store).code, 1);
    assert.equal(run(["create", "--name", "x", "--purpose", "api", "--scope", "admin"], store).code, 1);
    run(["create", "--name", "dup", "--purpose", "api"], store);
    const dup = run(["create", "--name", "dup", "--purpose", "api"], store);
    assert.equal(dup.code, 1);
    assert.match(dup.err, /already exists/);
  } finally { store.close(); removeTempDir(dir); }
});
