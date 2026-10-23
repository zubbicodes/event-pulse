import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { OctagonPause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BackendProfileRow } from "@/lib/eventpulse/types";
import { formatPauseUntil } from "@/lib/eventpulse-data";
import { resumeProfileFn } from "@/lib/eventpulse/server-fns";

// Shown above the dashboard whenever the scheduler is skipping a profile, so a Ticketmaster block
// is visible without opening the profile table.
export function ProfilePauseBanner({
  profiles,
  onViewProfiles,
}: {
  profiles: BackendProfileRow[];
  onViewProfiles: () => void;
}) {
  const resumeProfile = useServerFn(resumeProfileFn);
  const router = useRouter();
  const [busyProfile, setBusyProfile] = useState<string | null>(null);
  const paused = profiles.filter((profile) => profile.pause);
  if (paused.length === 0) return null;

  async function resume(profileName: string) {
    setBusyProfile(profileName);
    try {
      await resumeProfile({ data: { profileName } });
      await router.invalidate();
    } finally {
      setBusyProfile(null);
    }
  }

  return (
    <div className="space-y-2 rounded-md bg-alert/10 p-3 ring-1 ring-alert/30">
      {paused.map((profile) => (
        <div
          key={profile.name}
          className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-2">
            <OctagonPause className="mt-0.5 h-4 w-4 shrink-0 text-alert" />
            <p className="min-w-0">
              <span className="font-mono font-semibold">{profile.name}</span> paused{" "}
              {formatPauseUntil(profile.pause!)}.{" "}
              <span className="text-muted-foreground">
                {profile.pause!.reason} Its targets are not checked while paused.
              </span>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-[11px]"
              onClick={onViewProfiles}
            >
              View profiles
            </Button>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={busyProfile === profile.name}
              onClick={() => void resume(profile.name)}
            >
              <Play className="h-3.5 w-3.5" />
              Resume now
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
