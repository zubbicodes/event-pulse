import type { MonitorStatus, Platform } from "@/lib/eventpulse-data";

export interface TargetFilterConfig {
  sectionFilters: string[];
  minTickets: number;
  maxPrice: number | null;
  normalTicketsOnly: boolean;
  evenTicketQuantitiesOnly: boolean;
}

export interface BackendMonitorTarget {
  id: string;
  platform: Platform;
  event: string;
  venue: string;
  status: MonitorStatus | "paused";
  availability: string;
  url: string;
  refresh: number;
  profile: string;
  proxy: string;
  deepLink: string;
  filters: TargetFilterConfig;
  monitorStartsAt: string | null;
  monitorEndsAt: string | null;
  lastCheckedAt: string | null;
  responseMs: number | null;
}

export interface BackendProfileRow {
  name: string;
  region: string;
  cookies: string;
  session: string;
  health: string;
  stickyIp: string;
  multiloginProfileId: string | null;
  multiloginFolderId: string | null;
  lastSessionSavedAt: string | null;
}

export interface BackendAlertLog {
  id: string;
  time: string;
  tone: "online" | "info" | "warn" | "alert";
  text: string;
  deepLink: string | null;
}

export interface BackendSettings {
  refreshSeconds: number;
  soundAlerts: boolean;
  pushAlerts: boolean;
  smsAlerts: boolean;
  whatsappAlerts: boolean;
  autoRotateProxyOnRateLimit: boolean;
  maintainStickyMobileIp: boolean;
  multiloginEndpoint: string;
  multiloginStatePolicy: string;
}

export interface DashboardStats {
  activeMonitors: number;
  alertsToday: number;
  connectedProfiles: number;
  avgResponseMs: number;
}

export interface DashboardData {
  targets: BackendMonitorTarget[];
  profiles: BackendProfileRow[];
  alerts: BackendAlertLog[];
  settings: BackendSettings;
  stats: DashboardStats;
  backendConnected: boolean;
  backendMessage: string;
}

export interface NewTargetInput {
  platform: Platform;
  event: string;
  venue: string;
  url: string;
  refresh: number;
  profile: string;
  proxy: string;
  sectionFilters: string[];
  minTickets: number;
  maxPrice: number | null;
  normalTicketsOnly: boolean;
  evenTicketQuantitiesOnly: boolean;
  monitorStartsAt: string | null;
  monitorEndsAt: string | null;
}

export type SaveSettingsInput = BackendSettings;

export interface NewProfileInput {
  profileName: string;
  region: string;
  cookiesStatus: string;
  sessionStatus: string;
  fingerprintHealth: string;
  multiloginProfileId: string;
  multiloginFolderId: string;
  stickyIpLabel: string;
}

export interface LaunchProfileInput {
  profileName: string;
  profileId: string;
  folderId: string | null;
  endpoint: string;
}

export interface SaveProfileSessionInput {
  profileName: string;
  stateLabel: string;
  sessionState: Record<string, unknown>;
}

export interface SavePushSubscriptionInput {
  endpoint: string;
  subscription: Record<string, unknown>;
  userAgent: string;
}

export interface MonitorRunResult {
  checked: number;
  alertsCreated: number;
  pushSent: number;
  smsSent: number;
  whatsappSent: number;
  errors: string[];
}
