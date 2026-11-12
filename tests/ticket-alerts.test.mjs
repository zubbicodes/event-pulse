import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTicketAlert,
  decodePlaceSection,
  findNewStock,
  isInventoryResponseUrl,
  parseEventDetails,
  parseInventoryPayloads,
  stockSnapshot,
} from "../src/lib/eventpulse/ticket-inventory.ts";
import { interpretTicketPage } from "../src/lib/eventpulse/ticket-snapshot.ts";
import { EVENTS, billBaileyScenario, loadEvent } from "./fixtures.mjs";

const FILTERS = {
  sectionFilters: [],
  minTickets: 1,
  maxPrice: null,
  normalTicketsOnly: true,
  evenTicketQuantitiesOnly: false,
};
const META = { responseMs: 900, usesRotatingProxy: false };

function urlFor(event) {
  return `https://www.ticketmaster.co.uk/event/${event.id}`;
}

function check(event, { filters = FILTERS, payloads, statusCode = 200, html } = {}) {
  const loaded = loadEvent(event);
  return interpretTicketPage(
    { url: urlFor(event), event: "", venue: "", filters },
    {
      html: html ?? loaded.html,
      statusCode,
      responseOk: statusCode >= 200 && statusCode < 400,
      inventoryPayloads: payloads ?? loaded.payloads,
    },
    META,
  );
}

test("real Ticketmaster inventory URLs are recognised", () => {
  assert.ok(
    isInventoryResponseUrl(
      "https://services.ticketmaster.co.uk/api/ismds/host/37006374A07F3DED/facets?q=available&by=shape",
    ),
  );
  assert.ok(
    isInventoryResponseUrl(
      "https://www.ticketmaster.co.uk/api/quickpicks/37006374A07F3DED/list?sort=price&qty=2",
    ),
  );
  assert.ok(!isInventoryResponseUrl("https://www.ticketmaster.co.uk/api/deliveryoptions/3E00"));
});

test("section names decode from facet places", () => {
  assert.equal(decodePlaceSection("IJGCAMJWHJDUOORUGA[2[A,Q],3A]"), "BL 16");
  assert.equal(decodePlaceSection("GEYDGOSNHI3A"), "103");
  assert.equal(decodePlaceSection("not-base32!"), null);
});

test("event details come from the page's JSON-LD and the URL", () => {
  const event = parseEventDetails(loadEvent(EVENTS.theScript).html, urlFor(EVENTS.theScript), {
    name: "fallback",
    venue: "",
  });
  assert.equal(event.name, "The Script");
  assert.equal(event.eventId, EVENTS.theScript.id);
  assert.equal(event.venue, "Utilita Arena Sheffield");
  assert.equal(event.date, "Sat 14 Nov 2026, 18:00");
  assert.equal(event.location, "Sheffield, UK");
});

test("real facets + quickpicks become areas with counts, sections and prices", () => {
  const listings = parseInventoryPayloads(loadEvent(EVENTS.theScript).payloads);
  const total = listings.reduce((sum, listing) => sum + listing.quantity, 0);
  assert.equal(total, 1088);
  const resaleSecondTier = listings.find(
    (listing) => listing.inventoryType === "resale" && listing.name === "SECOND TIER",
  );
  assert.equal(resaleSecondTier.quantity, 10);
  assert.equal(resaleSecondTier.price, 106.2);
  assert.ok(resaleSecondTier.sections.includes("217"));
  assert.deepEqual(resaleSecondTier.examples[0], {
    section: "217",
    row: "Q",
    seats: 2,
    price: 106.2,
    currency: "GBP",
  });
  // Standing picks use the placeholder section "T1CKET"; it must not show as a section.
  const standing = listings.find(
    (listing) => listing.inventoryType === "resale" && listing.name === "FLOOR STANDING",
  );
  assert.equal(standing.examples[0].section, null);
});

test("sold-out event: empty facets mean no stock, not unknown", () => {
  const result = check(EVENTS.elbowSoldOut);
  assert.equal(result.kind, "ok");
  assert.equal(result.status, "monitoring");
  assert.equal(result.availability, "No tickets listed");
  assert.equal(result.report.event.name, "elbow - Asleep in the Back");
});

test("no inventory captured on a Ticketmaster page is never reported as on sale", () => {
  const result = check(EVENTS.billBailey, { payloads: [] });
  assert.equal(result.status, "monitoring");
  assert.equal(result.availability, "Page loaded; no ticket inventory published");
});

test("filters: premium, section, price and quantity", () => {
  const platinum = check(EVENTS.billBailey, { payloads: billBaileyScenario() });
  assert.deepEqual(
    platinum.report.matched.map((listing) => listing.name),
    ["Arena Floor"],
  );
  assert.equal(platinum.report.filteredOutSections, 1);

  const sections = check(EVENTS.theScript, { filters: { ...FILTERS, sectionFilters: ["217"] } });
  assert.ok(sections.report.matched.every((listing) => listing.sections.includes("217")));
  assert.ok(sections.report.matched.length > 0);

  const cheap = check(EVENTS.theScript, { filters: { ...FILTERS, maxPrice: 100 } });
  assert.deepEqual(
    cheap.report.matched.map((listing) => `${listing.inventoryType} ${listing.name}`),
    ["resale FLOOR STANDING"],
  );

  const pairs = check(EVENTS.billBailey, {
    payloads: billBaileyScenario({ resaleCount: 1, platinum: false }),
    filters: { ...FILTERS, minTickets: 2 },
  });
  assert.equal(pairs.report.totalStock, 0);
});

