import { buildInventoryReport, buildTicketAlert, type TicketListing } from "./ticket-inventory.ts";

// "Test All Channels" sends this sample so each channel shows the real ticket-alert layout.
export function buildSampleTicketAlert(now: Date) {
  const listings: TicketListing[] = [
    {
      name: "FLOOR STANDING",
      offerType: "standard",
      inventoryType: "resale",
      sections: [],
      price: 70.8,
      currency: "GBP",
      quantity: 2,
      sellableQuantities: [],
      examples: [{ section: null, row: null, seats: 2, price: 70.8, currency: "GBP" }],
    },
  ];
  const report = buildInventoryReport({
    event: {
      name: "TEST ALERT - HD-1 Drop Monitor",
      eventId: "TEST0000000000",
      venue: "Sample Venue",
      date: "Sat 21 Nov 2026, 19:00",
      location: "Manchester, UK",
      imageUrl: null,
    },
    listings,
    filters: {
      sectionFilters: [],
      minTickets: 1,
      maxPrice: null,
      normalTicketsOnly: true,
      evenTicketQuantitiesOnly: false,
    },
  });
  return buildTicketAlert({
    report,
    url: process.env["EVENTPULSE_PUBLIC_URL"] || "https://www.ticketmaster.co.uk/",
    checkedAt: now,
  });
}
