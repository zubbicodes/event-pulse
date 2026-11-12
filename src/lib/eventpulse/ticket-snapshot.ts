import {
  buildInventoryReport,
  parseEventDetails,
  parseInventoryPayloads,
  summarizeReport,
  type InventoryReport,
  type TargetFilters,
} from "./ticket-inventory.ts";

export type TicketPageSnapshot = {
  status: "available" | "monitoring" | "captcha" | "limited";
  // Short state, e.g. "Tickets available", "Sold out or unavailable".
  state: string;
  summary: string;
};

export type MonitorCheckResult = {
  // ok: page read; blocked: 403/429 from the site; captcha; gone: the event page was removed
  // (404/410, e.g. the event is over); failed: anything else went wrong.
  kind: "ok" | "blocked" | "captcha" | "gone" | "failed";
  status: "available" | "monitoring" | "captcha" | "limited" | "paused";
  // Dashboard text; only written for "ok" checks so failures never overwrite real stock data.
  availability: string;
  responseMs: number;
  statusCode: number | null;
  error: string | null;
  usesRotatingProxy: boolean;
  report: InventoryReport | null;
};

export type RenderedTicketPage = {
  html: string;
  statusCode: number;
  responseOk: boolean;
  inventoryPayloads: unknown[];
};

// Turns one rendered page (HTML + captured inventory JSON) into a check result.
export function interpretTicketPage(
  target: { url: string; event: string; venue: string; filters: TargetFilters },
  page: RenderedTicketPage,
  meta: { responseMs: number; usesRotatingProxy: boolean },
): MonitorCheckResult {
  const base = { ...meta, statusCode: page.statusCode };
  if (page.statusCode === 403 || page.statusCode === 429) {
    return {
      ...base,
      kind: "blocked",
      status: "limited",
      availability: "",
      error:
        page.statusCode === 429
          ? "Rate limited by the ticket site (HTTP 429)."
          : "Identity check from the ticket site (HTTP 403).",
      report: null,
    };
  }

  if (page.statusCode === 404 || page.statusCode === 410) {
    return {
      ...base,
      kind: "gone",
      status: "paused",
      availability: `Event page removed by the site (HTTP ${page.statusCode}); monitoring stopped`,
      error: `Event page no longer exists (HTTP ${page.statusCode}).`,
      report: null,
    };
  }

  const snapshot = extractTicketPageSnapshot({
    html: page.html,
    statusCode: page.statusCode,
    responseOk: page.responseOk,
    sectionFilters: target.filters.sectionFilters,
    maxPrice: target.filters.maxPrice,
    normalTicketsOnly: target.filters.normalTicketsOnly,
  });
  if (snapshot.status === "captcha") {
    return {
      ...base,
      kind: "captcha",
      status: "captcha",
      availability: "",
      error: "Captcha challenge.",
      report: null,
    };
  }
  if (!page.responseOk) {
    return {
      ...base,
      kind: "failed",
      status: "limited",
      availability: "",
      error: `Ticket page answered HTTP ${page.statusCode}.`,
      report: null,
    };
  }

  const report = buildInventoryReport({
    event: parseEventDetails(page.html, target.url, { name: target.event, venue: target.venue }),
    listings: parseInventoryPayloads(page.inventoryPayloads),
    filters: target.filters,
  });
  if (report.inventoryKnown) {
    return {
      ...base,
      kind: "ok",
      status: report.totalStock > 0 ? "available" : "monitoring",
      availability: summarizeReport(report),
      error: null,
      report,
    };
  }

  // No inventory feed captured (site without one): fall back to page-text signals. Ticketmaster
  // pages always say "buy tickets", so page text never counts as stock there.
  const onSale = snapshot.status === "available" && !isTicketmasterHost(target.url);
  return {
    ...base,
    kind: "ok",
    status: onSale ? "available" : "monitoring",
    availability: onSale
      ? "Tickets appear to be on sale (page text)"
      : isTicketmasterHost(target.url)
        ? "Page loaded; no ticket inventory published"
        : snapshot.state,
    error: null,
    report,
  };
}

