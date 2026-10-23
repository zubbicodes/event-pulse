import type {
  BackendAlertLog,
  BackendMonitorTarget,
  BackendProfileRow,
  BackendSettings,
  DashboardData,
  LaunchProfileInput,
  NewTargetInput,
  NewProfileInput,
  SaveProfileSessionInput,
  SavePushSubscriptionInput,
  SaveSettingsInput,
  MonitorRunResult,
} from "./types";
import { DEFAULT_SETTINGS, buildDeepLink, getEmptyDashboardData } from "./seed";
import {
  buildScheduledTicketSnapshotMessage,
  buildTicketAlertMessage,
  extractTicketPageSnapshot,
} from "./ticket-snapshot";
import {
  getMultiloginTokenHealth,
  isApprovedMultiloginProfile,
  readRenderedTicketPage,
} from "./multilogin-browser.server";
import { ChannelQueue, parseRetryAfterMs, type ChannelSendResult } from "./channel-queue.server";
import {
  getProfilePause,
  isProfilePaused,
  pauseProfileManually,
  recordProfileBlock,
  recordProfileSuccess,
  resumeProfile,
} from "./profile-pause.server";

const SUPABASE_URL =
  process.env["SUPABASE_URL"] ??
  process.env["VITE_SUPABASE_URL"] ??
  process.env["SERVICE_URL_SUPABASEKONG"] ??
  "https://eventpulsesb.web-testlink.com";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env["SUPABASE_SERVICE_ROLE_KEY"] ??
  process.env["SUPABASE_SERVICE_KEY"] ??
  process.env["SERVICE_SUPABASESERVICE_KEY"] ??
  process.env["SERVICE_KEY"];
const DELIVERY_TIMEOUT_MS = 10_000;
const TOKEN_WARNING_REPEAT_MS = 24 * 60 * 60 * 1000;
let lastTokenWarning: { key: string; sentAt: number } | null = null;

type SupabaseRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
  prefer?: string;
};

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function rest<T>(table: string, options: SupabaseRequestOptions = {}): Promise<T> {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing.");
  }

  const url = new URL(`/rest/v1/${table}`, SUPABASE_URL);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(options.prefer ? { prefer: options.prefer } : {}),
    },
  };
  if (options.body != null) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatSupabaseError(table, response.status, text));
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

type TargetRow = {
  id: string;
  platform: string;
  event_name: string;
  venue: string;
  target_url: string;
  status: BackendMonitorTarget["status"];
  availability: string;
  refresh_seconds: number;
  profile_name: string;
  proxy_label: string;
  section_filters: string[];
  min_tickets: number;
  max_price: number | null;
  normal_tickets_only: boolean;
  even_ticket_quantities_only?: boolean | null;
  monitor_starts_at?: string | null;
  monitor_ends_at?: string | null;
  deep_link: string;
  last_checked_at: string | null;
  last_response_ms: number | null;
  last_status_code: number | null;
  last_error: string | null;
  last_available_at: string | null;
};

type ProfileRow = {
  profile_name: string;
  region: string;
  cookies_status: string;
  session_status: string;
  fingerprint_health: string;
  multilogin_profile_id: string | null;
  multilogin_folder_id: string | null;
  sticky_ip_label: string | null;
  last_session_saved_at: string | null;
};

type AlertRow = {
  id: string;
  target_id: string | null;
  tone: BackendAlertLog["tone"];
  message: string;
  deep_link: string | null;
  delivered_push: boolean;
  delivered_sms: boolean;
  delivered_whatsapp: boolean;
  delivered_telegram?: boolean;
  delivered_discord?: boolean;
  created_at: string;
};

type SettingsRow = {
  refresh_seconds: number;
  sound_alerts: boolean;
  push_alerts: boolean;
  sms_alerts: boolean;
  whatsapp_alerts: boolean;
  telegram_alerts?: boolean;
  discord_alerts?: boolean;
  auto_rotate_proxy_on_rate_limit: boolean;
  maintain_sticky_mobile_ip: boolean;
  multilogin_endpoint: string;
  multilogin_state_policy: string;
};

type PushSubscriptionRow = {
  endpoint: string;
  subscription: Record<string, unknown>;
};

type MonitorCheckResult = {
  status: BackendMonitorTarget["status"];
  availability: string;
  responseMs: number;
  statusCode: number | null;
  error: string | null;
};

export async function loadDashboardData(): Promise<DashboardData> {
  if (!isConfigured()) return getEmptyDashboardData();

  const [targetsResult, profilesResult, alertsResult, settingsResult] = await Promise.allSettled([
    rest<TargetRow[]>("eventpulse_targets", {
      query: { select: "*", order: "created_at.desc" },
    }),
    rest<ProfileRow[]>("eventpulse_profiles", {
      query: { select: "*", order: "profile_name.asc" },
    }),
    rest<AlertRow[]>("eventpulse_alerts", {
      query: { select: "*", order: "created_at.desc", limit: "30" },
    }),
    rest<SettingsRow[]>("eventpulse_settings", {
      query: { select: "*", limit: "1" },
    }),
  ]);

  const errors = [targetsResult, profilesResult, alertsResult, settingsResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => formatUnknownError(result.reason));

  const targets = targetsResult.status === "fulfilled" ? targetsResult.value : [];
  const profiles = profilesResult.status === "fulfilled" ? profilesResult.value : [];
  const alerts = alertsResult.status === "fulfilled" ? alertsResult.value : [];
  const settingsRows = settingsResult.status === "fulfilled" ? settingsResult.value : [];

  const settings = settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS;
  const mappedTargets = targets.map((target) => mapTarget(target, settings.refreshSeconds));
  const mappedAlerts = alerts.map(mapAlert);
  const mappedProfiles = profiles.map(mapProfile);

  const responseTimes = mappedTargets
    .map((target) => target.responseMs)
    .filter((value): value is number => typeof value === "number");

  return {
    targets: mappedTargets,
    profiles: mappedProfiles,
    alerts: mappedAlerts,
    settings,
    stats: {
      activeMonitors: mappedTargets.filter((target) => target.status !== "paused").length,
      alertsToday: mappedAlerts.length,
      connectedProfiles: mappedProfiles.length,
      avgResponseMs:
        responseTimes.length === 0
          ? 0
          : Math.round(
              responseTimes.reduce((total, value) => total + value, 0) / responseTimes.length,
            ),
    },
    backendConnected: errors.length === 0,
    backendMessage:
      errors.length === 0 ? "Supabase connected." : (errors[0] ?? "Supabase load failed."),
  };
}

