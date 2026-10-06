import assert from "node:assert/strict";
import test from "node:test";
import { contiguousTrendSegments, stepAfterPath, TrendChart, trendTransitionCoverage } from "../src/components/risk-ui";
import type { FilledSeriesPoint } from "../src/lib/risk/metrics";

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

const chartPoints: readonly FilledSeriesPoint[] = [
  { date: "2026-08-10", value: 48, observed: true, forwardFilled: false, forwardFilledFrom: null, stale: false },
  { date: "2026-08-11", value: 51, observed: true, forwardFilled: false, forwardFilledFrom: null, stale: false },
];

test("responsive chart markers align with the data paths without inheriting an anisotropic scale", () => {
  for (const compact of [false, true]) {
    const chart = TrendChart({ points: chartPoints, label: "Responsive risk trend", compact });
    // Only data geometry may stretch; the outer viewport keeps r in pixels.
    assert.equal(chart.props.viewBox, undefined);
    const children = chart.props.children.flat(Infinity).filter(Boolean);
    const geometry = children.find((child: { type: string }) => child.type === "svg");
    const marker = children.find((child: { type: string }) => child.type === "circle");
    assert.equal(geometry.props.preserveAspectRatio, "none");
    assert.equal(typeof marker.props.r, "number");
    assert.match(marker.props.cx, /%$/);
    assert.match(marker.props.cy, /%$/);
    const [, , plotWidth, plotHeight] = geometry.props.viewBox.split(" ").map(Number);
    const paths = geometry.props.children.flat(Infinity).filter((child: { type?: string } | null) => child?.type === "path");
    const start = paths[0].props.d.match(/^M ([\d.]+),([\d.]+)/);
    assert.ok(start);
    for (const [viewportWidth, viewportHeight] of [[640, compact ? 35 : 230], [1480, compact ? 35 : 280]] as const) {
      const markerX = Number.parseFloat(marker.props.cx) / 100 * viewportWidth;
      const markerY = Number.parseFloat(marker.props.cy) / 100 * viewportHeight;
      assert.ok(Math.abs(markerX - Number(start[1]) / plotWidth * viewportWidth) < .15);
      assert.ok(Math.abs(markerY - Number(start[2]) / plotHeight * viewportHeight) < .15);
    }
  }
});

test("chart dates and scale labels use unstretched viewport coordinates", () => {
  const chart = TrendChart({ points: chartPoints, label: "Risk trend" });
  const labelGroup = chart.props.children.find((child: { type?: unknown } | null) => child && typeof child.type === "symbol");
  const labels = labelGroup.props.children.flat(Infinity).filter((child: { type?: string } | null) => child?.type === "text");
  assert.equal(labels.length, 7);
  for (const label of labels) {
    assert.match(label.props.x, /%$/);
    assert.match(label.props.y, /%$/);
  }
});
