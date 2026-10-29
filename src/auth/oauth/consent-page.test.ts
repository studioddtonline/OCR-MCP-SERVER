import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthzRequest } from "./types.js";
import { createPageRenderer, renderConsentPage } from "./consent-page.js";

const request: AuthzRequest = {
  client: {
    clientId: "client-id",
    clientName: `Example <img src=x onerror="alert('x')"> & Co`,
    redirectUris: ["https://callback.example/cb"],
    tokenEndpointAuthMethod: "none",
  },
  clientId: `client&<"id`,
  redirectUri: "https://callback.example/cb",
  challenge: `challenge&<"value`,
  state: `state&<"value`,
  requested: ["ocr:read", "ocr:write"],
};

test("consent page escapes user-controlled values and preserves the response status", async () => {
  const renderer = createPageRenderer("'self' https://callback.example");
  const response = renderConsentPage(
    renderer,
    request,
    "https://resource.example/mcp?a=1&b=<x>",
    `<script>alert("bad")</script>`,
    401,
  );
  const body = await response.text();

  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type") ?? "", /text\/html; charset=utf-8/);
  assert.match(response.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/callback\.example/);
  assert.match(body, /Example &lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt; &amp; Co/);
  assert.match(body, /client&amp;&lt;&quot;id/);
  assert.match(body, /challenge&amp;&lt;&quot;value/);
  assert.match(body, /state&amp;&lt;&quot;value/);
  assert.match(body, /https:\/\/resource\.example\/mcp\?a=1&amp;b=&lt;x&gt;/);
  assert.match(body, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>|<img src=x onerror=/);
  assert.match(body, /name="grant_scope" value="ocr:write"/);
});

test("consent page only offers optional scopes that were requested", async () => {
  const response = renderConsentPage(
    createPageRenderer("'self'"),
    { ...request, requested: ["ocr:read"] },
    "https://resource.example/mcp",
  );
  const body = await response.text();
  assert.match(body, /ocr:read/);
  assert.doesNotMatch(body, /name="grant_scope" value="ocr:write"/);
});
