import { lookup } from "node:dns/promises";
import puppeteer from "puppeteer-core";
import { captureTicketPage } from "./page-capture.server.ts";
import { localBrowserEnabled, readWithLocalBrowser } from "./local-browser.server.ts";

// The client's Multilogin profiles that monitor targets may be assigned to. A profile only checks
// pages once a target is assigned to it.
const APPROVED_PROFILE_NAMES = new Set([
  "PERS - timothy.coughlan01@gmail.com",
  "PERS - jackbarnabysmith@gmail.com",
  "PERS - jasraghwani99@gmail.com",
  "PERS - kajnathwani@gmail.com",
]);
const MULTILOGIN_API_URL = "https://api.multilogin.com";
const PROXY_CACHE_MS = 10 * 60 * 1000;
const MULTILOGIN_TIMEOUT_MS = 20_000;
type RenderedPageInput = {
  endpoint: string;
  folderId: string;
  profileId: string;
  profileName: string;
  url: string;
};

type LauncherState = {
  port?: number | string;
  profile_id?: string;
  status?: string;
};

type LauncherResponse = {
  data?: {
    id?: string;
    port?: number | string;
    states?: Record<string, LauncherState>;
  };
  status?: {
    message?: string;
  };
};

type ProxyCredentials = {
  password: string;
  username: string;
};

type ScraperProxy = {
  host: string;
  password?: string;
  port: number;
  type: "http" | "socks5";
  username?: string;
};

export type MultiloginTokenHealth = {
  automation: boolean | null;
  expiresAt: string | null;
  remainingSeconds: number | null;
  status: "missing" | "unknown" | "valid" | "expiring" | "expired" | "non-expiring";
};

export function isApprovedMultiloginProfile(profileName: string) {
  return APPROVED_PROFILE_NAMES.has(profileName);
}

export function hasConfiguredScraperProxyPool() {
  return parseScraperProxyPool(process.env["MULTILOGIN_SCRAPER_PROXIES"]).length > 0;
}

export function getMultiloginTokenHealth(now = Date.now()): MultiloginTokenHealth {
  const token = process.env["MULTILOGIN_API_TOKEN"];
  if (!token) {
    return { automation: null, expiresAt: null, remainingSeconds: null, status: "missing" };
  }

  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      exp?: unknown;
      isAutomation?: unknown;
    };
    const automation = typeof payload.isAutomation === "boolean" ? payload.isAutomation : null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return {
        automation,
        expiresAt: null,
        remainingSeconds: null,
        status: automation ? "non-expiring" : "unknown",
      };
    }

    const remainingSeconds = Math.floor(payload.exp - now / 1000);
    const warningHours = Number(process.env["MULTILOGIN_TOKEN_EXPIRY_WARNING_HOURS"] ?? 72);
    const warningSeconds =
      (Number.isFinite(warningHours) ? Math.min(Math.max(warningHours, 1), 720) : 72) * 3600;
    return {
      automation,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      remainingSeconds,
      status:
        remainingSeconds <= 0
          ? "expired"
          : remainingSeconds <= warningSeconds
            ? "expiring"
            : "valid",
    };
  } catch {
    return { automation: null, expiresAt: null, remainingSeconds: null, status: "unknown" };
  }
}

export async function readRenderedTicketPage(input: RenderedPageInput) {
  if (!isApprovedMultiloginProfile(input.profileName)) {
    throw new Error(`Multilogin profile is not approved for monitoring: ${input.profileName}`);
  }
  if (localBrowserEnabled()) return readWithLocalBrowser(input.url);

  const token = process.env["MULTILOGIN_API_TOKEN"];
  if (!token) throw new Error("MULTILOGIN_API_TOKEN is missing.");

  const scraperProxy = nextScraperProxy();
  if (scraperProxy) {
    return readWithQuickProfile(input, token, scraperProxy);
  }

  const port = await ensureProfileRunning(input, token);
  return readPageFromPort(port, input.url, await proxyCredentialsFor(input.profileId, token));
}

async function readWithQuickProfile(input: RenderedPageInput, token: string, proxy: ScraperProxy) {
  const quickProfile = await startQuickProfile(input.endpoint, token, proxy);
  try {
    return await readPageFromPort(quickProfile.port, input.url);
  } finally {
    await stopProfile(input.endpoint, token, quickProfile.id);
  }
}