export async function insertTarget(input: NewTargetInput) {
  const deepLink = buildDeepLink(input.url, {
    sectionFilters: input.sectionFilters,
    minTickets: input.minTickets,
    maxPrice: input.maxPrice,
    normalTicketsOnly: input.normalTicketsOnly,
    evenTicketQuantitiesOnly: input.evenTicketQuantitiesOnly,
  });

  const body = {
    platform: input.platform,
    event_name: input.event,
    venue: input.venue,
    target_url: input.url,
    refresh_seconds: input.refresh,
    profile_name: input.profile,
    proxy_label: input.proxy,
    section_filters: input.sectionFilters,
    min_tickets: input.minTickets,
    max_price: input.maxPrice,
    normal_tickets_only: input.normalTicketsOnly,
    even_ticket_quantities_only: input.evenTicketQuantitiesOnly,
    monitor_starts_at: input.monitorStartsAt,
    monitor_ends_at: input.monitorEndsAt,
    deep_link: deepLink,
    availability: formatWatchSummary(input),
  };

  let row: TargetRow | undefined;
  try {
    [row] = await rest<TargetRow[]>("eventpulse_targets", {
      method: "POST",
      prefer: "return=representation",
      body,
    });
  } catch (error) {
    if (!isMissingTargetSchedulingColumns(error)) throw error;
    const {
      even_ticket_quantities_only: _evenTicketQuantitiesOnly,
      monitor_starts_at: _monitorStartsAt,
      monitor_ends_at: _monitorEndsAt,
      ...legacyBody
    } = body;
    [row] = await rest<TargetRow[]>("eventpulse_targets", {
      method: "POST",
      prefer: "return=representation",
      body: legacyBody,
    });
  }

  return row ? mapTarget(row) : undefined;
}

export async function setTargetStatus(id: string, status: BackendMonitorTarget["status"]) {
  const [row] = await rest<TargetRow[]>("eventpulse_targets", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    prefer: "return=representation",
    body: { status },
  });
  return row ? mapTarget(row) : undefined;
}

// Moves a target onto another saved profile; the proxy label follows the profile.
export async function setTargetProfile(id: string, profileName: string) {
  const [profile] = await rest<ProfileRow[]>("eventpulse_profiles", {
    query: { select: "*", profile_name: `eq.${profileName}`, limit: "1" },
  });
  if (!profile) throw new Error(`Profile not found: ${profileName}`);

  const [row] = await rest<TargetRow[]>("eventpulse_targets", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    prefer: "return=representation",
    body: {
      profile_name: profile.profile_name,
      proxy_label: profile.sticky_ip_label ?? profile.region,
    },
  });
  return row ? mapTarget(row) : undefined;
}

export async function deleteTarget(id: string) {
  await rest("eventpulse_targets", {
    method: "DELETE",
    query: { id: `eq.${id}` },
  });
  return { ok: true };
}

export async function saveSettings(input: SaveSettingsInput) {
  const body = {
    id: true,
    refresh_seconds: input.refreshSeconds,
    sound_alerts: input.soundAlerts,
    push_alerts: input.pushAlerts,
    sms_alerts: input.smsAlerts,
    whatsapp_alerts: input.whatsappAlerts,
    telegram_alerts: input.telegramAlerts,
    discord_alerts: input.discordAlerts,
    auto_rotate_proxy_on_rate_limit: input.autoRotateProxyOnRateLimit,
    maintain_sticky_mobile_ip: input.maintainStickyMobileIp,
    multilogin_endpoint: input.multiloginEndpoint,
    multilogin_state_policy: input.multiloginStatePolicy,
  };
  let row: SettingsRow | undefined;
  try {
    [row] = await rest<SettingsRow[]>("eventpulse_settings", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body,
    });
  } catch (error) {
    if (
      !isMissingProfileSettingsColumn(error) &&
      !isMissingTelegramColumn(error) &&
      !isMissingDiscordColumn(error)
    ) {
      throw error;
    }
    const {
      telegram_alerts: _telegramAlerts,
      discord_alerts: _discordAlerts,
      auto_rotate_proxy_on_rate_limit: _autoRotateProxyOnRateLimit,
      maintain_sticky_mobile_ip: _maintainStickyMobileIp,
      ...legacyBody
    } = body;
    [row] = await rest<SettingsRow[]>("eventpulse_settings", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: legacyBody,
    });
  }
  return row ? mapSettings(row) : input;
}

