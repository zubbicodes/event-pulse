import { lookup } from "node:dns/promises";
import puppeteer, { type Page } from "puppeteer-core";

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
const TICKETMASTER_IDENTIFY_TIMEOUT_MS = 20_000;

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

export type MultiloginTokenHealth = {
  automation: boolean | null;
  expiresAt: string | null;
  remainingSeconds: number | null;
  status: "missing" | "unknown" | "valid" | "expiring" | "expired" | "non-expiring";
};

export function isApprovedMultiloginProfile(profileName: string) {
  return APPROVED_PROFILE_NAMES.has(profileName);
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

  const token = process.env["MULTILOGIN_API_TOKEN"];
  if (!token) throw new Error("MULTILOGIN_API_TOKEN is missing.");

  const port = await ensureProfileRunning(input, token);
  const cdpHost = await resolveCdpHost();
  const browser = await puppeteer.connect({
    browserURL: `http://${formatHost(cdpHost)}:${port}`,
    protocolTimeout: MULTILOGIN_TIMEOUT_MS,
  });

  const page = await browser.newPage();
  try {
    await page.authenticate(await proxyCredentialsFor(input.profileId, token));
    page.setDefaultNavigationTimeout(MULTILOGIN_TIMEOUT_MS);
    let latestNavigationStatus: number | null = null;
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        latestNavigationStatus = response.status();
      }
    });

    const response = await page.goto(input.url, {
      waitUntil: "domcontentloaded",
      timeout: MULTILOGIN_TIMEOUT_MS,
    });
    if (response?.status() === 401 && isTicketmasterUrl(input.url)) {
      await waitForTicketmasterIdentification(page);
    }
    await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 8_000 }).catch(() => undefined);

    const statusCode = latestNavigationStatus ?? response?.status() ?? 200;
    return {
      html: await page.content(),
      statusCode,
      responseOk: statusCode >= 200 && statusCode < 400,
    };
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    browser.disconnect();
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

async function waitForTicketmasterIdentification(page: Page) {
  await page
    .waitForFunction(
      () => {
        const bodyText = document.body?.innerText.trim() ?? "";
        return document.title.trim().length > 0 && bodyText !== '{"response":"identify"}';
      },
      { polling: 500, timeout: TICKETMASTER_IDENTIFY_TIMEOUT_MS },
    )
    .catch(() => undefined);
}

function isTicketmasterUrl(value: string) {
  try {
    return new URL(value).hostname.endsWith("ticketmaster.co.uk");
  } catch {
    return false;
  }
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
