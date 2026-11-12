// Structured ticket inventory for HD-1 alerts.
//
// Ticket pages fetch their live inventory as JSON (Ticketmaster: the ISMDS "facets" and
// "quickpicks" endpoints) and describe the event with schema.org JSON-LD. The monitoring browser
// records those responses while the page loads; this module turns them into listings, applies the
// target's filters and builds the alert text for every channel.
//
// This file has no runtime imports so it can be tested directly with `node --test`.

export type InventoryType = "primary" | "resale" | "unknown";

export interface SeatExample {
  section: string | null;
  row: string | null;
  seats: number;
  price: number | null;
  currency: string;
}

export interface TicketListing {
  // Area or offer name as the site shows it, e.g. "FLOOR STANDING", "Arena Floor".
  name: string;
  // Site offer type, e.g. "standard", "platinum"; null when not exposed.
  offerType: string | null;
  inventoryType: InventoryType;
  // Sections with stock in this listing, e.g. ["101", "102"] or ["BL 16"].
  sections: string[];
  // Lowest known price per ticket; null when the site does not expose it for this area.
  price: number | null;
  currency: string;
  quantity: number;
  // Purchasable lot sizes when the site exposes them (resale listings are often fixed lots).
  sellableQuantities: number[];
  // Cheapest individual seats the site showed for this listing.
  examples: SeatExample[];
}

export interface EventDetails {
  name: string;
  eventId: string | null;
  venue: string | null;
  // Display text, e.g. "Sat 21 Nov 2026, 19:00".
  date: string | null;
  location: string | null;
  imageUrl: string | null;
}

export interface TargetFilters {
  sectionFilters: string[];
  minTickets: number;
  maxPrice: number | null;
  normalTicketsOnly: boolean;
  evenTicketQuantitiesOnly: boolean;
}

export interface InventoryReport {
  event: EventDetails;
  // True when live inventory data was read (as opposed to nothing captured from the page).
  inventoryKnown: boolean;
  listings: TicketListing[];
  matched: TicketListing[];
  totalStock: number;
  filteredOutListings: number;
  filteredOutSections: number;
}

const PREMIUM_PATTERN =
  /\b(platinum|vip|hospitality|package|premium|experience|meet\s*(?:&|and)\s*greet|upgrade|parking|merch)/i;

// ---------------------------------------------------------------------------------------------
// Event details

export function parseEventDetails(
  html: string,
  url: string,
  fallback: { name: string; venue: string },
): EventDetails {
  const ld = findJsonLdEvent(html);
  const ogTitle = readMeta(html, "og:title");
  const ogImage = readMeta(html, "og:image");

  const location = ld ? readLdLocation(ld) : null;
  const name =
    cleanText(asString(ld?.["name"])) || fallback.name || cleanTitle(ogTitle) || "Ticket event";

  return {
    name,
    eventId: extractEventId(url),
    venue: location?.venue || fallback.venue || null,
    date: formatEventDate(asString(ld?.["startDate"])),
    location: location?.place || null,
    imageUrl: absoluteUrl(readLdImage(ld) || ogImage, url),
  };
}

export function extractEventId(url: string) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/event\/([A-Za-z0-9]{8,})/);
    if (match?.[1]) return match[1];
    return parsed.searchParams.get("eventId") ?? parsed.searchParams.get("event_id");
  } catch {
    return null;
  }
}

function findJsonLdEvent(html: string): Record<string, unknown> | null {
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeEntities(match[1] ?? "").trim());
    } catch {
      continue;
    }
    const event = findEventNode(parsed, 0);
    if (event) return event;
  }
  return null;
}

function findEventNode(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEventNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
  if (types.some((item) => /Event$/i.test(item)) && record["name"]) return record;
  return findEventNode(record["@graph"], depth + 1);
}

function readLdLocation(ld: Record<string, unknown>) {
  const raw = Array.isArray(ld["location"]) ? ld["location"][0] : ld["location"];
  if (!raw || typeof raw !== "object") return null;
  const location = raw as Record<string, unknown>;
  const address = location["address"];
  let place: string | null = null;
  if (address && typeof address === "object") {
    const record = address as Record<string, unknown>;
    const country = readCountry(record["addressCountry"]);
    place =
      [cleanText(asString(record["addressLocality"])), country].filter(Boolean).join(", ") || null;
  } else if (typeof address === "string") {
    place = cleanText(address) || null;
  }
  return { venue: cleanText(asString(location["name"])) || null, place };
}