test("alert matches the client's layout and stays within channel limits", () => {
  const result = check(EVENTS.billBailey, { payloads: billBaileyScenario({ resaleCount: 2 }) });
  const alert = buildTicketAlert({
    report: result.report,
    url: `${urlFor(EVENTS.billBailey)}?qty=1`,
    checkedAt: new Date("2026-11-12T13:42:14Z"),
  });
  assert.equal(
    alert.text,
    [
      "🎟 Bill Bailey: Vaudevillean",
      `Event ID: ${EVENTS.billBailey.id}`,
      "Venue: M&S Bank Arena Liverpool",
      "Date: Sat 14 Nov 2026, 20:00",
      "Location: Liverpool, UK",
      "Total Stock: 2",
      "⚠️ +1 section filtered by preferences",
      "",
      "Resale: Arena Floor [2]",
      "Sec BL B | from £69.26 [2]",
      "↳ Sec BL E · Row C | £69.26 [2]",
      "",
      `Buy Tickets: ${urlFor(EVENTS.billBailey)}?qty=1`,
      "HD-1 · 2026-11-12 13:42:14 UTC",
    ].join("\n"),
  );
  assert.doesNotMatch(alert.telegramHtml, /<(?!\/?(b|i|a|code)\b)/);

  const big = check(EVENTS.theScript);
  const bigAlert = buildTicketAlert({
    report: big.report,
    url: urlFor(EVENTS.theScript),
    checkedAt: new Date(),
  });
  assert.ok(bigAlert.telegramHtml.length < 4096);
  assert.ok(JSON.stringify(bigAlert.discordEmbed).length < 6000);
  assert.ok(bigAlert.discordEmbed.fields.length <= 25);
  // Resale areas (drops) are listed first.
  assert.match(bigAlert.text.split("\n\n")[1], /^Resale: /);
});

test("alerts fire for new areas and real drops, not small swings", () => {
  const first = check(EVENTS.theScript).report;
  assert.equal(findNewStock(null, first.matched).length, first.matched.length);
  const seen = stockSnapshot(first.matched);

  assert.equal(findNewStock(seen, check(EVENTS.theScript).report.matched).length, 0);

  // Primary standing 1007 -> 1012 is basket churn, not a drop.
  const [facets, picks] = loadEvent(EVENTS.theScript).payloads;
  const churn = structuredClone(facets);
  churn.facets.find(
    (facet) => facet.description === "IE5DCLBSGAWDCMQ" && facet.inventoryTypes[0] === "primary",
  ).count += 5;
  assert.equal(
    findNewStock(seen, check(EVENTS.theScript, { payloads: [churn, picks] }).report.matched).length,
    0,
  );

  // Resale first tier 6 -> 9 is a drop.
  const drop = structuredClone(facets);
  drop.facets.find(
    (facet) => facet.description === "IE5DELBSGEWDCMQ" && facet.inventoryTypes[0] === "resale",
  ).count += 3;
  const dropped = findNewStock(
    seen,
    check(EVENTS.theScript, { payloads: [drop, picks] }).report.matched,
  );
  assert.deepEqual(
    dropped.map((listing) => `${listing.inventoryType} ${listing.name}`),
    ["resale FIRST TIER"],
  );

  // Losing the cheapest-seat price between checks must not look like new stock.
  const noPicks = { ...picks, picks: [] };
  assert.equal(
    findNewStock(seen, check(EVENTS.theScript, { payloads: [facets, noPicks] }).report.matched)
      .length,
    0,
  );
});

test("blocks, removed events, captchas and errors never look like stock", () => {
  assert.equal(check(EVENTS.billBailey, { statusCode: 403 }).kind, "blocked");
  const gone = check(EVENTS.billBailey, { statusCode: 410 });
  assert.equal(gone.kind, "gone");
  assert.equal(gone.status, "paused");
  assert.equal(check(EVENTS.billBailey, { statusCode: 500 }).kind, "failed");
  assert.equal(
    check(EVENTS.billBailey, {
      html: "<html><body><h1>Please verify you are human</h1></body></html>",
      payloads: [],
    }).kind,
    "captcha",
  );
});

test("reCAPTCHA scripts on a normal page are not a captcha challenge", () => {
  const html = loadEvent(EVENTS.billBailey).html.replace(
    "</head>",
    '<script src="https://www.google.com/recaptcha/enterprise.js"></script><script>grecaptcha.ready(()=>{})</script></head>',
  );
  assert.equal(check(EVENTS.billBailey, { html }).kind, "ok");
});
