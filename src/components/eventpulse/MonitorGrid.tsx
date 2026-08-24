import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Pause, Play, ScrollText, Link2, RefreshCw, UserRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { PLATFORM_FILTERS, STATUS_META } from "@/lib/eventpulse-data";
import type { Platform } from "@/lib/eventpulse-data";
import type { BackendMonitorTarget, BackendProfileRow } from "@/lib/eventpulse/types";
import { addTargetFn, deleteTargetFn, updateTargetStatusFn } from "@/lib/eventpulse/server-fns";

const DEFAULT_PLATFORM: Platform = "Ticketmaster UK/WW";

export function MonitorGrid({
  targets,
  profiles,
  openFormSignal = 0,
}: {
  targets: BackendMonitorTarget[];
  profiles: BackendProfileRow[];
  openFormSignal?: number;
}) {
  const [filter, setFilter] = useState<string>("All Sites");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    platform: DEFAULT_PLATFORM,
    event: "",
    venue: "",
    url: "",
    refresh: 10,
    profile: profiles[0]?.name ?? "",
    proxy: profiles[0]?.stickyIp ?? "",
    sectionFilters: "Arena A, Arena F",
    minTickets: 2,
    maxPrice: "",
    normalTicketsOnly: true,
    evenTicketQuantitiesOnly: false,
    monitorStartsAt: "",
    monitorEndsAt: "",
  });
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const addTarget = useServerFn(addTargetFn);
  const deleteTarget = useServerFn(deleteTargetFn);
  const updateTargetStatus = useServerFn(updateTargetStatusFn);
  const router = useRouter();
  const rows = targets.filter((t) => filter === "All Sites" || t.platform === filter);

  useEffect(() => {
    if (openFormSignal > 0) setShowForm(true);
  }, [openFormSignal]);

  async function submitTarget() {
    setSaving(true);
    setStatusMessage("");
    try {
      await addTarget({
        data: {
          ...form,
          sectionFilters: form.sectionFilters
            .split(",")
            .map((section) => section.trim())
            .filter(Boolean),
          maxPrice: form.maxPrice ? Number(form.maxPrice) : null,
          monitorStartsAt: toIsoOrNull(form.monitorStartsAt),
          monitorEndsAt: toIsoOrNull(form.monitorEndsAt),
        },
      });
      setShowForm(false);
      setStatusMessage("Target saved to Supabase.");
      await router.invalidate();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Target save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id: string, status: BackendMonitorTarget["status"]) {
    await updateTargetStatus({ data: { id, status } });
    await router.invalidate();
  }

  async function removeTarget(id: string, eventName: string) {
    const ok = window.confirm(
      `Delete monitor "${eventName}"? This removes the target from Supabase.`,
    );
    if (!ok) return;

    setDeletingId(id);
    setStatusMessage("");
    try {
      await deleteTarget({ data: { id } });
      setStatusMessage("Target deleted from Supabase.");
      await router.invalidate();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Target delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm font-bold uppercase tracking-wide">
          Live Event Ticket Monitoring
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {rows.length} targets shown
        </span>
      </div>

      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-sm font-semibold">Target Admin</h3>
            <p className="text-xs text-muted-foreground">
              Add event URL, ticket count, section filters, price cap.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setShowForm((value) => !value)}>
            {showForm ? "Close" : "Add Target"}
          </Button>
        </div>

        {showForm && (
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <select
              value={form.platform}
              onChange={(event) =>
                setForm((value) => ({ ...value, platform: event.target.value as Platform }))
              }
              className="rounded-md border border-input bg-background px-3 py-2 text-xs"
            >
              {PLATFORM_FILTERS.filter((platform) => platform !== "All Sites").map((platform) => (
                <option key={platform}>{platform}</option>
              ))}
            </select>
            <Input
              value={form.event}
              onChange={(event) => setForm((value) => ({ ...value, event: event.target.value }))}
              placeholder="Event name"
              className="text-xs"
            />
            <Input
              value={form.venue}
              onChange={(event) => setForm((value) => ({ ...value, venue: event.target.value }))}
              placeholder="Venue"
              className="text-xs"
            />
            <Input
              value={form.url}
              onChange={(event) => setForm((value) => ({ ...value, url: event.target.value }))}
              placeholder="Target URL"
              className="text-xs"
            />
            <Input
              value={form.sectionFilters}
              onChange={(event) =>
                setForm((value) => ({ ...value, sectionFilters: event.target.value }))
              }
              placeholder="Sections: Arena A, Arena F"
              className="text-xs"
            />
            <Input
              type="number"
              min={1}
              max={10}
              value={form.minTickets}
              onChange={(event) =>
                setForm((value) => ({ ...value, minTickets: Number(event.target.value) }))
              }
              className="text-xs"
            />
            <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
              Even quantities only
              <Switch
                checked={form.evenTicketQuantitiesOnly}
                onCheckedChange={(checked) =>
                  setForm((value) => ({ ...value, evenTicketQuantitiesOnly: checked }))
                }
              />
            </label>
            <Input
              type="number"
              value={form.maxPrice}
              onChange={(event) => setForm((value) => ({ ...value, maxPrice: event.target.value }))}
              placeholder="Max price"
              className="text-xs"
            />
            <Input
              value={form.profile}
              onChange={(event) => setForm((value) => ({ ...value, profile: event.target.value }))}
              placeholder="Profile name (optional)"
              className="text-xs"
            />
            <Input
              value={form.proxy}
              onChange={(event) => setForm((value) => ({ ...value, proxy: event.target.value }))}
              placeholder="Proxy / sticky IP label (optional)"
              className="text-xs"
            />
            <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
              Normal tickets only
              <Switch
                checked={form.normalTicketsOnly}
                onCheckedChange={(checked) =>
                  setForm((value) => ({ ...value, normalTicketsOnly: checked }))
                }
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Start monitoring
              <Input
                type="datetime-local"
                value={form.monitorStartsAt}
                onChange={(event) =>
                  setForm((value) => ({ ...value, monitorStartsAt: event.target.value }))
                }
                className="text-xs"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Stop monitoring
              <Input
                type="datetime-local"
                value={form.monitorEndsAt}
                onChange={(event) =>
                  setForm((value) => ({ ...value, monitorEndsAt: event.target.value }))
                }
                className="text-xs"
              />
            </label>
            <Button
              className="md:col-span-2 xl:col-span-4"
              disabled={saving}
              onClick={submitTarget}
            >
              Save Target
            </Button>
          </div>
        )}
        {statusMessage && <p className="mt-2 text-xs text-muted-foreground">{statusMessage}</p>}
      </div>

      <div className="scrollbar-hidden -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
        {PLATFORM_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              filter === f
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="grid gap-3 2xl:grid-cols-2">
        {rows.length === 0 && (
          <div className="panel p-4 text-sm text-muted-foreground">
            No production targets yet. Add first target URL above.
          </div>
        )}
        {rows.map((t) => {
          const status = STATUS_META[t.status];
          return (
            <article key={t.id} className="panel p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div className="min-w-0">
                  <span className="inline-block rounded bg-secondary px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t.platform}
                  </span>
                  <h3 className="mt-1.5 truncate font-display text-base font-semibold">
                    {t.event}
                  </h3>
                  <p className="truncate text-xs text-muted-foreground">{t.venue}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1",
                    status.className,
                  )}
                >
                  {status.label}
                </span>
              </div>

              <p className="mt-3 rounded-md bg-secondary/60 px-3 py-2 font-mono text-xs text-foreground">
                {t.availability}
              </p>

              <dl className="mt-3 grid gap-1.5 text-[11px] text-muted-foreground">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate font-mono">{t.url}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0 text-info" />
                  Refreshing every {t.refresh.toFixed(1)}s
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <UserRound className="h-3.5 w-3.5 shrink-0 text-online" />
                  <span className="truncate">
                    {t.profile} ({t.proxy})
                  </span>
                </div>
                <div className="text-muted-foreground">{formatTargetRules(t)}</div>
                <div className="text-muted-foreground">{formatMonitorWindow(t)}</div>
              </dl>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" className="font-semibold" asChild>
                  <a href={t.deepLink} target="_blank" rel="noopener noreferrer">
                    <Play className="h-3.5 w-3.5" />
                    Open Ticket Page
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void setStatus(t.id, "paused")}
                >
                  <Pause className="h-3.5 w-3.5" />
                  Pause Monitor
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void setStatus(t.id, "monitoring")}
                >
                  <ScrollText className="h-3.5 w-3.5" />
                  Resume
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deletingId === t.id}
                  onClick={() => void removeTarget(t.id, t.event)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function toIsoOrNull(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatTargetRules(target: BackendMonitorTarget) {
  const parts = [
    `${target.filters.minTickets}+ tickets`,
    target.filters.normalTicketsOnly ? "standard only" : "any ticket type",
  ];
  if (target.filters.evenTicketQuantitiesOnly) parts.push("even quantities only");
  if (target.filters.sectionFilters.length > 0) {
    parts.push(`sections: ${target.filters.sectionFilters.join(", ")}`);
  }
  if (target.filters.maxPrice != null) parts.push(`max price: ${target.filters.maxPrice}`);
  return parts.join(" / ");
}

function formatMonitorWindow(target: BackendMonitorTarget) {
  if (!target.monitorStartsAt && !target.monitorEndsAt)
    return "monitor window: active whenever unpaused";
  const start = target.monitorStartsAt ? formatDateTime(target.monitorStartsAt) : "now";
  const end = target.monitorEndsAt ? formatDateTime(target.monitorEndsAt) : "manual stop";
  return `monitor window: ${start} to ${end}`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
