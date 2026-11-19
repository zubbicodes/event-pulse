// Monitor freshness, decided from target rows. Kept free of imports so it can be unit-tested.

export type MonitorFreshness = {
  status: "ok" | "degraded" | "idle" | "unknown";
  activeTargets: number;
  lastSuccessfulCheckAt: string | null;
  staleAfterMinutes: number;
  error?: string;
};

export type FreshnessRow = {
  last_checked_at: string | null;
  last_error: string | null;
  monitor_starts_at?: string | null;
  monitor_ends_at?: string | null;
};

export function staleAfterMinutes() {
  const configured = Number(process.env["EVENTPULSE_HEALTH_STALE_MINUTES"] ?? 30);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 5), 24 * 60) : 30;
}

// Pure so it can be unit-tested: decide freshness from target rows.
export function computeMonitorFreshness(
  rows: FreshnessRow[],
  now = Date.now(),
  staleMinutes = staleAfterMinutes(),
): MonitorFreshness {
  const active = rows.filter(
    (row) =>
      (!row.monitor_starts_at || Date.parse(row.monitor_starts_at) <= now) &&
      (!row.monitor_ends_at || Date.parse(row.monitor_ends_at) > now),
  );
  const lastSuccess = active
    .filter((row) => row.last_checked_at && !row.last_error)
    .map((row) => Date.parse(row.last_checked_at!))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const base = {
    activeTargets: active.length,
    lastSuccessfulCheckAt: lastSuccess ? new Date(lastSuccess).toISOString() : null,
    staleAfterMinutes: staleMinutes,
  };
  if (active.length === 0) return { status: "idle", ...base };
  const fresh = lastSuccess !== undefined && now - lastSuccess <= staleMinutes * 60_000;
  return { status: fresh ? "ok" : "degraded", ...base };
}
