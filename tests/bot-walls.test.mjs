import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { detectBotWall, interpretTicketPage } from "../src/lib/eventpulse/ticket-snapshot.ts";
import { EVENTS, loadEvent } from "./fixtures.mjs";

// Real Imperva/Incapsula interstitial served by tickets.royalalberthall.com on 2026-11-17 with
// HTTP 200 (client IP and incident ids redacted).
const IMPERVA = readFileSync(
  new URL("./fixtures/botwalls/imperva-royal-albert-hall.html", import.meta.url),
  "utf8",
);

const TARGET = {
  url: "https://tickets.royalalberthall.com/syos2/performance/102693",
  event: "Royal Albert Hall test",
  venue: "Royal Albert Hall",
  filters: {
    sectionFilters: [],
    minTickets: 1,
    maxPrice: null,
    normalTicketsOnly: true,
    evenTicketQuantitiesOnly: false,
  },
};
const META = { responseMs: 100, usesRotatingProxy: false };

test("bot walls: Imperva page answering HTTP 200 is a blocked check, not a ticket page", () => {
  assert.equal(detectBotWall(IMPERVA), "Imperva");
  const result = interpretTicketPage(
    TARGET,
    { html: IMPERVA, statusCode: 200, responseOk: true, inventoryPayloads: [] },
    META,
  );
  assert.equal(result.kind, "blocked");
  assert.equal(result.status, "limited");
  assert.equal(result.availability, "");
  assert.match(result.error, /Bot protection page from the ticket site \(Imperva\)/);
});

test("bot walls: other vendors' challenge pages", () => {
  assert.equal(
    detectBotWall("<html><head><title>Just a moment...</title></head><body></body></html>"),
    "Cloudflare",
  );
  assert.equal(
    detectBotWall(
      "<html><head><title>Access Denied</title></head><body>Reference #18.1 https://errors.edgesuite.net/18.1</body></html>",
    ),
    "Akamai",
  );
  assert.equal(
    detectBotWall(
      '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe></body></html>',
    ),
    "DataDome",
  );
  assert.equal(
    detectBotWall('<html><body><div id="px-captcha"></div></body></html>'),
    "PerimeterX",
  );
});

test("bot walls: real Ticketmaster event pages are not walls", () => {
  for (const event of Object.values(EVENTS)) {
    assert.equal(detectBotWall(loadEvent(event).html), null, event.file);
  }
  // A normal page that only loads Cloudflare's bot-management script.
  assert.equal(
    detectBotWall(
      '<html><head><title>Tickets</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head></html>',
    ),
    null,
  );
});
