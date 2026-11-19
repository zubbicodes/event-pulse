import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { getMultiloginTokenHealth } from "./lib/eventpulse/multilogin-browser.server";
import {
  getMonitorFreshness,
  notifyMonitorFailure,
  notifyMonitorFreshness,
  notifyMonitorRecovered,
  runMonitorPass,
} from "./lib/eventpulse/supabase.server";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;
let scheduledMonitorRunning = false;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

function startMonitorScheduler() {
  if (process.env["EVENTPULSE_SCHEDULER_ENABLED"] !== "true") return;

  const configuredTick = Number(process.env["EVENTPULSE_SCHEDULER_TICK_MS"] ?? 1_000);
  const tickMs = Number.isFinite(configuredTick)
    ? Math.min(Math.max(configuredTick, 1_000), 60_000)
    : 1_000;
  const timer = setInterval(() => void runScheduledMonitorPass(), tickMs);
  timer.unref?.();

  const initialRun = setTimeout(() => void runScheduledMonitorPass(), 1_000);
  initialRun.unref?.();
  console.info(`HD-1 monitor scheduler enabled (${tickMs}ms tick).`);
}

async function runScheduledMonitorPass() {
  if (scheduledMonitorRunning) return;
  scheduledMonitorRunning = true;
  try {
    const result = await runMonitorPass();
    if (result.checked > 0 || result.errors.length > 0) {
      console.info("HD-1 monitor pass", result);
    }
    await notifyMonitorRecovered().catch((notifyError: unknown) =>
      console.error("HD-1 monitor recovery alert failed", notifyError),
    );
    await notifyMonitorFreshness().catch((notifyError: unknown) =>
      console.error("HD-1 monitor freshness alert failed", notifyError),
    );
  } catch (error) {
    console.error("HD-1 scheduled monitor pass failed", error);
    await notifyMonitorFailure(error).catch((notifyError: unknown) =>
      console.error("HD-1 monitor failure alert failed", notifyError),
    );
  } finally {
    scheduledMonitorRunning = false;
  }
}

startMonitorScheduler();

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/eventpulse/health") {
        // Always HTTP 200 / ok:true: this also backs the Docker health check, and a blocked ticket
        // site must not make the platform restart the container. `monitor` tells the real story.
        return Response.json({
          ok: true,
          multiloginToken: getMultiloginTokenHealth(),
          monitor: await getMonitorFreshness(),
        });
      }
      if (url.pathname === "/api/eventpulse/monitor-run") {
        return await handleMonitorRun(request);
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};

async function handleMonitorRun(request: Request) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const configuredSecret = process.env["EVENTPULSE_CRON_SECRET"];
  const suppliedSecret =
    request.headers.get("x-eventpulse-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (configuredSecret && suppliedSecret !== configuredSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!configuredSecret && process.env["NODE_ENV"] === "production") {
    return Response.json(
      { error: "EVENTPULSE_CRON_SECRET is required in production." },
      { status: 500 },
    );
  }

  try {
    const result = await runMonitorPass();
    await notifyMonitorRecovered().catch((notifyError: unknown) =>
      console.error("HD-1 monitor recovery alert failed", notifyError),
    );
    return Response.json(result);
  } catch (error) {
    console.error("HD-1 monitor-run pass failed", error);
    await notifyMonitorFailure(error).catch((notifyError: unknown) =>
      console.error("HD-1 monitor failure alert failed", notifyError),
    );
    return Response.json({ error: "Monitor pass failed." }, { status: 500 });
  }
}