export async function upsertProfile(input: NewProfileInput) {
  const body = {
    profile_name: input.profileName,
    region: input.region,
    cookies_status: input.cookiesStatus,
    session_status: input.sessionStatus,
    fingerprint_health: input.fingerprintHealth,
    multilogin_profile_id: input.multiloginProfileId || null,
    multilogin_folder_id: input.multiloginFolderId || null,
    sticky_ip_label: input.stickyIpLabel || null,
  };

  let row: ProfileRow | undefined;
  try {
    [row] = await rest<ProfileRow[]>("eventpulse_profiles", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body,
    });
  } catch (error) {
    if (!isMissingFolderIdColumn(error)) throw error;
    const { multilogin_folder_id: _multiloginFolderId, ...legacyBody } = body;
    [row] = await rest<ProfileRow[]>("eventpulse_profiles", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: legacyBody,
    });
  }
  return row ? mapProfile(row) : undefined;
}

export async function deleteProfile(profileName: string) {
  await rest("eventpulse_profiles", {
    method: "DELETE",
    query: { profile_name: `eq.${profileName}` },
  });
  return { ok: true };
}

export async function launchMultiloginProfile(input: LaunchProfileInput) {
  if (!input.profileId) {
    throw new Error("MultiLogin profile ID is required.");
  }

  const endpoint = normalizeEndpoint(input.endpoint);
  const url = input.folderId
    ? new URL(
        `/api/v2/profile/f/${encodeURIComponent(input.folderId)}/p/${encodeURIComponent(input.profileId)}/start`,
        endpoint,
      )
    : new URL("/api/v1/profile/start", endpoint);

  if (input.folderId) {
    url.searchParams.set("automation_type", "puppeteer");
    url.searchParams.set("headless_mode", "false");
  } else {
    url.searchParams.set("automation", "true");
    url.searchParams.set("profileId", input.profileId);
  }

  const headers: HeadersInit = { accept: "application/json" };
  const token = process.env["MULTILOGIN_API_TOKEN"];
  if (token) headers["authorization"] = `Bearer ${token}`;

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(formatMultiloginError(response.status, body));
  }

  return {
    ok: true,
    message: `${input.profileName} launch requested.`,
    body: formatMultiloginSuccess(body),
  };
}

export async function saveProfileSession(input: SaveProfileSessionInput) {
  await rest("eventpulse_profile_sessions", {
    method: "POST",
    body: {
      profile_name: input.profileName,
      state_label: input.stateLabel,
      session_state: input.sessionState,
      restore_policy: "manual_restore",
    },
  });

  await rest("eventpulse_profiles", {
    method: "PATCH",
    query: { profile_name: `eq.${input.profileName}` },
    body: {
      session_status: "State Saved",
      last_session_saved_at: new Date().toISOString(),
    },
  });

  return { ok: true };
}

export async function savePushSubscription(input: SavePushSubscriptionInput) {
  await rest("eventpulse_push_subscriptions", {
    method: "POST",
    query: { on_conflict: "endpoint" },
    prefer: "resolution=merge-duplicates",
    body: {
      endpoint: input.endpoint,
      subscription: input.subscription,
      user_agent: input.userAgent,
    },
  });
  return { ok: true };
}

// Sends one test alert through every enabled channel using the same path as monitor alerts.
export async function sendTestAlert() {
  if (!isConfigured()) throw new Error("Supabase is not configured.");

  const [settingsRows, subscriptions] = await Promise.all([
    rest<SettingsRow[]>("eventpulse_settings", { query: { select: "*", limit: "1" } }),
    rest<PushSubscriptionRow[]>("eventpulse_push_subscriptions", {
      query: { select: "endpoint,subscription" },
    }),
  ]);
  const settings = settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS;
  if (!hasEnabledDeliveryChannel(settings)) {
    throw new Error("No alert channel is enabled. Enable a channel and save settings first.");
  }

  return await deliverAlert({
    title: "HD-1 Drop Monitor test alert",
    body: `Sent:${new Date().toISOString()}\nAll enabled alert channels are receiving monitor alerts.`,
    url: process.env["EVENTPULSE_PUBLIC_URL"] ?? "",
    settings,
    subscriptions,
  });
}

