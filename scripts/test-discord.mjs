// Sends sample HD-1 alerts to the Discord webhook(s) in .env, using the same rendering code and
// payload shape as the monitor. Touches nothing else: no Supabase, no Multilogin, no Telegram.
//
//   node --env-file=.env scripts/test-discord.mjs            send a ticket alert + an ops notice
//   node --env-file=.env scripts/test-discord.mjs --dry-run  print the payloads only

import { buildSampleTicketAlert } from "../src/lib/eventpulse/sample-alert.ts";

const dryRun = process.argv.includes("--dry-run");
const webhooks = (process.env.DISCORD_WEBHOOK_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

if (!dryRun && webhooks.length === 0) {
  console.error("DISCORD_WEBHOOK_URLS is empty in .env.");
  process.exit(1);
}

const ticket = buildSampleTicketAlert(new Date());
const dashboardUrl = process.env.EVENTPULSE_PUBLIC_URL ?? "";
const payloads = [
  // Ticket alert: what supabase.server.ts sends for new stock.
  {
    label: "ticket alert",
    body: { embeds: [ticket.discordEmbed], allowed_mentions: { parse: [] } },
  },
  // Operational notice: what a profile block sends (once per block episode).
  {
    label: "ops notice",
    body: {
      content: [
        "⏸ HD-1: profile paused",
        'TEST: Ticketmaster asked profile "Sample profile" for identity verification (HTTP 403).',
        "Its checks are paused and retried automatically. You will get one message when checks resume.",
        dashboardUrl,
      ]
        .filter(Boolean)
        .join("\n"),
      allowed_mentions: { parse: [] },
    },
  },
];

if (dryRun) {
  for (const payload of payloads) {
    console.log(`--- ${payload.label}\n${JSON.stringify(payload.body, null, 2)}`);
  }
  process.exit(0);
}

let failed = false;
for (const [index, webhook] of webhooks.entries()) {
  for (const payload of payloads) {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload.body),
    });
    const ok = response.ok;
    failed ||= !ok;
    const detail = ok ? "" : ` ${(await response.text()).slice(0, 300)}`;
    console.log(`Webhook #${index + 1} ${payload.label}: HTTP ${response.status}${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
process.exit(failed ? 1 : 0);
