// End-to-end check of the real production build:
//   built server (.output) -> fake Supabase REST -> fake Multilogin launcher -> real headless
//   Chromium in Docker (CDP) -> fake ticket site replaying real Ticketmaster UK responses (event
//   JSON-LD, ISMDS facets, quickpicks) at the real URL paths -> fake Telegram Bot API and
//   Discord webhook that record every message.
//
// Usage: npm run build && npm run test:e2e   (Docker must be running)

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { EVENTS, billBaileyScenario, loadEvent } from "../fixtures.mjs";

// Short per-profile interval so the run is quick but the limit is still exercised.
const PROFILE_INTERVAL_SECONDS = 3;

const EVENT_ID = EVENTS.billBailey.id;
const QUIET_ID = EVENTS.elbowSoldOut.id;

const PORTS = {
  site: 18080,
  supabase: 18081,
  launcher: 18082,
  chat: 18083,
  app: 13000,
  cdp: 19222,
};
const CHROME_IMAGE = "chromedp/headless-shell:latest";
const CONTAINER = "hd1-e2e-chrome";
const PROFILE_A = "PERS - kajnathwani@gmail.com";
const PROFILE_B = "PERS - jasraghwani99@gmail.com";

if (!existsSync(".output/server/index.mjs")) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Scenario state the fakes read from

const site = { mode: "stock", resaleCount: 1, quietGone: false, requests: 0 };
const launcher = { profileBFails: true };
const sent = { telegram: [], discord: [] };
let seen = 0;

// ---------------------------------------------------------------------------------------------
// Fake ticket site

listen(PORTS.site, (req, res, url) => {
  site.requests += 1;
  const eventPath = url.pathname.match(/^\/event\/([A-Z0-9]+)$/);
  if (eventPath) {
    if (site.mode === "blocked" && eventPath[1] === EVENT_ID) {
      return send(
        res,
        403,
        "<html><head><title>Let's Get Your Identity Verified</title></head></html>",
        "text/html",
      );
    }
    const id = eventPath[1];
    if (id === QUIET_ID && site.quietGone) return send(res, 410, "<html>Gone</html>", "text/html");
    const event = id === EVENT_ID ? EVENTS.billBailey : EVENTS.elbowSoldOut;
    // Like the real page, the browser fetches facets and quickpicks itself after load.
    const html = loadEvent(event).html.replace(
      "</body>",
      `<script>fetch('/api/ismds/host/${id}/facets?q=available&by=shape+offer&show=places');fetch('/api/quickpicks/${id}/list?sort=price&qty=2')</script></body>`,
    );
    return send(res, 200, html, "text/html");
  }
  const inventory = url.pathname.match(
    /^\/api\/(?:ismds\/host|quickpicks)\/([A-Z0-9]+)\/(facets|list)$/,
  );
  if (inventory) {
    const [facets, quickpicks] =
      inventory[1] === EVENT_ID
        ? billBaileyScenario({ resaleCount: site.resaleCount })
        : loadEvent(EVENTS.elbowSoldOut).payloads;
    return sendJson(res, 200, inventory[2] === "facets" ? facets : quickpicks);
  }
  send(res, 404, "not found", "text/plain");
});

// ---------------------------------------------------------------------------------------------
// Fake Supabase PostgREST

const db = {
  eventpulse_settings: [
    {
      refresh_seconds: 1,
      sound_alerts: false,
      push_alerts: false,
      sms_alerts: false,
      whatsapp_alerts: false,
      telegram_alerts: true,
      discord_alerts: true,
      auto_rotate_proxy_on_rate_limit: false,
      maintain_sticky_mobile_ip: true,
      multilogin_endpoint: `http://127.0.0.1:${PORTS.launcher}`,
      multilogin_state_policy: "save_profile_state_on_user_action",
    },
  ],
  eventpulse_push_subscriptions: [],
  eventpulse_profiles: [profileRow(PROFILE_A, "profile-a"), profileRow(PROFILE_B, "profile-b")],
  eventpulse_targets: [
    targetRow(
      "target-a",
      PROFILE_A,
      `http://host.docker.internal:${PORTS.site}/event/${EVENT_ID}`,
      "Bill Bailey",
    ),
    targetRow(
      "target-b",
      PROFILE_B,
      `http://host.docker.internal:${PORTS.site}/event/${QUIET_ID}`,
      "Quiet Show",
    ),
  ],
  eventpulse_alerts: [],
};