export async function runMonitorPass(): Promise<MonitorRunResult> {
  if (!isConfigured()) {
    return {
      checked: 0,
      alertsCreated: 0,
      pushSent: 0,
      smsSent: 0,
      whatsappSent: 0,
      telegramSent: 0,
      discordSent: 0,
      errors: ["Supabase is not configured."],
    };
  }

  const [targets, settingsRows, subscriptions, profiles] = await Promise.all([
    rest<TargetRow[]>("eventpulse_targets", {
      query: {
        select: "*",
        status: "neq.paused",
        order: "last_checked_at.asc.nullsfirst",
        limit: "25",
      },
    }),
    rest<SettingsRow[]>("eventpulse_settings", {
      query: { select: "*", limit: "1" },
    }),
    rest<PushSubscriptionRow[]>("eventpulse_push_subscriptions", {
      query: { select: "endpoint,subscription" },
    }),
    rest<ProfileRow[]>("eventpulse_profiles", {
      query: { select: "*" },
    }),
  ]);

  const settings = settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS;
  const profilesByName = new Map(profiles.map((profile) => [profile.profile_name, profile]));
  const dueTargets = targets.filter((target) => isTargetDue(target, settings.refreshSeconds));
  const result: MonitorRunResult = {
    checked: 0,
    alertsCreated: 0,
    pushSent: 0,
    smsSent: 0,
    whatsappSent: 0,
    telegramSent: 0,
    discordSent: 0,
    errors: [],
  };

  try {
    await notifyMultiloginTokenExpiry(settings, subscriptions, result);
  } catch (error) {
    result.errors.push(`MultiLogin token warning failed: ${formatUnknownError(error)}`);
  }

  const deliveries: Promise<DeliveryResult>[] = [];
  try {
    for (const row of dueTargets) {
      // Re-checked per target: an earlier target in this pass may have just paused the profile.
      if (isProfilePaused(row.profile_name)) continue;
      result.checked += 1;
      const target = mapTarget(row, settings.refreshSeconds);
      const check = await checkTarget(target, settings, profilesByName.get(target.profile));

      // After every (re)deploy the launcher downloads its browser engine before the first profile
      // can start. That is start-up, not a failed check: keep the target's last snapshot, skip
      // the per-target alert, and announce the warm-up once.
      if (check.error && /downloading of core/i.test(check.error)) {
        result.checked -= 1;
        if (!launcherWarmUpAnnounced && hasEnabledDeliveryChannel(settings)) {
          launcherWarmUpAnnounced = true;
          deliveries.push(announceLauncherWarmUp(dueTargets.length, settings, subscriptions));
          result.alertsCreated += 1;
        }
        continue;
      }
      launcherWarmUpAnnounced = false;

      const now = new Date().toISOString();
      const pause =
        check.statusCode === 403 || check.statusCode === 429
          ? recordProfileBlock(target.profile, check.statusCode)
          : null;
      const recovered = !pause && check.error == null && recordProfileSuccess(target.profile);
      await rest("eventpulse_targets", {
        method: "PATCH",
        query: { id: `eq.${row.id}` },
        body: {
          status: check.status,
          availability: check.availability,
          last_checked_at: now,
          last_response_ms: check.responseMs,
          last_status_code: check.statusCode,
          last_error: check.error,
          last_available_at: check.status === "available" ? now : row.last_available_at,
        },
      });

      const firstObservation = !row.last_checked_at;
      const snapshotChanged =
        check.availability !== row.availability || check.status !== row.status;
      if (!hasEnabledDeliveryChannel(settings)) continue;

      const snapshotMessage =
        firstObservation || snapshotChanged
          ? buildTicketAlertMessage(
              target.event,
              row.availability,
              check.availability,
              firstObservation,
            )
          : buildScheduledTicketSnapshotMessage(target.event, check.availability, now);
      const alertMessage = pause
        ? [
            target.event,
            check.statusCode === 429
              ? "Ticketmaster rate limited this profile (HTTP 429)."
              : "Ticketmaster blocked this profile with an identity check (HTTP 403).",
            `All checks on profile "${target.profile}" are paused until ${formatUtcTime(pause.pausedUntil)} UTC (pause ${pause.blockLevel}), then retried automatically.`,
            "Resume or extend the pause under MultiLogin & Proxy Profiles in the dashboard.",
            `Current: ${check.availability}`,
          ]
            .join("\n")
            .slice(0, 1800)
        : recovered
          ? `Ticketmaster access restored for profile "${target.profile}"; checks resumed.\n${snapshotMessage}`.slice(
              0,
              1800,
            )
          : snapshotMessage;
      const [alert] = await rest<AlertRow[]>("eventpulse_alerts", {
        method: "POST",
        prefer: "return=representation",
        body: {
          target_id: row.id,
          tone:
            check.status === "available"
              ? "online"
              : check.status === "captcha" || check.status === "limited"
                ? "warn"
                : "info",
          message: alertMessage,
          deep_link: target.deepLink,
        },
      });
      result.alertsCreated += 1;

      // Deliver in the background so a slow or rate-limited channel never delays the next check;
      // every channel receives the same alert, and the pass waits for all of them before returning.
      deliveries.push(
        deliverAlert({
          ...(alert?.id ? { alertId: alert.id } : {}),
          title: ticketAlertTitle(check, Boolean(pause), recovered),
          body: alertMessage,
          url: target.deepLink,
          settings,
          subscriptions,
        }),
      );
    }
  } finally {
    // Settle deliveries even if a target update throws, so none end as unhandled rejections.
    for (const outcome of await Promise.allSettled(deliveries)) {
      if (outcome.status === "rejected") {
        result.errors.push(`Alert delivery failed: ${formatUnknownError(outcome.reason)}`);
        continue;
      }
      addDeliveryResult(result, outcome.value);
    }
  }

  return result;
}

// True while the launcher is still preparing its browser engine and the start-up alert went out.
let launcherWarmUpAnnounced = false;

async function announceLauncherWarmUp(
  targetCount: number,
  settings: BackendSettings,
  subscriptions: PushSubscriptionRow[],
): Promise<DeliveryResult> {
  const body = [
    "Ticket monitoring restarted",
    `Preparing the monitoring browser; checks for ${targetCount} target${targetCount === 1 ? "" : "s"} resume automatically in about a minute.`,
    `Started: ${new Date().toISOString()}`,
  ].join("\n");
  const [alert] = await rest<AlertRow[]>("eventpulse_alerts", {
    method: "POST",
    prefer: "return=representation",
    body: { target_id: null, tone: "info", message: body, deep_link: null },
  });
  return await deliverAlert({
    ...(alert?.id ? { alertId: alert.id } : {}),
    title: "🔄 HD-1: monitor starting up",
    body,
    url: process.env["EVENTPULSE_PUBLIC_URL"] ?? "",
    settings,
    subscriptions,
  });
}