function readCountry(value: unknown) {
  const raw =
    value && typeof value === "object"
      ? asString((value as Record<string, unknown>)["name"])
      : asString(value);
  const text = cleanText(raw);
  if (/^(GB|GBR|United Kingdom|Great Britain)$/i.test(text)) return "UK";
  return text;
}

function readLdImage(ld: Record<string, unknown> | null) {
  if (!ld) return "";
  const image = ld["image"];
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    const first = image[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return asString((first as { url?: unknown }).url);
  }
  if (image && typeof image === "object") return asString((image as { url?: unknown }).url);
  return "";
}

function readMeta(html: string, property: string) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const reverse = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
    "i",
  );
  return decodeEntities(html.match(forward)?.[1] ?? html.match(reverse)?.[1] ?? "").trim();
}

function cleanTitle(title: string) {
  return title.replace(/\s*(?:tickets?\s*)?\|.*$/i, "").trim();
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Event start times are venue-local; format the written digits instead of converting time zones.
export function formatEventDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return cleanText(value) || null;
  const [, year, month, day, hour, minute] = match;
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
  const date = `${WEEKDAYS[weekday]} ${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  return hour && minute && `${hour}:${minute}` !== "00:00" ? `${date}, ${hour}:${minute}` : date;
}

// ---------------------------------------------------------------------------------------------
// Inventory payloads

export function isInventoryResponseUrl(url: string) {
  // Ticketmaster UK serves facets from services.ticketmaster.co.uk/api/ismds/host/{id}/facets
  // (event/ on other markets) and quickpicks from www.ticketmaster.co.uk/api/quickpicks/{id}/list.
  return /\/api\/ismds\/(?:event|host)\/[^/]+\/(?:facets|quickpicks)|\/api\/quickpicks\/[^/]+(?:\/list)?(?:[?#]|$)|\/api\/search\/events\/[^/]+\/quickpicks|\/offeradapter\//i.test(
    url,
  );
}

type OfferRecord = {
  name: string;
  inventoryType: InventoryType;
  price: number | null;
  currency: string;
  sellableQuantities: number[];
};

type PickRecord = {
  descriptionId: string;
  resale: boolean;
  example: SeatExample;
};

// Reads every captured inventory payload.
//
// Real Ticketmaster UK pages (checked against live events) load:
//  - ISMDS facets: one entry per area x inventory type with an exact `count`, a coded area id
//    (`description`), `inventoryTypes`, `offerTypes` and base32 `places` that decode to section
//    names. No prices and no readable area names.
//  - quickpicks: the cheapest few seats (section, row, seats, price, resale listing id) plus the
//    readable names of their areas (`descriptions`).
// Facets give the counts; quickpicks give names, prices and example seats. An empty facet list
// means sold out. Without facets, quickpicks alone are used.
export function parseInventoryPayloads(payloads: unknown[]): TicketListing[] | null {
  const offers = new Map<string, OfferRecord>();
  const areaNames = new Map<string, string>();
  const picks: PickRecord[] = [];
  const facets: Record<string, unknown>[] = [];
  let sawFacets = false;
  let sawPicks = false;

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    collectOffers(record, offers);
    collectAreaNames(record, areaNames);
    if (Array.isArray(record["facets"])) {
      sawFacets = true;
      for (const facet of record["facets"]) {
        if (facet && typeof facet === "object") facets.push(facet as Record<string, unknown>);
      }
    }
    if (Array.isArray(record["picks"])) {
      sawPicks = true;
      for (const pick of record["picks"]) {
        const parsed = parsePick(pick);
        if (parsed) picks.push(parsed);
      }
    }
  }

  if (sawFacets) {
    const listings = facets
      .map((facet) => facetToListing(facet, offers, areaNames, picks))
      .filter((listing): listing is TicketListing => listing != null);
    return mergeListings(listings);
  }
  if (sawPicks) {
    return mergeListings(
      picks.map((pick) => ({
        name: areaNames.get(pick.descriptionId) ?? "Tickets",
        offerType: null,
        inventoryType: pick.resale ? "resale" : "primary",
        sections: pick.example.section ? [pick.example.section] : [],
        price: pick.example.price,
        currency: pick.example.currency,
        quantity: pick.example.seats,
        sellableQuantities: [],
        examples: [pick.example],
      })),
    );
  }
  return null;
}

function collectOffers(record: Record<string, unknown>, offers: Map<string, OfferRecord>) {
  const embedded = record["_embedded"];
  if (!embedded || typeof embedded !== "object") return;
  const offerList = (embedded as Record<string, unknown>)["offer"];
  const items = Array.isArray(offerList)
    ? offerList
    : offerList && typeof offerList === "object"
      ? Object.values(offerList)
      : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const offer = item as Record<string, unknown>;
    const id = asString(offer["offerId"]) || asString(offer["id"]);
    if (!id) continue;
    const price = readPrice(offer);
    offers.set(id, {
      name: cleanText(asString(offer["name"]) || asString(offer["offerName"])),
      inventoryType: readInventoryType(offer["inventoryType"]),
      price: price.value,
      currency: price.currency,
      sellableQuantities: readNumberList(offer["sellableQuantities"]),
    });
  }
}

function collectAreaNames(record: Record<string, unknown>, areaNames: Map<string, string>) {
  const descriptions = record["descriptions"];
  if (!Array.isArray(descriptions)) return;
  for (const item of descriptions) {
    if (!item || typeof item !== "object") continue;
    const description = item as Record<string, unknown>;
    const id = asString(description["id"]);
    const names = readStringList(description["descriptions"])
      .map(cleanText)
      .filter((name) => name && name !== ".");
    if (id && names[0]) areaNames.set(id, names[0]);
  }
}

function parsePick(value: unknown): PickRecord | null {
  if (!value || typeof value !== "object") return null;
  const pick = value as Record<string, unknown>;
  const price = readPrice(pick);
  const from = asNumber(pick["seatFrom"]);
  const to = asNumber(pick["seatTo"]);
  const seats = from != null && to != null && to >= from ? Math.min(to - from + 1, 20) : 1;
  const section = cleanText(asString(pick["section"]));
  return {
    descriptionId: asString(pick["placeDescriptionId"]),
    resale:
      Boolean(pick["resaleListingId"]) || readInventoryType(pick["inventoryType"]) === "resale",
    example: {
      // Ticketmaster labels unallocated (standing) picks with the placeholder section "T1CKET".
      section: section && !/^t1cket$/i.test(section) ? section : null,
      row: cleanText(asString(pick["row"])) || null,
      seats,
      price: price.value,
      currency: price.currency,
    },
  };
}

function readPrice(record: Record<string, unknown>) {
  const currency = asString(record["currency"]).toUpperCase() || "GBP";
  for (const key of ["totalPrice", "price", "originalPrice", "listPrice", "faceValue"]) {
    const value = asNumber(record[key]);
    if (value != null && value > 0) return { value: round2(value), currency };
  }
  for (const key of ["totalPriceRange", "listPriceRange", "priceRange", "priceRanges"]) {
    const ranges = record[key];
    const first = Array.isArray(ranges) ? ranges[0] : ranges;
    if (first && typeof first === "object") {
      const range = first as Record<string, unknown>;
      const min = asNumber(range["min"]);
      if (min != null && min > 0) {
        return {
          value: round2(min),
          currency: asString(range["currency"]).toUpperCase() || currency,
        };
      }
    }
  }
  return { value: null, currency };
}

function facetToListing(
  facet: Record<string, unknown>,
  offers: Map<string, OfferRecord>,
  areaNames: Map<string, string>,
  picks: PickRecord[],
): TicketListing | null {
  if (facet["available"] === false) return null;
  const quantity = asNumber(facet["count"]) ?? 0;
  if (quantity <= 0) return null;

  const inventoryTypes = readStringList(facet["inventoryTypes"]);
  const facetOffers = readStringList(facet["offers"])
    .map((id) => offers.get(id))
    .filter((offer): offer is OfferRecord => Boolean(offer));
  const inventoryType = inventoryTypes[0]
    ? readInventoryType(inventoryTypes[0])
    : (facetOffers[0]?.inventoryType ?? "unknown");
  const offerType = readStringList(facet["offerTypes"])[0] ?? null;
  const descriptionId = asString(facet["description"]);

  // Example seats: same area and same primary/resale kind, cheapest first.
  const examples = picks
    .filter(
      (pick) =>
        pick.descriptionId === descriptionId && pick.resale === (inventoryType === "resale"),
    )
    .map((pick) => pick.example)
    .sort((left, right) => (left.price ?? Infinity) - (right.price ?? Infinity));
  const offerPrice = facetOffers
    .map((offer) => offer.price)
    .filter((price): price is number => price != null)
    .sort((left, right) => left - right)[0];
  const examplePrice = examples.find((example) => example.price != null);

  const sections = [
    ...new Set([
      ...readStringList(facet["sections"] ?? facet["section"]),
      ...readStringList(facet["places"])
        .map(decodePlaceSection)
        .filter((section): section is string => Boolean(section)),
    ]),
  ];

  return {
    name:
      areaNames.get(descriptionId) ??
      (facetOffers.find((offer) => offer.name)?.name || offerTypeLabel(offerType)),
    offerType,
    inventoryType,
    sections,
    price: offerPrice ?? examplePrice?.price ?? null,
    currency: examplePrice?.currency ?? facetOffers[0]?.currency ?? "GBP",
    quantity,
    sellableQuantities: facetOffers.flatMap((offer) => offer.sellableQuantities),
    examples,
  };
}

function offerTypeLabel(offerType: string | null) {
  if (!offerType || offerType === "standard") return "Standard Tickets";
  return `${offerType.charAt(0).toUpperCase()}${offerType.slice(1)} Tickets`;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Ticketmaster `places` entries are base32 "SECTION:ROW:SEAT" prefixes followed by a compressed
// [..] tail, e.g. "IJGCAMJWHJDUOORUGA[2[A,Q],3A]" -> "BL 16:GG:40". The section survives intact.
export function decodePlaceSection(place: string) {
  const prefix = place.split("[")[0] ?? "";
  let bits = "";
  for (const char of prefix.toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    bits += index.toString(2).padStart(5, "0");
  }
  let decoded = "";
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    decoded += String.fromCharCode(parseInt(bits.slice(offset, offset + 8), 2));
  }
  if (!decoded.includes(":")) return null;
  const section = decoded.split(":")[0]!.trim();
  return /^[\x20-\x7e]{1,24}$/.test(section) ? section : null;
}

function mergeListings(listings: TicketListing[]) {
  const merged = new Map<string, TicketListing>();
  for (const listing of listings) {
    const key = listingKey(listing);
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += listing.quantity;
      if (listing.price != null && (existing.price == null || listing.price < existing.price)) {
        existing.price = listing.price;
      }
      existing.sections = [...new Set([...existing.sections, ...listing.sections])];
      existing.sellableQuantities = [
        ...new Set([...existing.sellableQuantities, ...listing.sellableQuantities]),
      ];
      for (const example of listing.examples) {
        if (!existing.examples.some((item) => sameExample(item, example))) {
          existing.examples.push(example);
        }
      }
    } else {
      merged.set(key, {
        ...listing,
        sections: [...listing.sections],
        sellableQuantities: [...listing.sellableQuantities],
        examples: [...listing.examples],
      });
    }
  }
  return [...merged.values()]
    .map((listing) => ({
      ...listing,
      sections: [...listing.sections].sort(naturalCompare),
      examples: [...listing.examples].sort(
        (left, right) => (left.price ?? Infinity) - (right.price ?? Infinity),
      ),
    }))
    .sort(
      (left, right) =>
        (left.price ?? Infinity) - (right.price ?? Infinity) || left.name.localeCompare(right.name),
    );
}

function sameExample(left: SeatExample, right: SeatExample) {
  return left.section === right.section && left.row === right.row && left.price === right.price;
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}

// Identity of a listing: area + primary/resale. Quantity and price are deliberately left out:
// Ticketmaster only returns a few cheapest seats per check, so an area's known price comes and
// goes between checks and must not make the same stock look new.
export function listingKey(listing: TicketListing) {
  return [listing.inventoryType, listing.name.toLowerCase(), listing.currency].join("|");
}

// ---------------------------------------------------------------------------------------------
// Filters

export function applyTargetFilters(listings: TicketListing[], filters: TargetFilters) {
  const matched: TicketListing[] = [];
  const rejectedSections = new Set<string>();
  let filteredOutListings = 0;

  for (const listing of listings) {
    if (listingMatches(listing, filters)) {
      matched.push(listing);
    } else {
      filteredOutListings += 1;
      for (const section of sectionKeys(listing)) rejectedSections.add(section);
    }
  }
  for (const listing of matched) {
    for (const section of sectionKeys(listing)) rejectedSections.delete(section);
  }

  return { matched, filteredOutListings, filteredOutSections: rejectedSections.size };
}

function sectionKeys(listing: TicketListing) {
  return listing.sections.length > 0
    ? listing.sections.map((section) => section.toLowerCase())
    : [listing.name.toLowerCase()];
}

function listingMatches(listing: TicketListing, filters: TargetFilters) {
  const sections = filters.sectionFilters.map(normalize).filter(Boolean);
  if (sections.length > 0) {
    const haystacks = [listing.name, ...listing.sections].map(normalize);
    const matches = sections.some((wanted) =>
      haystacks.some((value) => value === wanted || value.includes(wanted)),
    );
    if (!matches) return false;
  }
  if (filters.maxPrice != null && (listing.price == null || listing.price > filters.maxPrice)) {
    return false;
  }
  if (
    filters.normalTicketsOnly &&
    PREMIUM_PATTERN.test(`${listing.name} ${listing.offerType ?? ""}`)
  ) {
    return false;
  }

  const minimum = Math.max(1, filters.minTickets);
  const purchasable =
    listing.sellableQuantities.length > 0
      ? listing.sellableQuantities.filter((quantity) => quantity <= listing.quantity)
      : Array.from({ length: Math.min(listing.quantity, 20) }, (_, index) => index + 1);
  return purchasable.some(
    (quantity) => quantity >= minimum && (!filters.evenTicketQuantitiesOnly || quantity % 2 === 0),
  );
}

export function buildInventoryReport(input: {
  event: EventDetails;
  listings: TicketListing[] | null;
  filters: TargetFilters;
}): InventoryReport {
  const listings = input.listings ?? [];
  const { matched, filteredOutListings, filteredOutSections } = applyTargetFilters(
    listings,
    input.filters,
  );
  return {
    event: input.event,
    inventoryKnown: input.listings != null,
    listings,
    matched,
    totalStock: matched.reduce((sum, listing) => sum + listing.quantity, 0),
    filteredOutListings,
    filteredOutSections,
  };
}

// Short dashboard text for the target row.
export function summarizeReport(report: InventoryReport) {
  if (!report.inventoryKnown) return "Page loaded; no inventory data exposed yet";
  if (report.matched.length === 0) {
    return report.listings.length > 0
      ? `No tickets matching filters (${report.listings.length} listing${report.listings.length === 1 ? "" : "s"} outside filters)`
      : "No tickets listed";
  }
  const parts = report.matched
    .slice(0, 6)
    .map(
      (listing) =>
        `${inventoryLabel(listing)} ${listing.price == null ? "" : `from ${formatMoney(listing)} `}×${listing.quantity}`,
    );
  const more = report.matched.length > 6 ? ` +${report.matched.length - 6} more` : "";
  return `${report.totalStock} ticket${report.totalStock === 1 ? "" : "s"} available: ${parts.join(", ")}${more}`.slice(
    0,
    1200,
  );
}

// Listings that are new, or whose quantity grew, compared with the previous snapshot.
// Listings that are new, or grew enough to be a real drop, compared with the previous snapshot.
// Large on-sale areas move by a few tickets whenever baskets expire; those small moves are not
// drops. An area counts when it was empty before, or grew by at least 25% (minimum 1 ticket),
// so a resale listing going from 1 to 2 still alerts while 586 -> 590 does not.
export function findNewStock(previous: Map<string, number> | null, matched: TicketListing[]) {
  if (!previous) return matched;
  return matched.filter((listing) => {
    const before = previous.get(listingKey(listing)) ?? 0;
    if (before <= 0) return listing.quantity > 0;
    return listing.quantity - before >= Math.max(1, Math.ceil(before * 0.25));
  });
}

export function stockSnapshot(matched: TicketListing[]) {
  return new Map(matched.map((listing) => [listingKey(listing), listing.quantity]));
}

// ---------------------------------------------------------------------------------------------
// Alert rendering

export interface TicketAlertContent {
  title: string;
  // Plain text for SMS/WhatsApp/the dashboard log.
  text: string;
  telegramHtml: string;
  discordEmbed: Record<string, unknown>;
  url: string;
  imageUrl: string | null;
}

type ListingGroup = {
  label: string;
  quantity: number;
  lines: { text: string; quantity: number }[];
};

function groupListings(listings: TicketListing[]) {
  const groups = new Map<string, ListingGroup>();
  for (const listing of listings) {
    const label = `${inventoryTitle(listing.inventoryType)}${listing.name}`;
    const group = groups.get(label) ?? { label, quantity: 0, lines: [] };
    group.quantity += listing.quantity;
    const price = listing.price == null ? "price on page" : `from ${formatMoney(listing)}`;
    group.lines.push({
      text: `${formatSections(listing.sections) ?? "TICKET"} | ${price}`,
      quantity: listing.quantity,
    });
    for (const example of listing.examples.slice(0, 3)) {
      const place = [
        example.section ? `Sec ${example.section}` : null,
        example.row ? `Row ${example.row}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      group.lines.push({
        text: `↳ ${place || "TICKET"} | ${formatMoney(example)}`,
        quantity: example.seats,
      });
    }
    groups.set(label, group);
  }
  // Resale (drops) first, then cheapest; the site keeps every area, the alert shows the best.
  return [...groups.values()].sort(
    (left, right) =>
      Number(right.label.startsWith("Resale")) - Number(left.label.startsWith("Resale")),
  );
}