listen(PORTS.supabase, async (req, res, url) => {
  const table = url.pathname.replace(/^\/rest\/v1\//, "");
  const rows = db[table];
  if (!rows) return sendJson(res, 404, { message: `unknown table ${table}` });
  const filters = [...url.searchParams].filter(
    ([key]) => !["select", "order", "limit"].includes(key),
  );
  const matches = (row) =>
    filters.every(([key, value]) => {
      const [op, ...rest] = value.split(".");
      const expected = rest.join(".");
      if (op === "eq") return String(row[key]) === expected;
      if (op === "neq") return String(row[key]) !== expected;
      if (op === "is") return expected === "null" ? row[key] == null : true;
      return true;
    });

  if (req.method === "GET") return sendJson(res, 200, rows.filter(matches));
  const body = JSON.parse((await readBody(req)) || "{}");
  if (req.method === "POST") {
    const row = { id: `row-${rows.length + 1}`, created_at: new Date().toISOString(), ...body };
    rows.push(row);
    return sendJson(res, 201, [row]);
  }
  if (req.method === "PATCH") {
    for (const row of rows.filter(matches)) Object.assign(row, body);
    return send(res, 204, "", "text/plain");
  }
  sendJson(res, 405, {});
});

// ---------------------------------------------------------------------------------------------
// Fake Multilogin launcher: profile A runs on the Chromium container, profile B can be made to fail

listen(PORTS.launcher, (req, res, url) => {
  if (url.pathname === "/api/v1/profile/statuses") {
    const states = { a: { profile_id: "profile-a", status: "browser_running", port: PORTS.cdp } };
    if (!launcher.profileBFails) {
      states.b = { profile_id: "profile-b", status: "browser_running", port: PORTS.cdp };
    }
    return sendJson(res, 200, { data: { states } });
  }
  if (url.pathname.includes("/p/profile-b/start")) {
    return sendJson(res, 500, {
      status: { message: "Profile launch failed: core not responding on port 41234" },
    });
  }
  sendJson(res, 404, { status: { message: "not found" } });
});

// ---------------------------------------------------------------------------------------------
// Fake Telegram Bot API + Discord webhook

listen(PORTS.chat, async (req, res, url) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  if (url.pathname === "/discord") {
    sent.discord.push(body);
    return send(res, 204, "", "text/plain");
  }
  const method = url.pathname.split("/").pop();
  sent.telegram.push({ method, ...body });
  sendJson(res, 200, { ok: true, result: { message_id: sent.telegram.length } });
});

// ---------------------------------------------------------------------------------------------
// Run