const MONITOR_FAILURE_REPEAT_MS = 15 * 60 * 1000;
// Set while the scheduler is failing: when it started and when the last failure alert went out.
let monitorOutage: { since: string; alertedAt: number } | null = null;

// A crashed monitor pass means no ticket alerts at all, so tell every reachable channel, at most
// once per 15 minutes while it keeps failing (scheduler ticks are every second).
export async function notifyMonitorFailure(error: unknown) {
  const now = Date.now();
  if (monitorOutage && now - monitorOutage.alertedAt < MONITOR_FAILURE_REPEAT_MS) return;
  monitorOutage = { since: monitorOutage?.since ?? new Date(now).toISOString(), alertedAt: now };

  const message = formatUnknownError(error).replace(/\s+/g, " ").slice(0, 500);
  await deliverOperationalAlert(
    "🔴 HD-1: monitor pass failed",
    [
      "Ticket checks are failing; no ticket alerts are being produced until this clears.",
      `Error: ${message}`,
      `Failing since: ${monitorOutage.since}`,
    ].join("\n"),
  );
}

// Called after every successful pass; sends one all-clear if a failure alert went out.
export async function notifyMonitorRecovered() {
  if (!monitorOutage) return;
  const { since } = monitorOutage;
  monitorOutage = null;
  await deliverOperationalAlert(
    "✅ HD-1: monitor recovered",
    `Ticket checks are running again.\nFailing since: ${since}\nRecovered: ${new Date().toISOString()}`,
  );
}

// Settings come from Supabase when it answers; if Supabase itself is the failure, fall back to the
// chat channels configured in the environment.
async function deliverOperationalAlert(title: string, body: string) {
  let settings: BackendSettings;
  let subscriptions: PushSubscriptionRow[] = [];
  try {
    const [settingsRows, subscriptionRows] = await Promise.all([
      rest<SettingsRow[]>("eventpulse_settings", { query: { select: "*", limit: "1" } }),
      rest<PushSubscriptionRow[]>("eventpulse_push_subscriptions", {
        query: { select: "endpoint,subscription" },
      }),
    ]);
    settings = settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS;
    subscriptions = subscriptionRows;
  } catch {
    settings = {
      ...DEFAULT_SETTINGS,
      pushAlerts: false,
      telegramAlerts: Boolean(process.env["TELEGRAM_BOT_TOKEN"]),
      discordAlerts: Boolean(process.env["DISCORD_WEBHOOK_URLS"]),
    };
  }
  if (!hasEnabledDeliveryChannel(settings)) return;

  const delivery = await deliverAlert({
    title,
    body,
    url: process.env["EVENTPULSE_PUBLIC_URL"] ?? "",
    settings,
    subscriptions,
  });
  if (delivery.errors.length) console.error("HD-1 operational alert issues", delivery.errors);
}

// Same title on every channel, so a ticket drop stands out from routine snapshot alerts.
function ticketAlertTitle(check: MonitorCheckResult, paused: boolean, recovered: boolean) {
  if (check.status === "available") return "🟢 HD-1: TICKETS AVAILABLE";
  if (check.statusCode === 403) {
    return `⛔ HD-1: blocked by Ticketmaster (identity check)${paused ? ", profile paused" : ""}`;
  }
  if (check.statusCode === 429) {
    return `⏳ HD-1: rate limited by Ticketmaster${paused ? ", profile paused" : ""}`;
  }
  if (recovered) return "✅ HD-1: profile unblocked, checks resumed";
  if (check.status === "captcha") return "⚠️ HD-1: captcha challenge";
  if (check.status === "limited") return "⚠️ HD-1: check failed";
  return "HD-1 Drop Monitor ticket alert";
}

function formatUtcTime(iso: string) {
  return iso.slice(11, 16);
}

function addDeliveryResult(result: MonitorRunResult, delivery: DeliveryResult) {
  result.pushSent += delivery.pushSent;
  result.smsSent += delivery.smsSent;
  result.whatsappSent += delivery.whatsappSent;
  result.telegramSent += delivery.telegramSent;
  result.discordSent += delivery.discordSent;
  result.errors.push(...delivery.errors);
}

function mapTarget(
  row: TargetRow,
  refreshSeconds = Number(row.refresh_seconds),
): BackendMonitorTarget {
  return {
    id: row.id,
    platform: row.platform as BackendMonitorTarget["platform"],
    event: row.event_name,
    venue: row.venue,
    status: row.status,
    availability: row.availability,
    url: row.target_url,
    refresh: refreshSeconds,
    profile: row.profile_name,
    proxy: row.proxy_label,
    deepLink:
      row.deep_link ||
      buildDeepLink(row.target_url, {
        sectionFilters: row.section_filters,
        minTickets: row.min_tickets,
        maxPrice: row.max_price,
        normalTicketsOnly: row.normal_tickets_only,
        evenTicketQuantitiesOnly: row.even_ticket_quantities_only ?? false,
      }),
    filters: {
      sectionFilters: row.section_filters ?? [],
      minTickets: row.min_tickets,
      maxPrice: row.max_price,
      normalTicketsOnly: row.normal_tickets_only,
      evenTicketQuantitiesOnly: row.even_ticket_quantities_only ?? false,
    },
    monitorStartsAt: row.monitor_starts_at ?? null,
    monitorEndsAt: row.monitor_ends_at ?? null,
    lastCheckedAt: row.last_checked_at,
    responseMs: row.last_response_ms,
  };
}

