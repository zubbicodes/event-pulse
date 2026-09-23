import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISSED_KEY = "eventpulse_pwa_install_prompt_dismissed";

function isStandalone() {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

export function PwaInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isHidden, setIsHidden] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined" || isStandalone()) return;

    const dismissed = window.localStorage.getItem(DISMISSED_KEY) === "true";
    if (dismissed) return;

    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setIsHidden(false);
    }

    function handleInstalled() {
      setInstallPrompt(null);
      setIsHidden(true);
      window.localStorage.setItem(DISMISSED_KEY, "true");
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;

    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      window.localStorage.setItem(DISMISSED_KEY, "true");
      setIsHidden(true);
      setInstallPrompt(null);
    }
  }

  function dismissPrompt() {
    window.localStorage.setItem(DISMISSED_KEY, "true");
    setIsHidden(true);
  }

  if (isHidden || !installPrompt) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-lg border border-border bg-background p-4 shadow-2xl ring-1 ring-white/10 lg:bottom-5">
      <button
        type="button"
        aria-label="Dismiss install prompt"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        onClick={dismissPrompt}
      >
        <X className="h-4 w-4" />
      </button>
      <div className="pr-8">
        <p className="font-display text-sm font-semibold">Install HD-1 Drop Monitor</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Add the dashboard to this device for faster access and app-style launch.
        </p>
      </div>
      <Button className="mt-3 w-full" size="sm" onClick={() => void installApp()}>
        <Download className="h-4 w-4" />
        Install app
      </Button>
    </div>
  );
}