let app;
try {
  startChrome();
  app = startApp();
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${PORTS.app}/api/eventpulse/health`)).ok,
    30_000,
  );

  // Pass 1: one resale ticket (platinum filtered out) -> one ticket alert. Profile B fails (1/3).
  await pass();
  expectNew(1, "first stock");
  const first = lastTelegram();
  const firstText = first.caption ?? first.text;
  assert.match(firstText, /Bill Bailey: Vaudevillean/);
  assert.match(firstText, /<b>Total Stock:<\/b> 1/);
  assert.match(firstText, /Resale: Arena Floor \[1\]/);
  assert.match(firstText, /Sec BL E · Row C \| £69\.26/);
  assert.match(firstText, /\+1 section filtered by preferences/);
  assert.equal(first.reply_markup.inline_keyboard[0][0].text, "Buy Tickets");
  const firstEmbed = sent.discord.at(-1).embeds[0];
  assert.equal(firstEmbed.title, "Bill Bailey: Vaudevillean");
  assert.ok(
    firstEmbed.fields.some(
      (field) => field.name === "Venue" && field.value === "M&S Bank Arena Liverpool",
    ),
  );

  // Pass 2: nothing changed -> silence. Profile B fails (2/3).
  await pass();
  expectNew(0, "unchanged stock");

  // Pass 3: profile B fails a third time -> one "checks failing" notice in the portal log only;
  // chat channels carry ticket alerts only.
  await pass();
  expectNew(0, "third failure stays off chat");
  expectLogged(/ticket checks failing[\s\S]*Quiet Show could not be checked 3 times in a row/);

  // Pass 4: profile B fixed (recovery notice); stock grows to 3 -> ticket alert.
  launcher.profileBFails = false;
  site.resaleCount = 3;
  await pass();
  expectNew(1, "stock increase");
  assert.match(lastTelegram().caption ?? lastTelegram().text, /Total Stock:<\/b> 3/);
  expectLogged(/ticket checks recovered/);
  // Discord gets a real "Buy Tickets" link button under the embed.
  const button = sent.discord.at(-1).components?.[0]?.components?.[0];
  assert.equal(button?.label, "Buy Tickets");
  assert.equal(button?.style, 5);

  // Portal: "Check & send alert" in the real dashboard UI sends the current stock as a real
  // alert (already reported, so the scheduler alone would stay silent).
  await sleep(PROFILE_INTERVAL_SECONDS * 1000 + 300);
  const portal = await openPortal();
  const sentPanel = await clickTargetButton(portal, "Bill Bailey", "Check & send alert");
  assert.match(sentPanel, /Tickets found and the alert was sent/);
  assert.match(sentPanel, /Delivered: .*telegram 1.*discord 1|Delivered: .*discord 1.*telegram 1/);
  assert.match(sentPanel, /Resale: Arena Floor \[3\]/);
  expectNew(1, "portal check & send");
  assert.match(lastTelegram().caption ?? lastTelegram().text, /Total Stock:<\/b> 3/);

  // Portal: an immediate second check through the same profile is refused (rate limit).
  const refusedPanel = await clickTargetButton(portal, "Bill Bailey", "Check now");
  assert.match(refusedPanel, /loaded a ticket page moments ago/);
  expectNew(0, "portal rate limit");
  await portal.browser.disconnect();

  // Pass 5: Ticketmaster-style 403 -> one "profile paused" notice; no stock alert.
  site.mode = "blocked";
  await pass();
  expectNew(0, "block stays off chat");
  expectLogged(/profile paused[\s\S]*identity verification \(HTTP 403\)/);

  // Pass 6+7: profile A paused (skipped), B has no stock -> silence.
  await pass();
  await pass();
  expectNew(0, "paused profile and empty event");

  const targetA = db.eventpulse_targets.find((row) => row.id === "target-a");
  assert.equal(targetA.status, "limited");
  assert.match(targetA.availability, /^3 tickets available/, "block keeps last real availability");
  const targetB = db.eventpulse_targets.find((row) => row.id === "target-b");
  assert.equal(targetB.availability, "No tickets listed");

  // Pass 8: event B is over (HTTP 410) -> one "event page removed" notice and B is paused.
  // Pass 9: B is no longer checked -> silence.
  site.quietGone = true;
  await pass();
  expectNew(0, "event removed stays off chat");
  expectLogged(/event page removed/);
  // Nothing but ticket alerts ever reached a chat channel.
  for (const message of sent.telegram) assert.match(message.caption ?? message.text, /^🎟 /);
  assert.equal(targetB.status, "paused");
  const requestsBefore = site.requests;
  await pass();
  expectNew(0, "removed event not rechecked");
  assert.equal(site.requests, requestsBefore, "paused targets are not loaded again");

  console.log("\nTelegram messages sent:");
  for (const message of sent.telegram) {
    console.log(`--- ${message.method}\n${message.caption ?? message.text}`);
  }
  console.log(
    `\nE2E PASSED: ${sent.telegram.length} Telegram / ${sent.discord.length} Discord messages for 9 passes + portal checks.`,
  );
} catch (error) {
  console.error("\nE2E FAILED:", error);
  console.error("Telegram so far:", JSON.stringify(sent.telegram, null, 2));
  process.exitCode = 1;
} finally {
  app?.kill();
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {}
  process.exit();
}

// ---------------------------------------------------------------------------------------------
// Helpers

function expectLogged(pattern) {
  assert.ok(
    db.eventpulse_alerts.some((alert) => pattern.test(alert.message)),
    `portal alert log contains ${pattern}`,
  );
}

function expectNew(count, label) {
  assert.equal(sent.telegram.length, sent.discord.length, `${label}: same alerts on both channels`);
  assert.equal(sent.telegram.length - seen, count, `${label}: expected ${count} new message(s)`);
  seen = sent.telegram.length;
}

function lastTelegram() {
  return sent.telegram.at(-1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openPortal() {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORTS.cdp}` });
  const page = await browser.newPage();
  await page.goto(`http://host.docker.internal:${PORTS.app}/`, { waitUntil: "networkidle0" });
  return { browser, page };
}