function isTicketmasterHost(url: string) {
  try {
    return /(^|\.)ticketmaster\.[a-z.]+$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

type SnapshotInput = {
  html: string;
  statusCode: number;
  responseOk: boolean;
  sectionFilters: string[];
  maxPrice: number | null;
  normalTicketsOnly: boolean;
};

const SIGNALS = [
  ["low availability", "low availability"],
  ["limited availability", "limited availability"],
  ["on sale", "on sale"],
  ["presale", "presale"],
  ["resale", "resale"],
  ["standard ticket", "standard"],
  ["general admission", "general admission"],
  ["official platinum", "official platinum"],
  ["hospitality", "hospitality"],
  ["standing", "standing"],
  ["seated", "seated"],
  ["restricted view", "restricted view"],
  ["face value", "face value"],
  ["fees included", "fees included"],
  ["accessible", "accessible"],
  ["vip", "VIP"],
] as const;

const POSITIVE_SIGNALS = [
  "tickets available",
  "buy tickets",
  "resale ticket",
  "select seats",
  "available now",
  "on sale",
];

const NEGATIVE_SIGNALS = [
  "sold out",
  "no tickets available",
  "currently unavailable",
  "not currently available",
  "tickets are not available",
];

export function extractTicketPageSnapshot(input: SnapshotInput): TicketPageSnapshot {
  // Visible text only: script/style bodies (e.g. Google reCAPTCHA loaders on every Ticketmaster
  // page) must not count as page wording.
  const text = decodeHtml(
    input.html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " "),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lower = text.toLowerCase();
  const pageTitle = extractPageTitle(input.html);
  const prices = extractPrices(text);
  const matchedSections = input.sectionFilters.filter((section) =>
    lower.includes(section.trim().toLowerCase()),
  );
  const sections = extractSections(lower, matchedSections);
  const signals = SIGNALS.filter(([needle]) => lower.includes(needle)).map(([, label]) => label);
  const quantities = extractQuantities(lower);
  const captcha =
    /verify (?:that )?you(?:'| a)re (?:a )?human|complete the captcha|captcha challenge|are you a robot|press (?:&|and) hold/i.test(
      lower,
    );
  const blocked = input.statusCode === 403 || input.statusCode === 429;
  const positive = POSITIVE_SIGNALS.some((needle) => lower.includes(needle));
  const negative = NEGATIVE_SIGNALS.some((needle) => lower.includes(needle));
  const sectionMatch = input.sectionFilters.length === 0 || matchedSections.length > 0;
  const priceMatch =
    input.maxPrice == null ||
    (prices.length > 0 && prices.some((price) => price.value <= input.maxPrice!));
  const normalTicketMatch =
    !input.normalTicketsOnly || !signals.includes("resale") || signals.includes("standard");
  const filterMatch = sectionMatch && priceMatch && normalTicketMatch;

  let status: TicketPageSnapshot["status"] = "monitoring";
  let state = "No matching inventory";
  if (blocked) {
    status = "limited";
    state = input.statusCode === 429 ? "Rate limited" : "Access blocked";
  } else if (captcha) {
    status = "captcha";
    state = "Captcha challenge";
  } else if (input.responseOk && positive && !negative && filterMatch) {
    status = "available";
    state = "Tickets available";
  } else if (negative) {
    state = "Sold out or unavailable";
  } else if (positive && !filterMatch) {
    state = "Inventory found outside filters";
  }

  const facts = [
    state,
    `prices: ${prices.length ? prices.map(formatPrice).join(", ") : "not exposed"}`,
    `sections: ${sections.length ? sections.join(", ") : "not exposed"}`,
    `ticket types: ${signals.length ? signals.join(", ") : "not exposed"}`,
    `quantities: ${quantities.length ? quantities.join(", ") : "not exposed"}`,
    `filter: ${filterMatch ? "matched" : "not matched"}`,
    `HTTP ${input.statusCode}`,
  ];
  if (pageTitle) facts.push(`page: ${pageTitle}`);

  return { status, state, summary: facts.join("; ").slice(0, 1200) };
}

function extractPageTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtml(match[1]).replace(/\s+/g, " ").trim().slice(0, 140) : "";
}

function extractPrices(text: string) {
  const prices = new Map<string, { currency: string; value: number }>();
  const prefix = /(?:^|\s)(£|€|\$)\s*([0-9]{1,5}(?:[.,][0-9]{2})?)(?=\s|<|$)/g;
  const suffix = /(?:^|\s)([0-9]{1,5}(?:[.,][0-9]{2})?)\s*(GBP|EUR|USD)(?=\s|<|$)/gi;

  for (const match of text.matchAll(prefix)) {
    addPrice(prices, symbolCurrency(match[1]!), match[2]!);
  }
  for (const match of text.matchAll(suffix)) {
    addPrice(prices, match[2]!.toUpperCase(), match[1]!);
  }

  return [...prices.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency) || left.value - right.value)
    .slice(0, 12);
}

function addPrice(
  prices: Map<string, { currency: string; value: number }>,
  currency: string,
  rawValue: string,
) {
  const value = Number(rawValue.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) return;
  prices.set(`${currency}:${value.toFixed(2)}`, { currency, value });
}

function symbolCurrency(symbol: string) {
  if (symbol === "£") return "GBP";
  if (symbol === "€") return "EUR";
  return "USD";
}

function formatPrice(price: { currency: string; value: number }) {
  return `${price.currency} ${price.value.toFixed(2)}`;
}

function extractQuantities(lower: string) {
  const quantities = new Set<string>();
  const pattern = /\b([1-9][0-9]?)\s+tickets?\s+(?:available|remaining)\b/g;
  for (const match of lower.matchAll(pattern)) quantities.add(`${match[1]} tickets`);
  return [...quantities].slice(0, 8);
}

function extractSections(lower: string, configuredMatches: string[]) {
  const sections = new Set(configuredMatches);
  const pattern = /\b(section|block|tier|area)\s+([a-z0-9][a-z0-9-]{0,11})\b/g;
  for (const match of lower.matchAll(pattern)) {
    sections.add(`${titleCase(match[1]!)} ${match[2]!.toUpperCase()}`);
  }
  return [...sections].slice(0, 12);
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function decodeHtml(value: string) {
  return value
    .replace(/&pound;/gi, "£")
    .replace(/&euro;/gi, "€")
    .replace(/&dollar;/gi, "$")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
