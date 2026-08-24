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
  created_at: string;
};

type SettingsRow = {
  refresh_seconds: number;
  sound_alerts: boolean;
  push_alerts: boolean;
  sms_alerts: boolean;
  whatsapp_alerts: boolean;
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
  shouldAlert: boolean;
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

  const mappedTargets = targets.map(mapTarget);
  const mappedAlerts = alerts.map(mapAlert);
  const mappedProfiles = profiles.map(mapProfile);

  const responseTimes = mappedTargets
    .map((target) => target.responseMs)
    .filter((value): value is number => typeof value === "number");

  return {
    targets: mappedTargets,
    profiles: mappedProfiles,
    alerts: mappedAlerts,
    settings: settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS,
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
    if (!isMissingProfileSettingsColumn(error)) throw error;
    const {
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
    prefer: "resolution=merge-duplicates",
    body: {
      endpoint: input.endpoint,
      subscription: input.subscription,
      user_agent: input.userAgent,
    },
  });
  return { ok: true };
}

export async function runMonitorPass(): Promise<MonitorRunResult> {
  if (!isConfigured()) {
    return {
      checked: 0,
      alertsCreated: 0,
      pushSent: 0,
      smsSent: 0,
      whatsappSent: 0,
      errors: ["Supabase is not configured."],
    };
  }

  const [targets, settingsRows, subscriptions] = await Promise.all([
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
  ]);

  const settings = settingsRows[0] ? mapSettings(settingsRows[0]) : DEFAULT_SETTINGS;
  const dueTargets = targets.filter(isTargetDue);
  const result: MonitorRunResult = {
    checked: 0,
    alertsCreated: 0,
    pushSent: 0,
    smsSent: 0,
    whatsappSent: 0,
    errors: [],
  };

  for (const row of dueTargets) {
    result.checked += 1;
    const target = mapTarget(row);
    const check = await checkTarget(target);
    const now = new Date().toISOString();
    const nextStatus =
      check.status === "available" && row.status === "available" ? "monitoring" : check.status;

    await rest("eventpulse_targets", {
      method: "PATCH",
      query: { id: `eq.${row.id}` },
      body: {
        status: nextStatus,
        availability: check.availability,
        last_checked_at: now,
        last_response_ms: check.responseMs,
        last_status_code: check.statusCode,
        last_error: check.error,
        last_available_at: check.status === "available" ? now : row.last_available_at,
      },
    });

    if (!check.shouldAlert || row.status === "available") continue;

    const alertMessage = `${target.event}: ${check.availability}`;
    const [alert] = await rest<AlertRow[]>("eventpulse_alerts", {
      method: "POST",
      prefer: "return=representation",
      body: {
        target_id: row.id,
        tone: check.status === "available" ? "online" : "warn",
        message: alertMessage,
        deep_link: target.deepLink,
      },
    });
    result.alertsCreated += 1;

    const delivery = await deliverAlert({
      ...(alert?.id ? { alertId: alert.id } : {}),
      title: "HD-1 Drop Monitor ticket alert",
      body: alertMessage,
      url: target.deepLink,
      settings,
      subscriptions,
    });
    result.pushSent += delivery.pushSent;
    result.smsSent += delivery.smsSent;
    result.whatsappSent += delivery.whatsappSent;
    result.errors.push(...delivery.errors);
  }

  return result;
}

