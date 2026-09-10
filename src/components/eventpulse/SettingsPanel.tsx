import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useRouter } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { BellRing, Send } from "lucide-react";
import { showTestNotification, setupPushNotifications } from "@/lib/pwa";
import type { BackendSettings } from "@/lib/eventpulse/types";
import { savePushSubscriptionFn, saveSettingsFn } from "@/lib/eventpulse/server-fns";

export function SettingsPanel({ settings }: { settings: BackendSettings }) {
  const [interval, setInterval] = useState([settings.refreshSeconds]);
  const [sound, setSound] = useState(settings.soundAlerts);
  const [push, setPush] = useState(settings.pushAlerts);
  const [sms, setSms] = useState(settings.smsAlerts);
  const [whatsapp, setWhatsapp] = useState(settings.whatsappAlerts);
  const [telegram, setTelegram] = useState(settings.telegramAlerts);
  const [discord, setDiscord] = useState(settings.discordAlerts);
  const [multiloginEndpoint, setMultiloginEndpoint] = useState(settings.multiloginEndpoint);
  const [pushStatus, setPushStatus] = useState("Service worker registers automatically.");
  const [isPushBusy, setIsPushBusy] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");
  const saveSettings = useServerFn(saveSettingsFn);
  const savePushSubscription = useServerFn(savePushSubscriptionFn);
  const router = useRouter();

  async function runPushAction(action: "setup" | "test") {
    setIsPushBusy(true);
    try {
      const result =
        action === "setup" ? await setupPushNotifications() : await showTestNotification();
      if (result.status === "ready" && result.subscription) {
        await savePushSubscription({
          data: {
            endpoint: result.subscription.endpoint,
            subscription: result.subscription.toJSON() as Record<string, unknown>,
            userAgent: navigator.userAgent,
          },
        });
      }
      setPushStatus(result.message);
      setPush(result.status === "ready");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Push setup failed.");
    } finally {
      setIsPushBusy(false);
    }
  }

  async function persistSettings() {
    setSettingsStatus("");
    try {
      await saveSettings({
        data: {
          refreshSeconds: interval[0] ?? 10,
          soundAlerts: sound,
          pushAlerts: push,
          smsAlerts: sms,
          whatsappAlerts: whatsapp,
          telegramAlerts: telegram,
          discordAlerts: discord,
          autoRotateProxyOnRateLimit: settings.autoRotateProxyOnRateLimit,
          maintainStickyMobileIp: settings.maintainStickyMobileIp,
          multiloginEndpoint,
          multiloginStatePolicy: "save_profile_state_on_user_action",
        },
      });
      setSettingsStatus("Settings saved to Supabase.");
      await router.invalidate();
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : "Settings save failed.");
    }
  }

  return (
    <section className="panel space-y-4 p-4">
      <h2 className="font-display text-sm font-bold uppercase tracking-wide">
        Global Controls &amp; Settings
      </h2>

      <div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Global Refresh Interval</span>
          <span className="font-mono text-primary">{interval[0]}s</span>
        </div>
        <Slider
          className="mt-3"
          min={1}
          max={30}
          step={1}
          value={interval}
          onValueChange={setInterval}
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>1s</span>
          <span>30s</span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          Sound Alerts
          <Switch checked={sound} onCheckedChange={setSound} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          Desktop / Mobile Push
          <Switch checked={push} onCheckedChange={setPush} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          SMS Alerts
          <Switch checked={sms} onCheckedChange={setSms} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          WhatsApp Alerts
          <Switch checked={whatsapp} onCheckedChange={setWhatsapp} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          Telegram Alerts
          <Switch checked={telegram} onCheckedChange={setTelegram} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md bg-secondary/60 px-3 py-2.5 text-xs">
          Discord Alerts
          <Switch checked={discord} onCheckedChange={setDiscord} />
        </label>
      </div>

      <div className="space-y-2 rounded-md bg-secondary/60 px-3 py-3">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={isPushBusy}
            onClick={() => void runPushAction("setup")}
          >
            <BellRing className="h-3.5 w-3.5" />
            Enable Push
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={isPushBusy}
            onClick={() => void runPushAction("test")}
          >
            <Send className="h-3.5 w-3.5" />
            Test Notification
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{pushStatus}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="ml-port" className="text-xs text-muted-foreground">
          MultiLogin Local REST Endpoint
        </label>
        <Input
          id="ml-port"
          value={multiloginEndpoint}
          onChange={(event) => setMultiloginEndpoint(event.target.value)}
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          MultiLogin session policy: save profile restore metadata in Supabase; cookie export needs
          local MultiLogin bridge.
        </p>
      </div>

      <Button className="w-full" onClick={() => void persistSettings()}>
        Save Backend Settings
      </Button>
      {settingsStatus && <p className="text-xs text-muted-foreground">{settingsStatus}</p>}
    </section>
  );
}