function mapProfile(row: ProfileRow): BackendProfileRow {
  return {
    name: row.profile_name,
    region: row.region,
    cookies: row.cookies_status,
    session: row.session_status,
    health: row.fingerprint_health,
    stickyIp: row.sticky_ip_label ?? row.region,
    multiloginProfileId: row.multilogin_profile_id,
    multiloginFolderId: row.multilogin_folder_id,
    lastSessionSavedAt: row.last_session_saved_at,
    pause: getProfilePause(row.profile_name),
  };
}

export function pauseProfile(profileName: string, minutes: number | null) {
  return pauseProfileManually(profileName, minutes);
}

export function resumeProfileChecks(profileName: string) {
  resumeProfile(profileName);
  return { ok: true };
}

function mapAlert(row: AlertRow): BackendAlertLog {
  return {
    id: row.id,
    time: new Date(row.created_at).toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    tone: row.tone,
    text: row.message,
    deepLink: row.deep_link,
  };
}

function mapSettings(row: SettingsRow): BackendSettings {
  return {
    refreshSeconds: row.refresh_seconds,
    soundAlerts: row.sound_alerts,
    pushAlerts: row.push_alerts,
    smsAlerts: row.sms_alerts,
    whatsappAlerts: row.whatsapp_alerts,
    telegramAlerts: row.telegram_alerts ?? false,
    discordAlerts: row.discord_alerts ?? false,
    autoRotateProxyOnRateLimit: row.auto_rotate_proxy_on_rate_limit ?? false,
    maintainStickyMobileIp: row.maintain_sticky_mobile_ip ?? true,
    multiloginEndpoint: row.multilogin_endpoint,
    multiloginStatePolicy: row.multilogin_state_policy,
  };
}

function isMissingProfileSettingsColumn(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("auto_rotate_proxy_on_rate_limit") ||
      error.message.includes("maintain_sticky_mobile_ip")) &&
    error.message.includes("schema cache")
  );
}

function isMissingFolderIdColumn(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("multilogin_folder_id") &&
    error.message.includes("schema cache")
  );
}

function isMissingTelegramColumn(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("telegram_alerts") || error.message.includes("delivered_telegram")) &&
    error.message.includes("schema cache")
  );
}

function isMissingDiscordColumn(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("discord_alerts") || error.message.includes("delivered_discord")) &&
    error.message.includes("schema cache")
  );
}

function isMissingTargetSchedulingColumns(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("even_ticket_quantities_only") ||
      error.message.includes("monitor_starts_at") ||
      error.message.includes("monitor_ends_at")) &&
    error.message.includes("schema cache")
  );
}

function formatSupabaseError(table: string, status: number, body: string) {
  if (status === 525 || body.includes("SSL handshake failed") || body.includes("Error code 525")) {
    return `Supabase ${table}: Cloudflare 525 SSL handshake failed. Fix SSL on eventpulsesb.web-testlink.com origin or set SUPABASE_URL to a reachable Supabase Kong URL.`;
  }

  const trimmed = stripHtml(body).slice(0, 240).trim();
  return `Supabase ${table} ${status}: ${trimmed || "Request failed."}`;
}

function stripHtml(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
}

function formatUnknownError(error: unknown) {
  return error instanceof Error ? error.message : "Supabase load failed.";
}

function normalizeEndpoint(endpoint: string) {
  const normalized = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function formatMultiloginSuccess(value: string) {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value.slice(0, 500);
  }
}

function formatMultiloginError(status: number, body: string) {
  const clean = stripHtml(body).slice(0, 300).trim();
  return `MultiLogin launch failed (${status}): ${clean || "No response body."}`;
}

function isTargetDue(row: TargetRow, refreshSeconds: number) {
  const now = Date.now();
  if (row.monitor_starts_at && now < new Date(row.monitor_starts_at).getTime()) return false;
  if (row.monitor_ends_at && now > new Date(row.monitor_ends_at).getTime()) return false;
  if (!row.last_checked_at) return true;
  const ageMs = now - new Date(row.last_checked_at).getTime();
  return ageMs >= refreshSeconds * 1000;
}

function hasEnabledDeliveryChannel(settings: BackendSettings) {
  return (
    settings.pushAlerts ||
    settings.smsAlerts ||
    settings.whatsappAlerts ||
    settings.telegramAlerts ||
    settings.discordAlerts
  );
}