const MAX_GROUPS = 8;

function formatSections(sections: string[]) {
  if (sections.length === 0) return null;
  const shown = sections.slice(0, 6).join(", ");
  const label = sections.length === 1 ? "Sec" : "Secs";
  return `${label} ${shown}${sections.length > 6 ? ` +${sections.length - 6}` : ""}`;
}

export function buildTicketAlert(input: {
  report: InventoryReport;
  url: string;
  checkedAt: Date;
}): TicketAlertContent {
  const { report } = input;
  const { event } = report;
  const allGroups = groupListings(report.matched);
  const groups = allGroups.slice(0, MAX_GROUPS);
  const hiddenGroups = allGroups.length - groups.length;
  const footer = `HD-1 · ${formatTimestamp(input.checkedAt)} UTC`;
  const filteredNote =
    report.filteredOutSections > 0
      ? `+${report.filteredOutSections} section${report.filteredOutSections === 1 ? "" : "s"} filtered by preferences`
      : null;

  const details: [string, string | null][] = [
    ["Event ID", event.eventId],
    ["Venue", event.venue],
    ["Date", event.date],
    ["Location", event.location],
    ["Total Stock", report.inventoryKnown ? String(report.totalStock) : "See ticket page"],
  ];
  const pageSignalNote = report.inventoryKnown
    ? null
    : "Tickets appear to be on sale (detected from the page; stock not exposed)";

  const textLines = [
    `🎟 ${event.name}`,
    ...details.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`),
  ];
  if (filteredNote) textLines.push(`⚠️ ${filteredNote}`);
  if (pageSignalNote) textLines.push("", pageSignalNote);
  for (const group of groups) {
    textLines.push("", `${group.label} [${group.quantity}]`);
    for (const line of group.lines.slice(0, 12)) textLines.push(`${line.text} [${line.quantity}]`);
    if (group.lines.length > 12) textLines.push(`+${group.lines.length - 12} more`);
  }
  if (hiddenGroups > 0) textLines.push("", `+${hiddenGroups} more areas on the ticket page`);
  textLines.push("", `Buy Tickets: ${input.url}`, footer);

  const htmlLines = [
    `🎟 <b><a href="${escapeHtml(input.url)}">${escapeHtml(event.name)}</a></b>`,
    "",
    ...details
      .filter(([, value]) => value)
      .map(([label, value]) =>
        label === "Event ID"
          ? `<b>${label}:</b> <code>${escapeHtml(value!)}</code>`
          : `<b>${label}:</b> ${escapeHtml(value!)}`,
      ),
  ];
  if (filteredNote) htmlLines.push(`⚠️ <i>${escapeHtml(filteredNote)}</i>`);
  if (pageSignalNote) htmlLines.push("", escapeHtml(pageSignalNote));
  for (const group of groups) {
    htmlLines.push("", `<b>${escapeHtml(group.label)} [${group.quantity}]</b>`);
    for (const line of group.lines.slice(0, 12)) {
      htmlLines.push(`${escapeHtml(line.text)} [${line.quantity}]`);
    }
    if (group.lines.length > 12) htmlLines.push(`<i>+${group.lines.length - 12} more</i>`);
  }
  if (hiddenGroups > 0) htmlLines.push("", `<i>+${hiddenGroups} more areas on the ticket page</i>`);
  htmlLines.push("", `<i>${escapeHtml(footer)}</i>`);

  const fields: Record<string, unknown>[] = details
    .filter(([, value]) => value)
    .map(([label, value]) => ({ name: label, value: truncate(value!, 1024), inline: false }));
  for (const group of groups.slice(0, 18)) {
    const lines = group.lines.slice(0, 10).map((line) => `${line.text} [${line.quantity}]`);
    if (group.lines.length > 10) lines.push(`+${group.lines.length - 10} more`);
    fields.push({
      name: truncate(`${group.label} [${group.quantity}]`, 256),
      value: truncate(lines.join("\n"), 1024),
      inline: false,
    });
  }
  if (hiddenGroups > 0) {
    fields.push({
      name: "​",
      value: `+${hiddenGroups} more areas on the ticket page`,
      inline: false,
    });
  }
  fields.push({ name: "​", value: `**[Buy Tickets](${input.url})**`, inline: false });

  const embed: Record<string, unknown> = {
    title: truncate(event.name, 256),
    url: input.url,
    color: 0x10b981,
    fields,
    footer: { text: footer },
    timestamp: input.checkedAt.toISOString(),
  };
  const description = [filteredNote ? `⚠️ ${filteredNote}` : null, pageSignalNote]
    .filter(Boolean)
    .join("\n");
  if (description) embed["description"] = description;
  if (event.imageUrl) embed["thumbnail"] = { url: event.imageUrl };

  return {
    title: report.inventoryKnown
      ? `🎟 ${event.name}: ${report.totalStock} ticket${report.totalStock === 1 ? "" : "s"}`
      : `🎟 ${event.name}: tickets on sale`,
    text: textLines.join("\n"),
    telegramHtml: htmlLines.join("\n"),
    discordEmbed: embed,
    url: input.url,
    imageUrl: event.imageUrl,
  };
}

function inventoryTitle(type: InventoryType) {
  if (type === "resale") return "Resale: ";
  if (type === "primary") return "Primary: ";
  return "";
}

function inventoryLabel(listing: TicketListing) {
  return listing.inventoryType === "resale" ? `Resale ${listing.name}` : listing.name;
}

export function formatMoney(listing: Pick<TicketListing, "price" | "currency">) {
  if (listing.price == null) return "price n/a";
  const symbol =
    listing.currency === "GBP"
      ? "£"
      : listing.currency === "EUR"
        ? "€"
        : listing.currency === "USD"
          ? "$"
          : `${listing.currency} `;
  return `${symbol}${listing.price.toFixed(2)}`;
}

function formatTimestamp(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function readInventoryType(value: unknown): InventoryType {
  const text = asString(value).toLowerCase();
  if (text.includes("resale")) return "resale";
  if (text.includes("primary") || text.includes("standard")) return "primary";
  return "unknown";
}

function readStringList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean);
  const single = asString(value);
  return single ? [single] : [];
}

function readNumberList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asNumber(item))
    .filter((item): item is number => item != null && item > 0)
    .sort((left, right) => left - right);
}

function asString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(value: string) {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function absoluteUrl(value: string, base: string) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function decodeEntities(value: string) {
  return value
    .replace(/&pound;/gi, "£")
    .replace(/&euro;/gi, "€")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gi, "&");
}
