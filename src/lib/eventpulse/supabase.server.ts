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
  CheckNowResult,
} from "./types";
import { DEFAULT_SETTINGS, buildDeepLink, getEmptyDashboardData } from "./seed";
import { buildSampleTicketAlert } from "./sample-alert";
import { interpretTicketPage, type MonitorCheckResult } from "./ticket-snapshot";
import {
  buildTicketAlert,
  escapeHtml,
  findNewStock,
  stockSnapshot,
  type TicketAlertContent,
} from "./ticket-inventory";
import {
  getMultiloginTokenHealth,
  hasConfiguredScraperProxyPool,
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
    profileMinIntervalSeconds: hasConfiguredScraperProxyPool() ? 0 : profileMinIntervalSeconds(),
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
    // A sample in the real ticket-alert format, so every channel's rendering can be checked.
    content: ticketAlertContent(buildSampleTicketAlert(new Date())),
    settings,
    subscriptions,
  });
}

// Portal "Check now" / "Check & send alert": the same real check the scheduler runs, through the
// target's own Multilogin profile, on demand. With `sendAlert` the current stock is sent to every
// enabled channel as a real ticket alert (even if it was reported before).
export async function checkTargetNow(id: string, sendAlert: boolean): Promise<CheckNowResult> {
  if (!isConfigured()) throw new Error("Supabase is not configured.");
  const [targets, settingsRows, subscriptions, profiles] = await Promise.all([
    rest<TargetRow[]>("eventpulse_targets", { query: { select: "*", id: `eq.${id}`, limit: "1" } }),
    rest<SettingsRow[]>("eventpulse_settings", { query: { select: "*", limit: "1" } }),
    rest<PushSubscriptionRow[]>("eventpulse_push_subscriptions", {
      query: { select: "endpoint,subscription" },
    }),
    rest<ProfileRow[]>("eventpulse_profiles", { query: { select: "*" } }),
  ]);
  const row = targets[0];
  if (!row) throw new Error("Target not found.");
  const settings = settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS;
  const target = mapTarget(row, settings.refreshSeconds);

  const pause = getProfilePause(target.profile);
  if (pause) {
    return checkNowRefusal(
      `Profile "${target.profile}" is paused ${pause.pausedUntil ? `until ${pause.pausedUntil.slice(11, 16)} UTC` : "until resumed"} (${pause.reason}). Resume it under MultiLogin & Proxy Profiles first.`,
    );
  }
  const wait = hasConfiguredScraperProxyPool() ? 0 : profileWaitSeconds(target.profile);
  if (wait > 0) {
    return checkNowRefusal(
      `Profile "${target.profile}" loaded a ticket page moments ago. Try again in ${wait}s; loading pages faster through one profile is what triggers Ticketmaster's identity check (HTTP 403).`,
    );
  }

  const result: MonitorRunResult = {
    checked: 1,
    alertsCreated: 0,
    pushSent: 0,
    smsSent: 0,
    whatsappSent: 0,
    telegramSent: 0,
    discordSent: 0,
    errors: [],
  };
  const context: AlertContext = { settings, subscriptions, result, deliveries: [] };
  const check = await checkTarget(
    target,
    settings,
    profiles.find((profile) => profile.profile_name === target.profile),
  );
  // Launcher start-up or a profile open elsewhere: not a result. Leave the target as is.
  if (check.kind === "failed" && check.error && /downloading of core/i.test(check.error)) {
    return checkNowRefusal(
      "Multilogin is still downloading its browser engine (first start). Try again in a minute.",
    );
  }
  if (check.kind === "failed" && check.error && /can'?t lock profile/i.test(check.error)) {
    return checkNowRefusal(
      `Profile "${target.profile}" is open somewhere else (the production monitor or a Multilogin window), so this Multilogin cannot open it. Close it there, or check from the server that holds it.`,
    );
  }
  const alertSent = await handleCheckResult(row, target, check, context, sendAlert);
  for (const outcome of await Promise.allSettled(context.deliveries)) {
    if (outcome.status === "fulfilled") addDeliveryResult(result, outcome.value);
    else result.errors.push(`Alert delivery failed: ${formatUnknownError(outcome.reason)}`);
  }

  const alert =
    check.report && check.report.totalStock > 0
      ? buildTicketAlert({ report: check.report, url: target.deepLink, checkedAt: new Date() }).text
      : null;
  return {
    checked: true,
    kind: check.kind,
    status: check.status,
    summary: check.availability || check.error || "",
    statusCode: check.statusCode,
    alertPreview: alert,
    alertSent,
    delivered: {
      push: result.pushSent,
      telegram: result.telegramSent,
      discord: result.discordSent,
      sms: result.smsSent,
      whatsapp: result.whatsappSent,
    },
    message: describeCheckNow(check, sendAlert, alertSent, hasEnabledDeliveryChannel(settings)),
    errors: result.errors,
  };
}

