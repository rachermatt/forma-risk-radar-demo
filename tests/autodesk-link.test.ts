import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAutodeskDeepLink } from "../src/lib/http/autodesk-link";

test("Autodesk deep links require an allowlisted HTTPS host", () => {
  assert.equal(
    normalizeAutodeskDeepLink("https://acc.autodesk.com/build/projects/example#private-fragment"),
    "https://acc.autodesk.com/build/projects/example",
  );
  assert.equal(normalizeAutodeskDeepLink("http://acc.autodesk.com/build/projects/example"), null);
  assert.equal(normalizeAutodeskDeepLink("javascript:alert(1)"), null);
  assert.equal(normalizeAutodeskDeepLink("https://acc.autodesk.com.evil.example/build"), null);
  assert.equal(normalizeAutodeskDeepLink("https://user:secret@acc.autodesk.com/build"), null);
  assert.equal(normalizeAutodeskDeepLink("https://example.com/redirect?to=acc.autodesk.com"), null);
});
