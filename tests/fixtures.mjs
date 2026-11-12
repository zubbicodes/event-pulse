// Test fixtures built from real Ticketmaster UK responses captured on 2026-11-12
// (tests/fixtures/ticketmaster/*): the event page's JSON-LD plus the two inventory responses the
// page loads itself — ISMDS facets (counts) and quickpicks (cheapest seats, area names).

import { readFileSync } from "node:fs";

const DIR = new URL("./fixtures/ticketmaster/", import.meta.url);

export const EVENTS = {
  billBailey: { id: "37006374A07F3DED", file: "bill-bailey" },
  theScript: { id: "350064B5E71389D3", file: "the-script" },
  elbowSoldOut: { id: "3E006514E54A31B8", file: "elbow-sold-out" },
};

export function loadEvent(event) {
  return {
    html: readFileSync(new URL(`${event.file}.html`, DIR), "utf8"),
    payloads: JSON.parse(readFileSync(new URL(`${event.file}.inventory.json`, DIR), "utf8")),
  };
}

// Bill Bailey inventory reduced to one resale "Arena Floor" area with `resaleCount` tickets, plus
// (optionally) a platinum area, for scenario tests. Same shapes as the real responses.
export function billBaileyScenario({ resaleCount = 1, platinum = true } = {}) {
  const [facetsResponse, quickpicks] = loadEvent(EVENTS.billBailey).payloads;
  const resaleArenaFloor = facetsResponse.facets.find(
    (facet) => facet.description === "IE5DC" && facet.inventoryTypes[0] === "resale",
  );
  const facets = [];
  if (resaleCount > 0) facets.push({ ...resaleArenaFloor, count: resaleCount });
  if (platinum) {
    const primary = facetsResponse.facets.find((facet) => facet.inventoryTypes[0] === "primary");
    facets.push({ ...primary, description: "IE5DG", offerTypes: ["platinum"], count: 2 });
  }
  return [
    { ...facetsResponse, facets },
    {
      ...quickpicks,
      picks: resaleCount > 0 ? quickpicks.picks.slice(0, 1) : [],
      total: resaleCount,
    },
  ];
}
