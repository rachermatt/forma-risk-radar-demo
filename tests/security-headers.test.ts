import assert from "node:assert/strict";
import test from "node:test";
import { contentSecurityPolicy, securityHeaders } from "../src/lib/security-headers";

const NONCE = "ZGV0ZXJtaW5pc3RpYy10ZXN0LW5vbmNl";

test("production CSP is nonce-based and keeps browser data access same-origin", () => {
  const policy = contentSecurityPolicy(NONCE, true);
  const scriptPolicy = policy.split("; ").find((directive) => directive.startsWith("script-src"));
  assert.equal(scriptPolicy, `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`);
  assert.match(policy, new RegExp(`style-src-elem 'self' 'nonce-${NONCE}'`, "u"));
  assert.match(policy, /style-src-attr 'unsafe-inline'/u);
  assert.match(policy, /connect-src 'self'/u);
  assert.match(policy, /frame-ancestors 'none'/u);
  assert.match(policy, /form-action 'self'/u);
  assert.match(policy, /upgrade-insecure-requests/u);
  assert.doesNotMatch(scriptPolicy ?? "", /unsafe-inline|unsafe-eval/u);
});

test("companion headers enable transport, MIME, framing, and referrer controls", () => {
  const headers = securityHeaders(NONCE, true);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(headers["strict-transport-security"] ?? "", /max-age=63072000/u);
  assert.equal(securityHeaders(NONCE, false)["strict-transport-security"], undefined);
});

test("CSP refuses an injectable nonce", () => {
  assert.throws(() => contentSecurityPolicy("bad'; script-src *", true), TypeError);
});