function mapTarget(row: TargetRow): BackendMonitorTarget {
  return {
    id: row.id,
    platform: row.platform as BackendMonitorTarget["platform"],
    event: row.event_name,
    venue: row.venue,
    status: row.status,
    availability: row.availability,
    url: row.target_url,
    refresh: Number(row.refresh_seconds),
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
  };
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
    autoRotateProxyOnRateLimit: row.auto_rotate_proxy_on_rate_limit ?? true,
    maintainStickyMobileIp: row.maintain_sticky_mobile_ip ?? false,
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

function isTargetDue(row: TargetRow) {
  const now = Date.now();
  if (row.monitor_starts_at && now < new Date(row.monitor_starts_at).getTime()) return false;
  if (row.monitor_ends_at && now > new Date(row.monitor_ends_at).getTime()) return false;
  if (!row.last_checked_at) return true;
  const ageMs = now - new Date(row.last_checked_at).getTime();
  return ageMs >= Number(row.refresh_seconds) * 1000;
}

function formatWatchSummary(input: NewTargetInput) {
  const quantity = input.evenTicketQuantitiesOnly
    ? `even quantities from ${input.minTickets}+`
    : `${input.minTickets}+`;
  return `Watching ${quantity} ${input.normalTicketsOnly ? "standard" : "any"} tickets`;
}

async function checkTarget(target: BackendMonitorTarget): Promise<MonitorCheckResult> {
  const started = Date.now();
  try {
    const response = await fetch(target.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });
    const text = await response.text();
    const lower = text.toLowerCase();
    const responseMs = Date.now() - started;

    if (response.status === 429 || response.status === 403) {
      return {
        status: "limited",
        availability: `Blocked or rate limited (${response.status})`,
        responseMs,
        statusCode: response.status,
        error: null,
        shouldAlert: false,
      };
    }

    if (lower.includes("captcha") || lower.includes("verify you are human")) {
      return {
        status: "captcha",
        availability: "Captcha challenge detected",
        responseMs,
        statusCode: response.status,
        error: null,
        shouldAlert: false,
      };
    }

    const sectionHit =
      target.filters.sectionFilters.length === 0 ||
      target.filters.sectionFilters.some((section) => lower.includes(section.toLowerCase()));
    const positiveHit = [
      "tickets available",
      "buy tickets",
      "resale ticket",
      "select seats",
      "available now",
    ].some((needle) => lower.includes(needle));
    const negativeHit = [
      "sold out",
      "no tickets available",
      "currently unavailable",
      "not currently available",
    ].some((needle) => lower.includes(needle));

    if (response.ok && sectionHit && positiveHit && !negativeHit) {
      return {
        status: "available",
        availability: `${target.filters.minTickets}+ tickets matched filters`,
        responseMs,
        statusCode: response.status,
        error: null,
        shouldAlert: true,
      };
    }

    return {
      status: "monitoring",
      availability: "No matching inventory detected",
      responseMs,
      statusCode: response.status,
      error: null,
      shouldAlert: false,
    };
  } catch (error) {
    return {
      status: "limited",
      availability: "Target check failed",
      responseMs: Date.now() - started,
      statusCode: null,
      error: error instanceof Error ? error.message : "Unknown monitor error",
      shouldAlert: false,
    };
  }
}

async function deliverAlert(input: {
  alertId?: string;
  title: string;
  body: string;
  url: string;
  settings: BackendSettings;
  subscriptions: PushSubscriptionRow[];
}) {
  const result = { pushSent: 0, smsSent: 0, whatsappSent: 0, errors: [] as string[] };

  if (input.settings.pushAlerts && input.subscriptions.length > 0) {
    result.pushSent = await sendWebPush(
      input.title,
      input.body,
      input.url,
      input.subscriptions,
      result.errors,
    );
  }
  if (input.settings.smsAlerts) {
    result.smsSent = await sendTwilioMessage("sms", input.body, result.errors);
  }
  if (input.settings.whatsappAlerts) {
    result.whatsappSent = await sendTwilioMessage("whatsapp", input.body, result.errors);
  }

  if (input.alertId) {
    await rest("eventpulse_alerts", {
      method: "PATCH",
      query: { id: `eq.${input.alertId}` },
      body: {
        delivered_push: result.pushSent > 0,
        delivered_sms: result.smsSent > 0,
        delivered_whatsapp: result.whatsappSent > 0,
      },
    });
  }

  return result;
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
    const response = await fetch(
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