async function readPageFromPort(port: number, url: string, credentials?: ProxyCredentials) {
  const cdpHost = await resolveCdpHost();
  const browser = await puppeteer.connect({
    browserURL: `http://${formatHost(cdpHost)}:${port}`,
    protocolTimeout: MULTILOGIN_TIMEOUT_MS,
  });

  const page = await browser.newPage();
  try {
    if (credentials) await page.authenticate(credentials);
    const { jsonResponseUrls: _diagnostics, ...captured } = await captureTicketPage(page, url);
    return captured;
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    browser.disconnect();
  }
}

let scraperProxyCursor = 0;

function nextScraperProxy() {
  const proxies = parseScraperProxyPool(process.env["MULTILOGIN_SCRAPER_PROXIES"]);
  if (proxies.length === 0) return null;
  const proxy = proxies[scraperProxyCursor % proxies.length]!;
  scraperProxyCursor = (scraperProxyCursor + 1) % proxies.length;
  return proxy;
}

function parseScraperProxyPool(raw: string | undefined): ScraperProxy[] {
  if (!raw?.trim()) return [];

  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error("MULTILOGIN_SCRAPER_PROXIES must be a JSON array of proxy URLs.");
  }
  if (!Array.isArray(values)) {
    throw new Error("MULTILOGIN_SCRAPER_PROXIES must be a JSON array of proxy URLs.");
  }
  if (values.length > 100) {
    throw new Error("MULTILOGIN_SCRAPER_PROXIES supports up to 100 proxy URLs.");
  }

  return values.map((value, index) => parseScraperProxy(value, index));
}

function parseScraperProxy(value: unknown, index: number): ScraperProxy {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Scraper proxy #${index + 1} must be a non-empty URL.`);
  }

  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    throw new Error(`Scraper proxy #${index + 1} is invalid.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "socks5:") {
    throw new Error(`Scraper proxy #${index + 1} must use http:// or socks5://.`);
  }
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Scraper proxy #${index + 1} must include a valid host and port.`);
  }

  return {
    host: url.hostname,
    port,
    type: url.protocol === "socks5:" ? "socks5" : "http",
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

async function startQuickProfile(endpoint: string, token: string, proxy: ScraperProxy) {
  const response = await fetch(new URL("/api/v3/profile/quick", normalizeEndpoint(endpoint)), {
    method: "POST",
    headers: { ...launcherHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      browser_type: "mimic",
      os_type: "linux",
      automation: "puppeteer",
      is_headless: process.env["MULTILOGIN_HEADLESS"] === "true",
      parameters: {
        flags: {
          navigator_masking: "mask",
          audio_masking: "mask",
          localization_masking: "mask",
          geolocation_popup: "prompt",
          geolocation_masking: "mask",
          timezone_masking: "mask",
          canvas_noise: "natural",
          graphics_noise: "natural",
          graphics_masking: "mask",
          webrtc_masking: "natural",
          fonts_masking: "mask",
          media_devices_masking: "mask",
          screen_masking: "mask",
          proxy_masking: "custom",
          ports_masking: "mask",
        },
        proxy,
        fingerprint: {},
      },
    }),
    signal: AbortSignal.timeout(MULTILOGIN_TIMEOUT_MS),
  });
  const body = (await response.json()) as LauncherResponse;
  const port = parsePort(body.data?.port);
  const id = body.data?.id;
  if (response.ok && port && id) return { id, port };

  throw new Error(
    `Multilogin quick profile failed (${response.status}): ${body.status?.message || "No response message."}`,
  );
}

async function stopProfile(endpoint: string, token: string, profileId: string) {
  const response = await fetch(
    new URL(`/api/v1/profile/stop/p/${encodeURIComponent(profileId)}`, normalizeEndpoint(endpoint)),
    {
      headers: launcherHeaders(token),
      signal: AbortSignal.timeout(MULTILOGIN_TIMEOUT_MS),
    },
  ).catch(() => null);
  if (response && !response.ok && response.status !== 500) {
    console.error(`Multilogin quick profile stop failed (${response.status}).`);
  }
}