function checkNowRefusal(message: string): CheckNowResult {
  return {
    checked: false,
    kind: null,
    status: null,
    summary: "",
    statusCode: null,
    alertPreview: null,
    alertSent: false,
    delivered: { push: 0, telegram: 0, discord: 0, sms: 0, whatsapp: 0 },
    message,
    errors: [],
  };
}

function describeCheckNow(
  check: MonitorCheckResult,
  sendAlert: boolean,
  alertSent: boolean,
  channelsEnabled: boolean,
) {
  if (check.kind === "blocked") {
    return `Ticketmaster refused the page with HTTP ${check.statusCode} (identity check / rate limit). The profile is paused and retried automatically.`;
  }
  if (check.kind === "captcha")
    return "The page showed a captcha challenge; no stock could be read.";
  if (check.kind === "gone")
    return "The event page no longer exists; monitoring for it has stopped.";
  if (check.kind === "failed") return `Check failed: ${check.error}`;
  if (!check.report?.totalStock) return "Checked: no tickets matching this target's filters.";
  if (!sendAlert) return "Checked: matching tickets found. Use “Check & send alert” to notify.";
  if (!channelsEnabled) return "Tickets found, but no alert channel is enabled in Settings.";
  return alertSent ? "Tickets found and the alert was sent." : "Tickets found; alert not sent.";
}

// Minimum seconds between two ticket-page loads through the same Multilogin profile.
function profileMinIntervalSeconds() {
  const value = Number(process.env["EVENTPULSE_PROFILE_MIN_INTERVAL_SECONDS"] ?? 60);
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 3600) : 60;
}

// When each profile last loaded a ticket page (scheduler or portal).
const profileLastLoadAt = new Map<string, number>();

function profileWaitSeconds(profileName: string) {
  const last = profileLastLoadAt.get(profileName);
  if (!last) return 0;
  const remaining = profileMinIntervalSeconds() * 1000 - (Date.now() - last);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
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

  const context: AlertContext = { settings, subscriptions, result, deliveries: [] };
  try {
    for (const row of dueTargets) {
      // Re-checked per target: an earlier target in this pass may have just paused the profile.
      if (isProfilePaused(row.profile_name)) continue;
      // One profile (one sticky IP) never loads ticket pages faster than the profile interval;
      // targets wait their turn instead (they are ordered by last check, oldest first).
      if (!hasConfiguredScraperProxyPool() && profileWaitSeconds(row.profile_name) > 0) continue;
      const target = mapTarget(row, settings.refreshSeconds);
      const check = await checkTarget(target, settings, profilesByName.get(target.profile));

      // After every (re)deploy the launcher downloads its browser engine before the first profile
      // can start. That is start-up, not a failed check: leave the target untouched and move on.
      if (check.kind === "failed" && check.error && /downloading of core/i.test(check.error)) {
        console.info(`HD-1 launcher warming up; ${target.event} will be checked shortly.`);
        continue;
      }
      result.checked += 1;
      await handleCheckResult(row, target, check, context);
    }
  } finally {
    // Settle deliveries even if a target update throws, so none end as unhandled rejections.
    for (const outcome of await Promise.allSettled(context.deliveries)) {
      if (outcome.status === "rejected") {
        result.errors.push(`Alert delivery failed: ${formatUnknownError(outcome.reason)}`);
        continue;
      }
      addDeliveryResult(result, outcome.value);
    }
  }

  return result;
}

