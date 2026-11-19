import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMonitorFreshness } from "../src/lib/eventpulse/monitor-freshness.ts";

const NOW = Date.parse("2026-11-17T17:00:00Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const row = (lastCheckedMinutesAgo, lastError = null, extra = {}) => ({
  last_checked_at: lastCheckedMinutesAgo === null ? null : minutesAgo(lastCheckedMinutesAgo),
  last_error: lastError,
  monitor_starts_at: null,
  monitor_ends_at: null,
  ...extra,
});

test("freshness: idle without active targets", () => {
  assert.equal(computeMonitorFreshness([], NOW, 30).status, "idle");
  const future = row(null, null, { monitor_starts_at: "2027-01-01T00:00:00Z" });
  const ended = row(5, null, { monitor_ends_at: minutesAgo(1) });
  assert.equal(computeMonitorFreshness([future, ended], NOW, 30).status, "idle");
});

test("freshness: ok when any active target had a recent clean check", () => {
  const result = computeMonitorFreshness([row(2, "HTTP 403"), row(10)], NOW, 30);
  assert.equal(result.status, "ok");
  assert.equal(result.activeTargets, 2);
  assert.equal(result.lastSuccessfulCheckAt, minutesAgo(10));
});

test("freshness: degraded when every recent check failed (the 12-17 Nov outage)", () => {
  const blocked = [
    row(1, "Identity check from the ticket site (HTTP 403)."),
    row(3, "launch failed"),
  ];
  const result = computeMonitorFreshness(blocked, NOW, 30);
  assert.equal(result.status, "degraded");
  assert.equal(result.lastSuccessfulCheckAt, null);
});

test("freshness: degraded when the last clean check is older than the threshold", () => {
  assert.equal(computeMonitorFreshness([row(45)], NOW, 30).status, "degraded");
  assert.equal(computeMonitorFreshness([row(45)], NOW, 60).status, "ok");
});
