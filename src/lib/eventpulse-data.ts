export type MonitorStatus = "available" | "monitoring" | "captcha" | "limited" | "paused";

export type Platform =
  "Ticketmaster UK/WW" | "AXS" | "SeeTickets" | "Gigs & Tours" | "Royal Albert Hall";

export const PLATFORM_FILTERS: Array<"All Sites" | Platform> = [
  "All Sites",
  "Ticketmaster UK/WW",
  "AXS",
  "SeeTickets",
  "Gigs & Tours",
  "Royal Albert Hall",
];

export const STATUS_META: Record<MonitorStatus, { label: string; className: string }> = {
  available: { label: "Tickets Available", className: "bg-online/15 text-online ring-online/30" },
  monitoring: { label: "Monitoring", className: "bg-info/15 text-info ring-info/30" },
  captcha: { label: "Captcha Challenge", className: "bg-warn/15 text-warn ring-warn/30" },
  limited: { label: "Rate Limited", className: "bg-alert/15 text-alert ring-alert/30" },
  paused: { label: "Paused", className: "bg-muted text-muted-foreground ring-border" },
};

// Pause times are shown in UTC so server and browser render the same text.
export function formatPauseUntil(pause: { pausedUntil: string | null }) {
  return pause.pausedUntil ? `until ${pause.pausedUntil.slice(11, 16)} UTC` : "until resumed";
}