type AlertContext = {
  settings: BackendSettings;
  subscriptions: PushSubscriptionRow[];
  result: MonitorRunResult;
  deliveries: Promise<DeliveryResult>[];
};

// Matched stock last reported per target (listing key -> quantity), so alerts fire only for new or
// increased stock. After a restart it is rebuilt from the stored dashboard summary.
const reportedStock = new Map<string, Map<string, number>>();
// Targets whose page (no inventory data) last read as on sale; alerts fire on the transition only.
const pageSignalOnSale = new Set<string>();
// Consecutive failed checks per target.
const failureStreaks = new Map<string, { count: number; key: string }>();

// Failed checks only notify after this many in a row; the dashboard shows every failure.
const FAILURE_NOTIFY_AFTER = 3;
// The same operational notice (per profile / per error kind) repeats at most this often.
const OPS_NOTICE_REPEAT_MS = 2 * 60 * 60 * 1000;

// Returns true when a ticket alert was created. `forceTicketAlert` (portal "Check & send") sends
// the current stock even when it was already reported.
async function handleCheckResult(
  row: TargetRow,
  target: BackendMonitorTarget,
  check: MonitorCheckResult,
  context: AlertContext,
  forceTicketAlert = false,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const update: Record<string, unknown> = {
    status: check.status,
    last_checked_at: nowIso,
    last_response_ms: check.responseMs,
    last_status_code: check.statusCode,
    last_error: check.error,
  };
  // A failed or blocked check says nothing about stock: keep the last real availability text.
  if (check.kind === "ok" || check.kind === "gone") {
    update["availability"] = check.availability;
    update["last_available_at"] = check.status === "available" ? nowIso : row.last_available_at;
  }
  await rest("eventpulse_targets", {
    method: "PATCH",
    query: { id: `eq.${row.id}` },
    body: update,
  });

  if (check.kind === "blocked") {
    await handleBlockedCheck(target, check, context);
    return false;
  }
  if (check.kind === "captcha") return false;
  if (check.kind === "gone") {
    // The target is now paused, so it is not checked again until someone resumes it.
    await clearFailure(target, context);
    await createAndDeliverAlert(
      {
        targetId: row.id,
        tone: "warn",
        operational: true,
        content: dashboardAlert(
          "⏹ HD-1: event page removed",
          `${target.event}: the ticket site no longer has this event page (HTTP ${check.statusCode}), usually because the event is over. Monitoring for it has stopped.\n${target.url}`,
        ),
      },
      context,
    );
    return false;
  }
  if (check.kind === "failed") {
    await handleFailedCheck(target, check, context);
    return false;
  }

  // Successful check: clear failure/block state (one all-clear only if a notice went out).
  await clearFailure(target, context);
  if (!check.usesRotatingProxy && recordProfileSuccess(target.profile)) {
    await resolveOpsNotice(
      `blocked:${target.profile}`,
      "✅ HD-1: profile checks resumed",
      `Ticketmaster is answering profile "${target.profile}" again; ticket checks resumed.`,
      context,
    );
  }

  const report = check.report;
  if (!report) return false;

  if (report.inventoryKnown) {
    pageSignalOnSale.delete(row.id);
    const previous =
      reportedStock.get(row.id) ??
      (row.availability === check.availability ? stockSnapshot(report.matched) : null);
    const newStock = findNewStock(previous, report.matched);
    reportedStock.set(row.id, stockSnapshot(report.matched));
    if (report.totalStock === 0) return false;
    if (newStock.length === 0 && !forceTicketAlert) return false;
  } else {
    const onSale = check.status === "available";
    const wasOnSale =
      pageSignalOnSale.has(row.id) ||
      (row.status === "available" && row.availability === check.availability);
    if (onSale) pageSignalOnSale.add(row.id);
    else pageSignalOnSale.delete(row.id);
    if (!onSale) return false;
    if (wasOnSale && !forceTicketAlert) return false;
  }

  await createAndDeliverAlert(
    {
      targetId: row.id,
      tone: "online",
      content: ticketAlertContent(
        buildTicketAlert({ report, url: target.deepLink, checkedAt: now }),
      ),
    },
    context,
  );
  return true;
}

