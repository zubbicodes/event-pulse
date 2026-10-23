// Per-profile pause state for the monitor scheduler.
//
// Ticketmaster answers too-frequent page loads from one profile (one sticky residential IP) with
// HTTP 403 "Let's Get Your Identity Verified" or 429. Reloading every refresh interval while
// blocked keeps the block alive and floods every alert channel, so a blocked profile is paused
// with an escalating cooldown (5, 10, 20, 40, 60 minutes) and retried automatically. Profiles can
// also be paused and resumed by hand from the dashboard.
//
// State lives in this process: production runs exactly one scheduler instance, and a restart
// simply lets every profile be checked again.

const BASE_PAUSE_MS = 5 * 60 * 1000;
const MAX_PAUSE_MS = 60 * 60 * 1000;

export type ProfilePauseState = {
  pausedUntil: string | null;
  reason: string;
  manual: boolean;
};

type PauseEntry = {
  // null with manual=true means paused until someone resumes it.
  pausedUntil: number | null;
  reason: string;
  manual: boolean;
  // Consecutive automatic blocks without a successful check in between.
  blockLevel: number;
};

const pauses = new Map<string, PauseEntry>();

export function getProfilePause(profileName: string, now = Date.now()): ProfilePauseState | null {
  const entry = pauses.get(profileName);
  if (!entry || !isActive(entry, now)) return null;
  return {
    pausedUntil: entry.pausedUntil == null ? null : new Date(entry.pausedUntil).toISOString(),
    reason: entry.reason,
    manual: entry.manual,
  };
}

export function isProfilePaused(profileName: string, now = Date.now()) {
  const entry = pauses.get(profileName);
  return Boolean(entry && isActive(entry, now));
}

export function recordProfileBlock(profileName: string, statusCode: number, now = Date.now()) {
  const previous = pauses.get(profileName);
  const blockLevel = (previous?.manual ? 0 : (previous?.blockLevel ?? 0)) + 1;
  const pauseMs = Math.min(BASE_PAUSE_MS * 2 ** (blockLevel - 1), MAX_PAUSE_MS);
  const entry: PauseEntry = {
    pausedUntil: now + pauseMs,
    reason:
      statusCode === 429
        ? "Ticketmaster rate limited this profile (HTTP 429)."
        : "Ticketmaster blocked this profile with an identity check (HTTP 403).",
    manual: false,
    blockLevel,
  };
  pauses.set(profileName, entry);
  return { pausedUntil: new Date(entry.pausedUntil!).toISOString(), blockLevel, pauseMs };
}

// Returns true when the profile had been blocked and this successful check cleared it.
export function recordProfileSuccess(profileName: string) {
  const entry = pauses.get(profileName);
  if (!entry || entry.manual) return false;
  pauses.delete(profileName);
  return true;
}

export function pauseProfileManually(
  profileName: string,
  minutes: number | null,
  now = Date.now(),
) {
  pauses.set(profileName, {
    pausedUntil: minutes == null ? null : now + minutes * 60 * 1000,
    reason: "Paused from the dashboard.",
    manual: true,
    blockLevel: 0,
  });
  return getProfilePause(profileName, now);
}

export function resumeProfile(profileName: string) {
  pauses.delete(profileName);
}

function isActive(entry: PauseEntry, now: number) {
  return entry.pausedUntil == null || entry.pausedUntil > now;
}