async function notifyMultiloginTokenExpiry(
  settings: BackendSettings,
  subscriptions: PushSubscriptionRow[],
  result: MonitorRunResult,
) {
  if (!hasEnabledDeliveryChannel(settings)) return;

  const token = getMultiloginTokenHealth();
  if ((token.status !== "expiring" && token.status !== "expired") || !token.expiresAt) return;

  const warningKey = `multilogin-token:${token.expiresAt}`;
  if (
    lastTokenWarning?.key === warningKey &&
    Date.now() - lastTokenWarning.sentAt < TOKEN_WARNING_REPEAT_MS
  ) {
    return;
  }

  const recentWarnings = await rest<Pick<AlertRow, "message">[]>("eventpulse_alerts", {
    query: {
      select: "message",
      target_id: "is.null",
      created_at: `gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}`,
      order: "created_at.desc",
      limit: "30",
    },
  });
  if (recentWarnings.some((alert) => alert.message.includes(`Expires: ${token.expiresAt}`))) {
    lastTokenWarning = { key: warningKey, sentAt: Date.now() };
    return;
  }

  const alertMessage = [
    token.status === "expired"
      ? "MultiLogin API token has expired. Ticket checks cannot use browser profiles."
      : "MultiLogin API token is nearing expiry.",
    `Expires: ${token.expiresAt}`,
    "Generate a replacement automation token and update MULTILOGIN_API_TOKEN.",
  ].join("\n");
  const [alert] = await rest<AlertRow[]>("eventpulse_alerts", {
    method: "POST",
    prefer: "return=representation",
    body: {
      target_id: null,
      tone: "warn",
      message: alertMessage,
      deep_link: null,
    },
  });
  result.alertsCreated += 1;

  const delivery = await deliverAlert({
    ...(alert?.id ? { alertId: alert.id } : {}),
    title: "HD-1 Drop Monitor configuration alert",
    body: alertMessage,
    url: process.env["EVENTPULSE_PUBLIC_URL"] ?? "/",
    settings,
    subscriptions,
  });
  addDeliveryResult(result, delivery);
  lastTokenWarning = { key: warningKey, sentAt: Date.now() };
}

function formatWatchSummary(input: NewTargetInput) {
  const quantity = input.evenTicketQuantitiesOnly
    ? `even quantities from ${input.minTickets}+`
    : `${input.minTickets}+`;
  return `Watching ${quantity} ${input.normalTicketsOnly ? "standard" : "any"} tickets`;
}

async function checkTarget(
  target: BackendMonitorTarget,
  settings: BackendSettings,
  profile: ProfileRow | undefined,
): Promise<MonitorCheckResult> {
  const started = Date.now();
  try {
    if (!isApprovedMultiloginProfile(target.profile)) {
      throw new Error(
        `Target is not assigned to an approved Multilogin profile: ${target.profile}`,
      );
    }
    if (!profile?.multilogin_profile_id || !profile.multilogin_folder_id) {
      throw new Error(`Approved Multilogin profile mapping is incomplete: ${target.profile}`);
    }

    const response = await readRenderedTicketPage({
      endpoint: process.env["MULTILOGIN_LAUNCHER_ENDPOINT"] ?? settings.multiloginEndpoint,
      folderId: profile.multilogin_folder_id,
      profileId: profile.multilogin_profile_id,
      profileName: profile.profile_name,
      url: target.url,
    });
    const responseMs = Date.now() - started;
    const snapshot = extractTicketPageSnapshot({
      html: response.html,
      statusCode: response.statusCode,
      responseOk: response.responseOk,
      sectionFilters: target.filters.sectionFilters,
      maxPrice: target.filters.maxPrice,
      normalTicketsOnly: target.filters.normalTicketsOnly,
    });

    return {
      status: snapshot.status,
      availability: snapshot.summary,
      responseMs,
      statusCode: response.statusCode,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown monitor error";
    return {
      status: "limited",
      availability: `Target check failed: ${message}`.slice(0, 1200),
      responseMs: Date.now() - started,
      statusCode: null,
      error: message,
    };
  }
}

type DeliveryResult = Omit<MonitorRunResult, "checked" | "alertsCreated">;

async function deliverAlert(input: {
  alertId?: string;
  title: string;
  body: string;
  url: string;
  settings: BackendSettings;
  subscriptions: PushSubscriptionRow[];
}): Promise<DeliveryResult> {
  const result = {
    pushSent: 0,
    smsSent: 0,
    whatsappSent: 0,
    telegramSent: 0,
    discordSent: 0,
    errors: [] as string[],
  };

  // Push shows the title separately; text channels get it as the first line of the message.
  const text = `${input.title}\n${input.body}`;
  [result.pushSent, result.smsSent, result.whatsappSent, result.telegramSent, result.discordSent] =
    await Promise.all([
      input.settings.pushAlerts && input.subscriptions.length > 0
        ? deliverChannel("Web push", result.errors, () =>
            sendWebPush(input.title, input.body, input.url, input.subscriptions, result.errors),
          )
        : 0,
      input.settings.smsAlerts
        ? deliverChannel("Twilio SMS", result.errors, () =>
            sendTwilioMessage("sms", text, result.errors),
          )
        : 0,
      input.settings.whatsappAlerts
        ? deliverChannel("Twilio WhatsApp", result.errors, () =>
            sendTwilioMessage("whatsapp", text, result.errors),
          )
        : 0,
      input.settings.telegramAlerts
        ? deliverChannel("Telegram", result.errors, () =>
            sendTelegramMessage(text, input.url, result.errors),
          )
        : 0,
      input.settings.discordAlerts
        ? deliverChannel("Discord", result.errors, () =>
            sendDiscordMessage(text, input.url, result.errors),
          )
        : 0,
    ]);

  if (input.alertId) {
    await markAlertDelivered(input.alertId, result);
  }

  return result;
}

async function deliverChannel(name: string, errors: string[], send: () => Promise<number>) {
  try {
    return await send();
  } catch (error) {
    errors.push(`${name} failed: ${formatUnknownError(error)}`);
    return 0;
  }
}

async function sendWebPush(
  title: string,
  body: string,
  url: string,
  subscriptions: PushSubscriptionRow[],
  errors: string[],
) {
  const publicKey = process.env["VITE_VAPID_PUBLIC_KEY"];
  const privateKey = process.env["VAPID_PRIVATE_KEY"];
  if (!publicKey || !privateKey) {
    errors.push("VAPID keys missing; push not sent.");
    return 0;
  }

  const webpush = await import("web-push");
  webpush.default.setVapidDetails(
    process.env["VAPID_SUBJECT"] ?? "mailto:alerts@example.com",
    publicKey,
    privateKey,
  );

  let sent = 0;
  for (const subscription of subscriptions) {
    try {
      await webpush.default.sendNotification(
        subscription.subscription as never,
        JSON.stringify({ title, body, url }),
        { timeout: DELIVERY_TIMEOUT_MS, TTL: 60 },
      );
      sent += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Web push failed.");
    }
  }
  return sent;
}

async function sendTwilioMessage(kind: "sms" | "whatsapp", body: string, errors: string[]) {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env[kind === "sms" ? "TWILIO_SMS_FROM" : "TWILIO_WHATSAPP_FROM"];
  const recipients = parseRecipients(
    process.env[kind === "sms" ? "TWILIO_SMS_TO" : "TWILIO_WHATSAPP_TO"],
  );
  if (!sid || !token || !from || recipients.length === 0) {
    errors.push(`Twilio ${kind} env missing; message not sent.`);
    return 0;
  }

  let sent = 0;
  for (const to of recipients) {
    const response = await fetchDelivery(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      },
    );

    if (response.ok) {
      sent += 1;
    } else {
      errors.push(`Twilio ${kind} failed for ${to}: ${response.status}`);
    }
  }
  return sent;
}