// Clicks a button on a target card in the dashboard and returns the result panel's text.
async function clickTargetButton({ page }, eventName, label) {
  const clicked = await page.evaluate(
    (eventName, label) => {
      const card = [...document.querySelectorAll("article")].find((article) =>
        article.querySelector("h3")?.textContent?.includes(eventName),
      );
      const button = [...(card?.querySelectorAll("button") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!button) return false;
      card.dataset.e2eBefore = card.textContent ?? "";
      button.click();
      return true;
    },
    eventName,
    label,
  );
  assert.ok(clicked, `button "${label}" on ${eventName}`);
  const handle = await page.waitForFunction(
    (eventName) => {
      const card = [...document.querySelectorAll("article")].find((article) =>
        article.querySelector("h3")?.textContent?.includes(eventName),
      );
      const busy = [...(card?.querySelectorAll("button") ?? [])].some(
        (button) => button.textContent?.trim() === "Checking…",
      );
      const panel = card?.querySelector("div.rounded-md.border");
      return !busy && panel && card.textContent !== card.dataset.e2eBefore
        ? panel.textContent
        : null;
    },
    { timeout: 60_000, polling: 250 },
    eventName,
  );
  return await handle.jsonValue();
}

async function pass() {
  await sleep(PROFILE_INTERVAL_SECONDS * 1000 + 300);
  const response = await fetch(`http://127.0.0.1:${PORTS.app}/api/eventpulse/monitor-run`, {
    method: "POST",
    headers: { "x-eventpulse-cron-secret": "e2e-secret" },
  });
  const result = await response.json();
  console.log("pass", JSON.stringify(result));
  assert.equal(response.status, 200);
}

function startChrome() {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {}
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER,
      "-p",
      `${PORTS.cdp}:9222`,
      "--add-host",
      "host.docker.internal:host-gateway",
      CHROME_IMAGE,
    ],
    { stdio: "inherit" },
  );
}

function startApp() {
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORTS.app),
      // Reachable from the Chromium container for the portal UI steps.
      HOST: "0.0.0.0",
      SUPABASE_URL: `http://127.0.0.1:${PORTS.supabase}`,
      SUPABASE_SERVICE_ROLE_KEY: "e2e",
      EVENTPULSE_CRON_SECRET: "e2e-secret",
      EVENTPULSE_PUBLIC_URL: "https://dashboard.example.test",
      EVENTPULSE_SCHEDULER_ENABLED: "false",
      MULTILOGIN_API_TOKEN: "e2e-token",
      MULTILOGIN_LAUNCHER_ENDPOINT: `http://127.0.0.1:${PORTS.launcher}`,
      MULTILOGIN_CDP_HOST: "127.0.0.1",
      MULTILOGIN_PROXY_CREDENTIALS: JSON.stringify({
        "profile-a": { username: "u", password: "p" },
        "profile-b": { username: "u", password: "p" },
      }),
      MULTILOGIN_SCRAPER_PROXIES: "[]",
      EVENTPULSE_PROFILE_MIN_INTERVAL_SECONDS: String(PROFILE_INTERVAL_SECONDS),
      TELEGRAM_BOT_TOKEN: "e2e",
      TELEGRAM_CHAT_IDS: "424242",
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${PORTS.chat}`,
      DISCORD_WEBHOOK_URLS: `http://127.0.0.1:${PORTS.chat}/discord`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return child;
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("Timed out waiting for the app to start.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function profileRow(name, id) {
  return {
    profile_name: name,
    region: "London",
    cookies_status: "Unknown",
    session_status: "Unknown",
    fingerprint_health: "Unknown",
    multilogin_profile_id: id,
    multilogin_folder_id: "folder-1",
    sticky_ip_label: "Sticky",
    last_session_saved_at: null,
  };
}

function targetRow(id, profile, url, event) {
  return {
    id,
    platform: "Ticketmaster UK/WW",
    event_name: event,
    venue: "",
    target_url: url,
    status: "monitoring",
    availability: "No inventory detected",
    refresh_seconds: 1,
    profile_name: profile,
    proxy_label: "",
    section_filters: [],
    min_tickets: 1,
    max_price: null,
    normal_tickets_only: true,
    even_ticket_quantities_only: false,
    monitor_starts_at: null,
    monitor_ends_at: null,
    deep_link: "",
    last_checked_at: null,
    last_response_ms: null,
    last_status_code: null,
    last_error: null,
    last_available_at: null,
  };
}

function listen(port, handler) {
  createServer((req, res) => {
    Promise.resolve(handler(req, res, new URL(req.url, `http://127.0.0.1:${port}`))).catch(
      (error) => {
        console.error(error);
        sendJson(res, 500, { message: String(error) });
      },
    );
  }).listen(port, "0.0.0.0");
}

function send(res, status, body, type) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), "application/json");
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}