async function handleBlockedCheck(
  target: BackendMonitorTarget,
  check: MonitorCheckResult,
  context: AlertContext,
) {
  // With a rotating proxy pool each check uses a fresh IP, so a block is not a profile problem.
  if (check.usesRotatingProxy) return;
  const pause = recordProfileBlock(target.profile, check.statusCode ?? 403);
  console.warn(
    `HD-1 profile "${target.profile}" blocked (HTTP ${check.statusCode}); paused until ${pause.pausedUntil} (level ${pause.blockLevel}).`,
  );
  // One notice per block episode; the escalating pauses after it stay on the dashboard only.
  if (pause.blockLevel !== 1) return;
  await sendOpsNotice(
    `blocked:${target.profile}`,
    "⏸ HD-1: profile paused",
    [
      `Ticketmaster asked profile "${target.profile}" for ${check.statusCode === 429 ? "a slower request rate (HTTP 429)" : "identity verification (HTTP 403)"}.`,
      "Its checks are paused and retried automatically. You will get one message when checks resume.",
    ].join("\n"),
    context,
  );
}

async function handleFailedCheck(
  target: BackendMonitorTarget,
  check: MonitorCheckResult,
  context: AlertContext,
) {
  const message = (check.error ?? "Unknown monitor error").replace(/\s+/g, " ").slice(0, 300);
  const key = `failed:${failureKind(message)}`;
  const previous = failureStreaks.get(target.id);
  const count = previous?.key === key ? previous.count + 1 : 1;
  failureStreaks.set(target.id, { count, key });
  console.warn(`HD-1 check failed for ${target.event} (${count} in a row): ${message}`);
  if (count !== FAILURE_NOTIFY_AFTER) return;

  const affected = [...failureStreaks.values()].filter(
    (streak) => streak.key === key && streak.count >= FAILURE_NOTIFY_AFTER,
  ).length;
  await sendOpsNotice(
    key,
    "⚠️ HD-1: ticket checks failing",
    [
      `${target.event} could not be checked ${FAILURE_NOTIFY_AFTER} times in a row${affected > 1 ? ` (${affected} targets affected)` : ""}.`,
      `Reason: ${message}`,
      "Checks keep retrying; you will get one message when they recover.",
    ].join("\n"),
    context,
  );
}

async function clearFailure(target: BackendMonitorTarget, context: AlertContext) {
  const streak = failureStreaks.get(target.id);
  if (!streak) return;
  failureStreaks.delete(target.id);
  if ([...failureStreaks.values()].some((item) => item.key === streak.key)) return;
  await resolveOpsNotice(
    streak.key,
    "✅ HD-1: ticket checks recovered",
    "Targets are being checked normally again.",
    context,
  );
}

// Groups errors that differ only by ids, ports or timings into one notice.
function failureKind(message: string) {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/[0-9a-f]{8,}/g, "id")
    .replace(/\d+/g, "n")
    .slice(0, 80);
}

// Operational notices sent and not yet resolved, with when each was last sent.
const opsNotices = new Map<string, number>();

async function sendOpsNotice(key: string, title: string, body: string, context: AlertContext) {
  const lastSent = opsNotices.get(key);
  if (lastSent && Date.now() - lastSent < OPS_NOTICE_REPEAT_MS) return;
  opsNotices.set(key, Date.now());
  await createAndDeliverAlert(
    { targetId: null, tone: "warn", content: dashboardAlert(title, body), operational: true },
    context,
  );
}

async function resolveOpsNotice(key: string, title: string, body: string, context: AlertContext) {
  if (!opsNotices.delete(key)) return;
  await createAndDeliverAlert(
    { targetId: null, tone: "info", content: dashboardAlert(title, body), operational: true },
    context,
  );
}

function dashboardAlert(title: string, body: string) {
  return plainAlert(title, body, process.env["EVENTPULSE_PUBLIC_URL"] ?? "", "Open dashboard");
}