function parseRecipients(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

const telegramQueues = new Map<string, ChannelQueue>();
const discordQueues = new Map<string, ChannelQueue>();

async function sendTelegramMessage(body: string, url: string, errors: string[]) {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatIds = parseRecipients(process.env["TELEGRAM_CHAT_IDS"]);
  if (!token || chatIds.length === 0) {
    errors.push("Telegram env missing; message not sent.");
    return 0;
  }

  const text = url ? `${body}\n${url}` : body;
  const results = await Promise.all(
    chatIds.map((chatId) => telegramQueue(token, chatId).enqueue(text, errors)),
  );
  return results.filter(Boolean).length;
}

function telegramQueue(token: string, chatId: string) {
  const key = `${token}:${chatId}`;
  let queue = telegramQueues.get(key);
  if (!queue) {
    queue = new ChannelQueue({
      label: `Telegram ${chatId}`,
      // Telegram allows ~1 message/second per chat and 20 messages/minute per group or channel.
      minIntervalMs: chatId.startsWith("-") ? 3_100 : 1_100,
      maxLength: 4_096,
      send: async (text) => {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        return await toChannelResult(response);
      },
    });
    telegramQueues.set(key, queue);
  }
  return queue;
}

async function sendDiscordMessage(body: string, url: string, errors: string[]) {
  const webhookUrls = parseRecipients(process.env["DISCORD_WEBHOOK_URLS"]);
  if (webhookUrls.length === 0) {
    errors.push("Discord env missing; message not sent.");
    return 0;
  }

  const text = url ? `${body}\n${url}` : body;
  const results = await Promise.all(
    webhookUrls.map((webhookUrl) => discordQueue(webhookUrl).enqueue(text, errors)),
  );
  return results.filter(Boolean).length;
}

function discordQueue(webhookUrl: string) {
  let queue = discordQueues.get(webhookUrl);
  if (!queue) {
    queue = new ChannelQueue({
      label: `Discord webhook #${discordQueues.size + 1}`,
      // Discord webhooks allow 5 requests / 2 seconds and roughly 30 messages/minute per channel.
      minIntervalMs: 2_100,
      maxLength: 2_000,
      send: async (text) => {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        return await toChannelResult(response);
      },
    });
    discordQueues.set(webhookUrl, queue);
  }
  return queue;
}

async function toChannelResult(response: Response): Promise<ChannelSendResult> {
  if (response.ok) return { ok: true, status: response.status, retryAfterMs: null, detail: "" };
  const raw = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Non-JSON error bodies are reported as plain text below.
  }
  const description =
    body && typeof body === "object"
      ? ((body as { description?: unknown; message?: unknown }).description ??
        (body as { message?: unknown }).message)
      : null;
  return {
    ok: false,
    status: response.status,
    retryAfterMs: response.status === 429 ? parseRetryAfterMs(response, body) : null,
    detail: (typeof description === "string" ? description : stripHtml(raw))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
  };
}

async function fetchDelivery(url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 1) return response;
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError instanceof Error ? lastError : new Error("Delivery failed.");
}

async function markAlertDelivered(
  alertId: string,
  result: {
    pushSent: number;
    smsSent: number;
    whatsappSent: number;
    telegramSent: number;
    discordSent: number;
  },
) {
  const body = {
    delivered_push: result.pushSent > 0,
    delivered_sms: result.smsSent > 0,
    delivered_whatsapp: result.whatsappSent > 0,
    delivered_telegram: result.telegramSent > 0,
    delivered_discord: result.discordSent > 0,
  };

  try {
    await rest("eventpulse_alerts", {
      method: "PATCH",
      query: { id: `eq.${alertId}` },
      body,
    });
  } catch (error) {
    if (!isMissingTelegramColumn(error) && !isMissingDiscordColumn(error)) throw error;
    const {
      delivered_telegram: _deliveredTelegram,
      delivered_discord: _deliveredDiscord,
      ...legacyBody
    } = body;
    await rest("eventpulse_alerts", {
      method: "PATCH",
      query: { id: `eq.${alertId}` },
      body: legacyBody,
    });
  }
}