// MULTILOGIN_PROXY_CREDENTIALS overrides per profile; otherwise the credentials of the proxy saved
// on the Multilogin profile are used, so any approved profile works without editing env vars.
async function proxyCredentialsFor(profileId: string, token: string): Promise<ProxyCredentials> {
  const raw = process.env["MULTILOGIN_PROXY_CREDENTIALS"];
  if (raw) {
    let credentialsByProfile: Record<string, Partial<ProxyCredentials>>;
    try {
      credentialsByProfile = JSON.parse(raw) as Record<string, Partial<ProxyCredentials>>;
    } catch {
      throw new Error("MULTILOGIN_PROXY_CREDENTIALS must be valid JSON.");
    }
    const credentials = credentialsByProfile[profileId];
    if (credentials?.username && credentials.password) {
      return { username: credentials.username, password: credentials.password };
    }
  }

  const credentials = (await loadWorkspaceProxyCredentials(token)).get(profileId);
  if (!credentials) {
    throw new Error(`Proxy credentials are missing for Multilogin profile: ${profileId}`);
  }
  return credentials;
}

let workspaceProxyCache: { loadedAt: number; byProfile: Map<string, ProxyCredentials> } | null =
  null;

async function loadWorkspaceProxyCredentials(token: string) {
  if (workspaceProxyCache && Date.now() - workspaceProxyCache.loadedAt < PROXY_CACHE_MS) {
    return workspaceProxyCache.byProfile;
  }

  const response = await fetch(`${MULTILOGIN_API_URL}/profile/search`, {
    method: "POST",
    headers: { ...launcherHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ is_removed: false, limit: 100, offset: 0, search_text: "" }),
    signal: AbortSignal.timeout(MULTILOGIN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Multilogin profile search failed (${response.status}).`);
  }

  const body = (await response.json()) as {
    data?: { profiles?: { id?: string; proxy?: { username?: string; password?: string } }[] };
  };
  const byProfile = new Map<string, ProxyCredentials>();
  for (const profile of body.data?.profiles ?? []) {
    if (profile.id && profile.proxy?.username && profile.proxy.password) {
      byProfile.set(profile.id, {
        username: profile.proxy.username,
        password: profile.proxy.password,
      });
    }
  }
  workspaceProxyCache = { loadedAt: Date.now(), byProfile };
  return byProfile;
}

async function ensureProfileRunning(input: RenderedPageInput, token: string) {
  const existingPort = await findRunningProfilePort(input.endpoint, input.profileId, token);
  if (existingPort) return existingPort;

  const endpoint = normalizeEndpoint(input.endpoint);
  const url = new URL(
    `/api/v2/profile/f/${encodeURIComponent(input.folderId)}/p/${encodeURIComponent(input.profileId)}/start`,
    endpoint,
  );
  url.searchParams.set("automation_type", "puppeteer");
  url.searchParams.set(
    "headless_mode",
    process.env["MULTILOGIN_HEADLESS"] === "true" ? "true" : "false",
  );

  const response = await fetch(url, {
    headers: launcherHeaders(token),
    signal: AbortSignal.timeout(MULTILOGIN_TIMEOUT_MS),
  });
  const body = (await response.json()) as LauncherResponse;
  const port = parsePort(body.data?.port);
  if (response.ok && port) return port;

  // Another monitor pass may have started the same profile between status and launch calls.
  if (body.status?.message?.toLowerCase().includes("browser process is running")) {
    const runningPort = await findRunningProfilePort(input.endpoint, input.profileId, token);
    if (runningPort) return runningPort;
  }

  throw new Error(
    `Multilogin launch failed (${response.status}): ${body.status?.message || "No response message."}`,
  );
}

async function findRunningProfilePort(endpoint: string, profileId: string, token: string) {
  const response = await fetch(new URL("/api/v1/profile/statuses", normalizeEndpoint(endpoint)), {
    headers: launcherHeaders(token),
    signal: AbortSignal.timeout(MULTILOGIN_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as LauncherResponse;
  const states = Object.values(body.data?.states ?? {});
  const state = states.find(
    (candidate) =>
      candidate.profile_id === profileId && candidate.status?.toLowerCase() === "browser_running",
  );
  return parsePort(state?.port);
}

async function resolveCdpHost() {
  const configuredHost = process.env["MULTILOGIN_CDP_HOST"]?.trim();
  const candidate = configuredHost || "host.docker.internal";
  if (candidate === "127.0.0.1" || candidate === "localhost") return candidate;

  try {
    return (await lookup(candidate, { family: 4 })).address;
  } catch {
    if (configuredHost) throw new Error(`Unable to resolve MULTILOGIN_CDP_HOST: ${configuredHost}`);
    return "127.0.0.1";
  }
}

function launcherHeaders(token: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${token}` };
}

function normalizeEndpoint(endpoint: string) {
  return new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
}

function parsePort(value: number | string | undefined) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function formatHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