// System notices (profile paused, checks failing/recovered, event removed, token expiry, monitor
// failure) go to the dashboard alert log only, so Discord/Telegram/push/SMS carry nothing but
// real ticket alerts. Set EVENTPULSE_SYSTEM_NOTICES_TO_CHANNELS=true to also send them to chat.
function systemNoticesToChannels() {
  return process.env["EVENTPULSE_SYSTEM_NOTICES_TO_CHANNELS"] === "true";
}

async function createAndDeliverAlert(
  input: {
    targetId: string | null;
    tone: BackendAlertLog["tone"];
    content: AlertContent;
    operational?: boolean;
  },
  context: AlertContext,
) {
  const deliver =
    hasEnabledDeliveryChannel(context.settings) &&
    (!input.operational || systemNoticesToChannels());
  // Ticket alerts are only recorded when they are delivered; system notices are always logged.
  if (!deliver && !input.operational) return;
  const [alert] = await rest<AlertRow[]>("eventpulse_alerts", {
    method: "POST",
    prefer: "return=representation",
    body: {
      target_id: input.targetId,
      tone: input.tone,
      message: `${input.content.title}\n${input.content.text}`.slice(0, 4000),
      deep_link: input.content.url || null,
    },
  });
  context.result.alertsCreated += 1;
  if (!deliver) return;

  // Deliver in the background so a slow or rate-limited channel never delays the next check;
  // the pass waits for all deliveries before returning.
  context.deliveries.push(
    deliverAlert({
      ...(alert?.id ? { alertId: alert.id } : {}),
      content: input.content,
      settings: context.settings,
      subscriptions: context.subscriptions,
    }),
  );
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
  if (!systemNoticesToChannels()) {
    // Dashboard only; if Supabase itself is down this lands in the server log instead.
    await rest("eventpulse_alerts", {
      method: "POST",
      body: { target_id: null, tone: "warn", message: `${title}\n${body}`, deep_link: null },
    }).catch(() => console.error(`HD-1 ${title}: ${body}`));
    return;
  }
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
    content: dashboardAlert(title, body),
    settings,
    subscriptions,
  });
  if (delivery.errors.length) console.error("HD-1 operational alert issues", delivery.errors);
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
  if (!systemNoticesToChannels()) {
    lastTokenWarning = { key: warningKey, sentAt: Date.now() };
    return;
  }

  const delivery = await deliverAlert({
    ...(alert?.id ? { alertId: alert.id } : {}),
    content: dashboardAlert("⚠️ HD-1: MultiLogin token", alertMessage),
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
  let usesRotatingProxy = false;
  try {
    usesRotatingProxy = hasConfiguredScraperProxyPool();
    if (!isApprovedMultiloginProfile(target.profile)) {
      throw new Error(
        `Target is not assigned to an approved Multilogin profile: ${target.profile}`,
      );
    }
    if (!profile?.multilogin_profile_id || !profile.multilogin_folder_id) {
      throw new Error(`Approved Multilogin profile mapping is incomplete: ${target.profile}`);
    }

    if (!usesRotatingProxy) profileLastLoadAt.set(target.profile, Date.now());
    const response = await readRenderedTicketPage({
      endpoint: process.env["MULTILOGIN_LAUNCHER_ENDPOINT"] ?? settings.multiloginEndpoint,
      folderId: profile.multilogin_folder_id,
      profileId: profile.multilogin_profile_id,
      profileName: profile.profile_name,
      url: target.url,
    });
    return interpretTicketPage(target, response, {
      responseMs: Date.now() - started,
      usesRotatingProxy,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown monitor error";
    return {
      kind: "failed",
      status: "limited",
      availability: "",
      responseMs: Date.now() - started,
      statusCode: null,
      error: message.slice(0, 1200),
      usesRotatingProxy,
      report: null,
    };
  }
}

type DeliveryResult = Omit<MonitorRunResult, "checked" | "alertsCreated">;

// One alert, rendered for every channel. Ticket alerts carry rich Telegram HTML and a Discord
// embed; operational notes use plainAlert.
type AlertContent = {
  title: string;
  text: string;
  url: string;
  buttonLabel: string;
  telegramHtml: string;
  discordEmbed: Record<string, unknown> | null;
  imageUrl: string | null;
};

function plainAlert(title: string, body: string, url: string, buttonLabel: string): AlertContent {
  return {
    title,
    text: body,
    url,
    buttonLabel,
    telegramHtml: `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`,
    discordEmbed: null,
    imageUrl: null,
  };
}

function ticketAlertContent(alert: TicketAlertContent): AlertContent {
  return {
    title: alert.title,
    text: alert.text,
    url: alert.url,
    buttonLabel: "Buy Tickets",
    telegramHtml: alert.telegramHtml,
    discordEmbed: alert.discordEmbed,
    imageUrl: alert.imageUrl,
  };
}

async function deliverAlert(input: {
  alertId?: string;
  content: AlertContent;
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
  const { content } = input;

  // Push shows the title separately; SMS/WhatsApp get it as the first line of the message.
  const text = `${content.title}\n${content.text}`;
  [result.pushSent, result.smsSent, result.whatsappSent, result.telegramSent, result.discordSent] =
    await Promise.all([
      input.settings.pushAlerts && channelAllowed("push") && input.subscriptions.length > 0
        ? deliverChannel("Web push", result.errors, () =>
            sendWebPush(
              content.title,
              content.text.slice(0, 600),
              content.url,
              input.subscriptions,
              result.errors,
            ),
          )
        : 0,
      input.settings.smsAlerts && channelAllowed("sms")
        ? deliverChannel("Twilio SMS", result.errors, () =>
            sendTwilioMessage("sms", text, result.errors),
          )
        : 0,
      input.settings.whatsappAlerts && channelAllowed("whatsapp")
        ? deliverChannel("Twilio WhatsApp", result.errors, () =>
            sendTwilioMessage("whatsapp", text, result.errors),
          )
        : 0,
      input.settings.telegramAlerts && channelAllowed("telegram")
        ? deliverChannel("Telegram", result.errors, () =>
            sendTelegramMessage(content, result.errors),
          )
        : 0,
      input.settings.discordAlerts && channelAllowed("discord")
        ? deliverChannel("Discord", result.errors, () => sendDiscordMessage(content, result.errors))
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

type TelegramRich = { html: string; buttonLabel: string; url: string; photoUrl: string | null };
type DiscordRich = { embed: Record<string, unknown>; buttonLabel: string; url: string };

const telegramQueues = new Map<string, ChannelQueue<TelegramRich>>();
const discordQueues = new Map<string, ChannelQueue<DiscordRich>>();

async function sendTelegramMessage(content: AlertContent, errors: string[]) {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatIds = parseRecipients(process.env["TELEGRAM_CHAT_IDS"]);
  if (!token || chatIds.length === 0) {
    errors.push("Telegram env missing; message not sent.");
    return 0;
  }

  const message = {
    text: `${content.title}\n${content.text}`,
    rich: {
      html: content.telegramHtml,
      buttonLabel: content.buttonLabel,
      url: content.url,
      photoUrl: content.imageUrl,
    },
  };
  const results = await Promise.all(
    chatIds.map((chatId) => telegramQueue(token, chatId).enqueue(message, errors)),
  );
  return results.filter(Boolean).length;
}

function telegramQueue(token: string, chatId: string) {
  const key = `${token}:${chatId}`;
  let queue = telegramQueues.get(key);
  if (!queue) {
    queue = new ChannelQueue<TelegramRich>({
      label: `Telegram ${chatId}`,
      // Telegram allows ~1 message/second per chat and 20 messages/minute per group or channel.
      minIntervalMs: chatId.startsWith("-") ? 3_100 : 1_100,
      maxLength: 4_096,
      send: async (message) => {
        // TELEGRAM_API_BASE_URL exists for local end-to-end tests against a fake Bot API.
        const api = `${process.env["TELEGRAM_API_BASE_URL"] || "https://api.telegram.org"}/bot${token}`;
        const rich = message.rich;
        if (!rich) {
          return await postJson(`${api}/sendMessage`, {
            chat_id: chatId,
            text: message.text,
            link_preview_options: { is_disabled: true },
          });
        }

        const replyMarkup = isHttpUrl(rich.url)
          ? { inline_keyboard: [[{ text: rich.buttonLabel, url: rich.url }]] }
          : undefined;
        // Photo captions are limited to 1024 characters; longer alerts go as a text message.
        if (rich.photoUrl && rich.html.length <= 1_024) {
          const photo = await postJson(`${api}/sendPhoto`, {
            chat_id: chatId,
            photo: rich.photoUrl,
            caption: rich.html,
            parse_mode: "HTML",
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          // A photo Telegram cannot fetch must not cost the alert: fall back to text.
          if (photo.ok || photo.status !== 400) return photo;
        }
        const sent = await postJson(`${api}/sendMessage`, {
          chat_id: chatId,
          text: rich.html.slice(0, 4_096),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (sent.ok || sent.status !== 400) return sent;
        // Last resort if the HTML is rejected: plain text with the link.
        return await postJson(`${api}/sendMessage`, {
          chat_id: chatId,
          text: `${message.text}`.slice(0, 4_096),
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      },
    });
    telegramQueues.set(key, queue);
  }
  return queue;
}

async function sendDiscordMessage(content: AlertContent, errors: string[]) {
  const webhookUrls = parseRecipients(process.env["DISCORD_WEBHOOK_URLS"]);
  if (webhookUrls.length === 0) {
    errors.push("Discord env missing; message not sent.");
    return 0;
  }

  const plain = [content.title, content.text, isHttpUrl(content.url) ? content.url : ""]
    .filter(Boolean)
    .join("\n");
  const message = content.discordEmbed
    ? {
        text: plain,
        rich: { embed: content.discordEmbed, buttonLabel: content.buttonLabel, url: content.url },
      }
    : { text: plain };
  const results = await Promise.all(
    webhookUrls.map((webhookUrl) => discordQueue(webhookUrl).enqueue(message, errors)),
  );
  return results.filter(Boolean).length;
}

function discordQueue(webhookUrl: string) {
  let queue = discordQueues.get(webhookUrl);
  if (!queue) {
    queue = new ChannelQueue<DiscordRich>({
      label: `Discord webhook #${discordQueues.size + 1}`,
      // Discord webhooks allow 5 requests / 2 seconds and roughly 30 messages/minute per channel.
      minIntervalMs: 2_100,
      maxLength: 2_000,
      send: async (message) => {
        const rich = message.rich;
        if (!rich) {
          return await postJson(webhookUrl, {
            content: message.text,
            allowed_mentions: { parse: [] },
          });
        }
        const body = { embeds: [rich.embed], allowed_mentions: { parse: [] } };
        if (isHttpUrl(rich.url)) {
          // A real "Buy Tickets" link button under the embed (webhooks accept link buttons with
          // with_components=true). If Discord rejects it, the embed's own link still works.
          const withButton = await postJson(withQuery(webhookUrl, "with_components", "true"), {
            ...body,
            components: [
              {
                type: 1,
                components: [{ type: 2, style: 5, label: rich.buttonLabel, url: rich.url }],
              },
            ],
          });
          if (withButton.ok || withButton.status !== 400) return withButton;
        }
        return await postJson(webhookUrl, body);
      },
    });
    discordQueues.set(webhookUrl, queue);
  }
  return queue;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  return await toChannelResult(response);
}

// EVENTPULSE_ONLY_CHANNELS=discord (comma list) limits delivery to those channels, e.g. when
// running the portal locally against production data without reaching the client's Telegram.
function channelAllowed(channel: "push" | "sms" | "whatsapp" | "telegram" | "discord") {
  const only = process.env["EVENTPULSE_ONLY_CHANNELS"]?.trim();
  if (!only) return true;
  return only
    .toLowerCase()
    .split(",")
    .map((item) => item.trim())
    .includes(channel);
}

function withQuery(url: string, key: string, value: string) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

function isHttpUrl(value: string) {
  return /^https?:\/\/[^\s]+$/i.test(value);
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
