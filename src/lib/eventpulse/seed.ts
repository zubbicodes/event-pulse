import type { DashboardData } from "./types";

export const DEFAULT_SETTINGS = {
  refreshSeconds: 10,
  soundAlerts: true,
  pushAlerts: true,
  smsAlerts: false,
  whatsappAlerts: false,
  autoRotateProxyOnRateLimit: false,
  maintainStickyMobileIp: true,
  multiloginEndpoint: "http://localhost:35462",
  multiloginStatePolicy: "save_profile_state_on_user_action",
};

export function getEmptyDashboardData(
  message = "Supabase not connected. No production data loaded.",
): DashboardData {
  return {
    targets: [],
    profiles: [],
    alerts: [],
    settings: DEFAULT_SETTINGS,
    stats: {
      activeMonitors: 0,
      alertsToday: 0,
      connectedProfiles: 0,
      avgResponseMs: 0,
    },
    backendConnected: false,
    backendMessage: message,
  };
}

export function buildDeepLink(
  url: string,
  filters: {
    sectionFilters: string[];
    minTickets: number;
    maxPrice: number | null;
    normalTicketsOnly: boolean;
    evenTicketQuantitiesOnly?: boolean;
  },
) {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const link = new URL(normalized);
  link.searchParams.set("qty", String(filters.minTickets));
  if (filters.sectionFilters.length > 0) {
    link.searchParams.set("sections", filters.sectionFilters.join(","));
  }
  if (filters.maxPrice != null) {
    link.searchParams.set("maxPrice", String(filters.maxPrice));
  }
  if (filters.normalTicketsOnly) {
    link.searchParams.set("ticketType", "standard");
  }
  if (filters.evenTicketQuantitiesOnly) {
    link.searchParams.set("quantityRule", "even");
  }
  return link.toString();
}
