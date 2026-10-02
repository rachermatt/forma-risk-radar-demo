import assert from "node:assert/strict";
import test from "node:test";
import { contiguousTrendSegments, stepAfterPath, trendTransitionCoverage } from "../src/components/risk-ui";

test("step-after geometry changes horizontally and then vertically", () => {
  const path = stepAfterPath([{ x: 0, y: 20 }, { x: 10, y: 20 }, { x: 20, y: 60 }]);
  assert.equal(path, "M 0.0,20.0 H 10.0 V 20.0 H 20.0 V 60.0");
  assert.doesNotMatch(path, /\bL\b/);
});

test("null observations split trend geometry into independent paths", () => {
  const segments = contiguousTrendSegments([{ x: 0, y: 20 }, null, { x: 20, y: 60 }]);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(stepAfterPath), ["M 0.0,20.0", "M 20.0,60.0"]);
});

test("a carried interval stays dashed when its destination is observed", () => {
  assert.deepEqual(
    trendTransitionCoverage(
      { forwardFilled: true, mixed: false },
      { forwardFilled: false, mixed: false },
    ),
    { horizontalCarried: true, verticalCarried: false },
  );
});
