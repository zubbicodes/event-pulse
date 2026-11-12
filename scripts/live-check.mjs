// Live check of real ticket pages from this computer, with the monitor's own parsing and alert
// rendering. Opens each URL once in a local Chrome window (your normal browser and network),
// prints what was found, and optionally posts the alert to the Discord webhook(s) in .env.
// It does not touch Supabase, Multilogin profiles or Telegram.
//
//   node --env-file=.env scripts/live-check.mjs <url> [<url> ...] [options]
//
//   --send          post to Discord when matching stock is found
//   --send-anyway   post to Discord even with no matching stock (to see the layout)
//   --min=<n>       minimum tickets (default 1)
//   --max-price=<n> maximum price per ticket
//   --sections=A,B  section filters
//   --even          even quantities only
//   --all-types     include platinum/VIP/hospitality (default: normal tickets only)
//   --debug         list every JSON response the page loaded
//   --dump=<dir>    write the page HTML and captured inventory JSON to <dir>

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { captureTicketPage } from "../src/lib/eventpulse/page-capture.server.ts";
import { interpretTicketPage } from "../src/lib/eventpulse/ticket-snapshot.ts";
import { buildTicketAlert } from "../src/lib/eventpulse/ticket-inventory.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const urls = args.filter((arg) => /^https?:\/\//i.test(arg));
if (urls.length === 0) {
  console.error("Usage: node --env-file=.env scripts/live-check.mjs <ticket url> [--send]");
  process.exit(1);
}

const filters = {
  sectionFilters: (option("sections") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  minTickets: Number(option("min") ?? 1),
  maxPrice: option("max-price") ? Number(option("max-price")) : null,
  normalTicketsOnly: !flag("all-types"),
  evenTicketQuantitiesOnly: flag("even"),
};
const webhooks = (process.env.DISCORD_WEBHOOK_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const wantsSend = flag("send") || flag("send-anyway");
if (wantsSend && webhooks.length === 0) {
  console.error("DISCORD_WEBHOOK_URLS is empty in .env.");
  process.exit(1);
}

const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((path) => path && existsSync(path));
if (!executablePath) {
  console.error("No Chrome found. Set CHROME_PATH to your Chrome executable.");
  process.exit(1);
}

const userDataDir = mkdtempSync(join(tmpdir(), "hd1-live-check-"));
const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  userDataDir,
  defaultViewport: null,
  args: ["--no-first-run", "--no-default-browser-check"],
});

let exitCode = 0;
try {
  for (const url of urls) {
    console.log(`\n=== ${url}`);
    const page = await browser.newPage();
    const started = Date.now();
    try {
      const captured = await captureTicketPage(page, url);
      const check = interpretTicketPage({ url, event: "", venue: "", filters }, captured, {
        responseMs: Date.now() - started,
        usesRotatingProxy: false,
      });

      console.log(`HTTP ${captured.statusCode} in ${Date.now() - started}ms`);
      console.log(`Inventory responses captured: ${captured.inventoryPayloads.length}`);
      if (flag("debug")) {
        console.log("JSON responses:");
        for (const jsonUrl of captured.jsonResponseUrls) console.log(`  ${jsonUrl}`);
      }
      const dumpDir = option("dump");
      if (dumpDir) {
        mkdirSync(dumpDir, { recursive: true });
        const id = check.report?.event.eventId ?? `page-${Date.now()}`;
        writeFileSync(join(dumpDir, `${id}.html`), captured.html);
        writeFileSync(
          join(dumpDir, `${id}.inventory.json`),
          JSON.stringify(captured.inventoryPayloads, null, 2),
        );
        console.log(`Dumped page and inventory to ${dumpDir}`);
      }
      console.log(`Result: ${check.kind} / ${check.status}`);
      console.log(`Summary: ${check.availability || check.error}`);
      if (!check.report) continue;

      const { event, listings, matched } = check.report;
      console.log(
        `Event: ${event.name} | ${event.venue ?? "?"} | ${event.date ?? "?"} | ${event.location ?? "?"} | ID ${event.eventId ?? "?"}`,
      );
      console.log(`Listings found: ${listings.length}, matching filters: ${matched.length}`);

      const alert = buildTicketAlert({ report: check.report, url, checkedAt: new Date() });
      console.log(`\n${alert.text}`);

      const hasStock = check.report.totalStock > 0;
      if (flag("send-anyway") || (flag("send") && hasStock)) {
        for (const [index, webhook] of webhooks.entries()) {
          // Same payload as the monitor: embed plus a "Buy Tickets" link button.
          const withButton = new URL(webhook);
          withButton.searchParams.set("with_components", "true");
          const response = await fetch(withButton, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              embeds: [alert.discordEmbed],
              components: [
                {
                  type: 1,
                  components: [{ type: 2, style: 5, label: "Buy Tickets", url }],
                },
              ],
              allowed_mentions: { parse: [] },
            }),
          });
          console.log(`Discord webhook #${index + 1}: HTTP ${response.status}`);
          if (!response.ok) {
            exitCode = 1;
            console.log((await response.text()).slice(0, 300));
          }
        }
      } else if (flag("send")) {
        console.log("No matching stock: nothing sent (use --send-anyway to post the layout).");
      }
    } catch (error) {
      exitCode = 1;
      console.error(`Check failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
} finally {
  await browser.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
