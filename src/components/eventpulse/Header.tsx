import { Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Header({
  activeTargets,
  activeProfiles,
  backendConnected,
  backendMessage,
  onAddTarget,
}: {
  activeTargets: number;
  activeProfiles: number;
  backendConnected: boolean;
  backendMessage: string;
  onAddTarget: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 lg:flex lg:flex-wrap lg:justify-between lg:px-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-base font-bold tracking-tight sm:text-lg">
            HD-1 Drop Monitor{" "}
            <span className="text-muted-foreground">| Multi-Site Ticket Monitor</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full ${
                    backendConnected ? "bg-online" : "bg-warn"
                  } opacity-75`}
                />
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${
                    backendConnected ? "bg-online" : "bg-warn"
                  }`}
                />
              </span>
              {backendMessage} • {activeTargets} Targets Live
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-online/10 px-2 py-0.5 font-mono text-[11px] text-online ring-1 ring-online/25">
              <ShieldCheck className="h-3 w-3" />
              MultiLogin Sync: State Policy Ready ({activeProfiles} Profiles Active)
            </span>
          </div>
        </div>
        <Button size="sm" className="shrink-0 font-semibold" onClick={onAddTarget}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Add New Target URL</span>
          <span className="sm:hidden">Target</span>
        </Button>
      </div>
    </header>
  );
}
