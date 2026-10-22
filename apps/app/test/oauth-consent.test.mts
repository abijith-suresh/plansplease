import assert from "node:assert/strict";
import { test } from "node:test";

import { consentRedirectUrl } from "../src/lib/oauth-consent.ts";
import { GET as loginRedirect } from "../src/routes/mcp/login.ts";

test("reads Better Auth's JSON redirect after consent", () => {
  const callback = "http://127.0.0.1:19876/mcp/oauth/callback?code=issued";
  assert.equal(consentRedirectUrl({ redirect: true, url: callback }), callback);
  assert.equal(consentRedirectUrl({ redirect_uri: callback }), callback);
  assert.equal(consentRedirectUrl({ redirect: false, url: callback }), undefined);
});

test("keeps the agent login redirect on the browser's origin", () => {
  const response = loginRedirect({
    request: new Request("http://app.example/mcp/login?client_id=agent&sig=signed"),
  });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/auth/login?oauth_query=client_id%3Dagent%26sig%3Dsigned"
  );
});
