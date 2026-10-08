import assert from "node:assert/strict";
import { test } from "node:test";
import { securityHeaders } from "@aihot/contracts/security-headers";

test("HTTPS protection is applied only on HTTPS deployments; local development remains usable", () => {
  const secure = securityHeaders(true);
  assert.equal(secure["Strict-Transport-Security"], "max-age=15552000");
  assert.match(secure["Content-Security-Policy"]!, /upgrade-insecure-requests/);
  assert.equal(secure["X-Frame-Options"], "DENY");
  assert.equal(secure["X-Content-Type-Options"], "nosniff");
  const local = securityHeaders(false);
  assert.equal(local["Strict-Transport-Security"], undefined);
  assert.doesNotMatch(local["Content-Security-Policy"]!, /upgrade-insecure-requests/);
});
