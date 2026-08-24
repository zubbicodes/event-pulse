import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  deleteProfile,
  deleteTarget,
  insertTarget,
  launchMultiloginProfile,
  loadDashboardData,
  saveProfileSession,
  savePushSubscription,
  saveSettings,
  setTargetStatus,
  upsertProfile,
} from "./supabase.server";

const platformSchema = z.enum([
  "Ticketmaster UK/WW",
  "AXS",
  "SeeTickets",
  "Gigs & Tours",
  "Royal Albert Hall",
]);

const targetStatusSchema = z.enum(["available", "monitoring", "captcha", "limited", "paused"]);

export const getDashboardDataFn = createServerFn({ method: "GET" }).handler(async () => {
  return await loadDashboardData();
});

export const addTargetFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      platform: platformSchema,
      event: z.string().min(1),
      venue: z.string().default(""),
      url: z.string().min(1),
      refresh: z.number().min(1).max(30),
      profile: z.string().default(""),
      proxy: z.string().default(""),
      sectionFilters: z.array(z.string()).default([]),
      minTickets: z.number().int().min(1).max(10),
      maxPrice: z.number().nullable().default(null),
      normalTicketsOnly: z.boolean().default(true),
      evenTicketQuantitiesOnly: z.boolean().default(false),
      monitorStartsAt: z.string().nullable().default(null),
      monitorEndsAt: z.string().nullable().default(null),
    }),
  )
  .handler(async ({ data }) => {
    return await insertTarget(data);
  });

export const updateTargetStatusFn = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1), status: targetStatusSchema }))
  .handler(async ({ data }) => {
    return await setTargetStatus(data.id, data.status);
  });

export const deleteTargetFn = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    return await deleteTarget(data.id);
  });

export const saveSettingsFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      refreshSeconds: z.number().int().min(1).max(30),
      soundAlerts: z.boolean(),
      pushAlerts: z.boolean(),
      smsAlerts: z.boolean(),
      whatsappAlerts: z.boolean(),
      autoRotateProxyOnRateLimit: z.boolean(),
      maintainStickyMobileIp: z.boolean(),
      multiloginEndpoint: z.string().min(1),
      multiloginStatePolicy: z.string().min(1),
    }),
  )
  .handler(async ({ data }) => {
    return await saveSettings(data);
  });

export const upsertProfileFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      profileName: z.string().min(1),
      region: z.string().default(""),
      cookiesStatus: z.string().default("Unknown"),
      sessionStatus: z.string().default("Not Captured"),
      fingerprintHealth: z.string().default("Unknown"),
      multiloginProfileId: z.string().default(""),
      multiloginFolderId: z.string().default(""),
      stickyIpLabel: z.string().default(""),
    }),
  )
  .handler(async ({ data }) => {
    return await upsertProfile(data);
  });

export const deleteProfileFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileName: z.string().min(1) }))
  .handler(async ({ data }) => {
    return await deleteProfile(data.profileName);
  });

export const launchProfileFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      profileName: z.string().min(1),
      profileId: z.string().min(1),
      folderId: z.string().nullable(),
      endpoint: z.string().min(1),
    }),
  )
  .handler(async ({ data }) => {
    return await launchMultiloginProfile(data);
  });

export const saveProfileSessionFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      profileName: z.string().min(1),
      stateLabel: z.string().min(1),
      sessionState: z.record(z.string(), z.unknown()),
    }),
  )
  .handler(async ({ data }) => {
    return await saveProfileSession(data);
  });

export const savePushSubscriptionFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      endpoint: z.string().url(),
      subscription: z.record(z.string(), z.unknown()),
      userAgent: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    return await savePushSubscription(data);
  });
