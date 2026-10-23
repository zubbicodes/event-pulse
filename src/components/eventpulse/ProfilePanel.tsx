import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Pause, Play, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BackendProfileRow, BackendSettings } from "@/lib/eventpulse/types";
import {
  deleteProfileFn,
  launchProfileFn,
  pauseProfileFn,
  resumeProfileFn,
  saveProfileSessionFn,
  saveSettingsFn,
  upsertProfileFn,
} from "@/lib/eventpulse/server-fns";
import { formatPauseUntil } from "@/lib/eventpulse-data";

const PAUSE_OPTIONS = [
  { value: "15", label: "15 min" },
  { value: "60", label: "1 hour" },
  { value: "360", label: "6 hours" },
  { value: "manual", label: "Until resumed" },
];

export function ProfilePanel({
  profiles,
  settings,
}: {
  profiles: BackendProfileRow[];
  settings: BackendSettings;
}) {
  const [autoRotate, setAutoRotate] = useState(settings.autoRotateProxyOnRateLimit);
  const [stickyMobile, setStickyMobile] = useState(settings.maintainStickyMobileIp);
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [deletingProfileName, setDeletingProfileName] = useState<string | null>(null);
  const [pauseChoice, setPauseChoice] = useState<Record<string, string>>({});
  const [pausingProfileName, setPausingProfileName] = useState<string | null>(null);
  const [profileForm, setProfileForm] = useState({
    profileName: "",
    region: "",
    cookiesStatus: "Unknown",
    sessionStatus: "Not Captured",
    fingerprintHealth: "Unknown",
    multiloginProfileId: "",
    multiloginFolderId: "",
    stickyIpLabel: "",
  });
  const launchProfile = useServerFn(launchProfileFn);
  const saveProfileSession = useServerFn(saveProfileSessionFn);
  const saveSettings = useServerFn(saveSettingsFn);
  const deleteProfile = useServerFn(deleteProfileFn);
  const upsertProfile = useServerFn(upsertProfileFn);
  const pauseProfile = useServerFn(pauseProfileFn);
  const resumeProfile = useServerFn(resumeProfileFn);
  const router = useRouter();

  async function saveState(profile: BackendProfileRow) {
    setMessage("");
    try {
      await saveProfileSession({
        data: {
          profileName: profile.name,
          stateLabel: `${profile.name} mobile checkout state`,
          sessionState: {
            savedAt: new Date().toISOString(),
            policy: "save_profile_state_on_user_action",
            profileName: profile.name,
            stickyIp: profile.stickyIp,
            note: "Stores MultiLogin restore metadata. External browser cookies require MultiLogin/local bridge export.",
          },
        },
      });
      await router.invalidate();
      setMessage(`${profile.name} state saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile state save failed.");
    }
  }

  async function saveProfile() {
    setSavingProfile(true);
    setMessage("");
    try {
      await upsertProfile({ data: profileForm });
      setMessage(`${profileForm.profileName} profile saved.`);
      setShowForm(false);
      setProfileForm((value) => ({ ...value, profileName: "", multiloginProfileId: "" }));
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile save failed.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function removeProfile(profileName: string) {
    const ok = window.confirm(
      `Delete profile "${profileName}"? Saved session snapshots for this profile will also be removed.`,
    );
    if (!ok) return;

    setDeletingProfileName(profileName);
    setMessage("");
    try {
      await deleteProfile({ data: { profileName } });
      await router.invalidate();
      setMessage(`${profileName} profile deleted.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile delete failed.");
    } finally {
      setDeletingProfileName(null);
    }
  }

  async function launchProfileSession(profile: BackendProfileRow) {
    setMessage("");
    if (!profile.multiloginProfileId) {
      setMessage(`${profile.name} has no MultiLogin profile ID.`);
      return;
    }

    try {
      const result = (await launchProfile({
        data: {
          profileName: profile.name,
          profileId: profile.multiloginProfileId,
          folderId: profile.multiloginFolderId,
          endpoint: settings.multiloginEndpoint,
        },
      })) as { message: string };
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MultiLogin launch failed.");
    }
  }

  async function togglePause(profile: BackendProfileRow) {
    setPausingProfileName(profile.name);
    setMessage("");
    try {
      if (profile.pause) {
        await resumeProfile({ data: { profileName: profile.name } });
        setMessage(`${profile.name} resumed; its targets are checked again.`);
      } else {
        const choice = pauseChoice[profile.name] ?? "60";
        await pauseProfile({
          data: { profileName: profile.name, minutes: choice === "manual" ? null : Number(choice) },
        });
        setMessage(`${profile.name} paused; its targets are skipped until resumed or expired.`);
      }
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile pause update failed.");
    } finally {
      setPausingProfileName(null);
    }
  }

  async function saveProxyControls(next: {
    autoRotateProxyOnRateLimit: boolean;
    maintainStickyMobileIp: boolean;
  }) {
    setMessage("");
    try {
      await saveSettings({
        data: {
          ...settings,
          ...next,
        },
      });
      await router.invalidate();
      setMessage("Proxy controls saved to Supabase.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Proxy controls save failed.");
    }
  }

  return (
    <section className="panel p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <h2 className="truncate font-display text-sm font-bold uppercase tracking-wide">
          MultiLogin &amp; Proxy Profiles
        </h2>
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-online/10 px-2 py-0.5 font-mono text-[11px] text-online ring-1 ring-online/25">
            {profiles.length} Active
          </span>
          <Button size="sm" variant="secondary" onClick={() => setShowForm((value) => !value)}>
            {showForm ? "Close" : "Add Profile"}
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="mt-3 grid gap-3 rounded-md bg-secondary/60 p-3 md:grid-cols-2 xl:grid-cols-4">
          <Input
            value={profileForm.profileName}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, profileName: event.target.value }))
            }
            placeholder="Profile name"
            className="text-xs"
          />
          <Input
            value={profileForm.multiloginProfileId}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, multiloginProfileId: event.target.value }))
            }
            placeholder="MultiLogin profile ID"
            className="text-xs"
          />
          <Input
            value={profileForm.multiloginFolderId}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, multiloginFolderId: event.target.value }))
            }
            placeholder="MultiLogin X folder ID"
            className="text-xs"
          />
          <Input
            value={profileForm.region}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, region: event.target.value }))
            }
            placeholder="Assigned IP / region"
            className="text-xs"
          />
          <Input
            value={profileForm.stickyIpLabel}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, stickyIpLabel: event.target.value }))
            }
            placeholder="Sticky IP label"
            className="text-xs"
          />
          <Input
            value={profileForm.cookiesStatus}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, cookiesStatus: event.target.value }))
            }
            placeholder="Cookies status"
            className="text-xs"
          />
          <Input
            value={profileForm.sessionStatus}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, sessionStatus: event.target.value }))
            }
            placeholder="Session status"
            className="text-xs"
          />
          <Input
            value={profileForm.fingerprintHealth}
            onChange={(event) =>
              setProfileForm((value) => ({ ...value, fingerprintHealth: event.target.value }))
            }
            placeholder="Fingerprint health"
            className="text-xs"
          />
          <Button disabled={savingProfile || !profileForm.profileName} onClick={saveProfile}>
            Save Profile
          </Button>
        </div>
      )}

      <div className="scrollbar-hidden mt-3 -mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[960px] border-collapse text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Profile</th>
              <th className="py-2 pr-3 font-medium">Monitoring</th>
              <th className="py-2 pr-3 font-medium">Assigned IP / Region</th>
              <th className="py-2 pr-3 font-medium">Cookies</th>
              <th className="py-2 pr-3 font-medium">TM Session</th>
              <th className="py-2 pr-3 font-medium">Fingerprint Health</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 && (
              <tr className="border-t border-border">
                <td className="py-4 pr-3 text-muted-foreground" colSpan={7}>
                  No production profiles yet. Add or import MultiLogin profile metadata before
                  saving session state.
                </td>
              </tr>
            )}
            {profiles.map((p) => (
              <tr key={p.name} className="border-t border-border">
                <td className="py-2.5 pr-3 font-mono font-semibold">{p.name}</td>
                <td className="py-2.5 pr-3">
                  {p.pause ? (
                    <span
                      className="rounded-full bg-alert/15 px-2 py-0.5 font-mono text-[11px] text-alert ring-1 ring-alert/30"
                      title={p.pause.reason}
                    >
                      Paused {formatPauseUntil(p.pause)}
                    </span>
                  ) : (
                    <span className="rounded-full bg-online/10 px-2 py-0.5 font-mono text-[11px] text-online ring-1 ring-online/25">
                      Active
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-3 text-muted-foreground">{p.region}</td>
                <td className="py-2.5 pr-3 text-online">{p.cookies}</td>
                <td className="py-2.5 pr-3">
                  <span className={p.session === "Authenticated" ? "text-online" : "text-warn"}>
                    {p.session}
                  </span>
                </td>
                <td className="py-2.5">
                  <span className={p.health.startsWith("Clean") ? "text-online" : "text-warn"}>
                    {p.health}
                  </span>
                </td>
                <td className="whitespace-nowrap py-2.5">
                  {!p.pause && (
                    <select
                      aria-label={`Pause duration for ${p.name}`}
                      className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
                      value={pauseChoice[p.name] ?? "60"}
                      onChange={(event) =>
                        setPauseChoice((value) => ({ ...value, [p.name]: event.target.value }))
                      }
                    >
                      {PAUSE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    size="sm"
                    variant={p.pause ? "default" : "secondary"}
                    className="ml-1 h-7 px-2 text-[11px]"
                    disabled={pausingProfileName === p.name}
                    onClick={() => void togglePause(p)}
                  >
                    {p.pause ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                    {p.pause ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-2 h-7 px-2 text-[11px]"
                    disabled={!p.multiloginProfileId}
                    onClick={() => void launchProfileSession(p)}
                  >
                    <Play className="h-3.5 w-3.5" />
                    Launch
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-2 h-7 px-2 text-[11px]"
                    onClick={() => void saveState(p)}
                  >
                    Save State
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="ml-2 h-7 px-2 text-[11px]"
                    disabled={deletingProfileName === p.name}
                    onClick={() => void removeProfile(p.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          Auto-Rotate Proxy on Rate Limit
          <Switch
            checked={autoRotate}
            onCheckedChange={(checked) => {
              setAutoRotate(checked);
              void saveProxyControls({
                autoRotateProxyOnRateLimit: checked,
                maintainStickyMobileIp: stickyMobile,
              });
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          Maintain Sticky Mobile IP
          <Switch
            checked={stickyMobile}
            onCheckedChange={(checked) => {
              setStickyMobile(checked);
              void saveProxyControls({
                autoRotateProxyOnRateLimit: autoRotate,
                maintainStickyMobileIp: checked,
              });
            }}
          />
        </label>
      </div>
      {message && <p className="mt-3 text-xs text-muted-foreground">{message}</p>}
    </section>
  );
}
