import assert from "node:assert/strict";
import { test } from "node:test";
import { createCimdResolver } from "./cimd.js";

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const goodDocument = {
  client_id: CLIENT_ID,
  client_name: "Claude",
  redirect_uris: [CALLBACK],
  token_endpoint_auth_method: "none",
};

test("CIMD resolver shares an in-flight fetch for the same client ID", async () => {
  let calls = 0;
  const resolver = createCimdResolver({
    allowedHosts: ["claude.ai"],
    allowedRedirectUris: [CALLBACK],
    fetchImpl: (async () => {
      calls += 1;
      await Promise.resolve();
      return new Response(JSON.stringify(goodDocument), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const [first, second] = await Promise.all([resolver.resolve(CLIENT_ID), resolver.resolve(CLIENT_ID)]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
});

test("CIMD resolver briefly negative-caches failed metadata fetches", async () => {
  let calls = 0;
  const resolver = createCimdResolver({
    allowedHosts: ["claude.ai"],
    allowedRedirectUris: [CALLBACK],
    fetchImpl: (async () => {
      calls += 1;
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  });
  await assert.rejects(resolver.resolve(CLIENT_ID), /HTTP 404/);
  await assert.rejects(resolver.resolve(CLIENT_ID), /HTTP 404/);
  assert.equal(calls, 1);
});

test("CIMD resolver rejects a document larger than the byte limit while streaming", async () => {
  const resolver = createCimdResolver({
    allowedHosts: ["claude.ai"],
    allowedRedirectUris: [CALLBACK],
    fetchImpl: (async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(resolver.resolve(CLIENT_ID), /CIMD document too large/);
});
