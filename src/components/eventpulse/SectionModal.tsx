import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertLog } from "@/components/eventpulse/AlertLog";
import { MonitorGrid } from "@/components/eventpulse/MonitorGrid";
import { ProfilePanel } from "@/components/eventpulse/ProfilePanel";
import { SettingsPanel } from "@/components/eventpulse/SettingsPanel";
import { NAV_ITEMS, type NavId } from "@/components/eventpulse/Nav";
import type {
  BackendAlertLog,
  BackendMonitorTarget,
  BackendProfileRow,
  BackendSettings,
} from "@/lib/eventpulse/types";

const MODAL_COPY: Record<NavId, { title: string; description: string }> = {
  monitors: {
    title: "Monitors",
    description: "Manage target events, filters, timing windows, and monitoring state.",
  },
  profiles: {
    title: "Profiles",
    description: "Review MultiLogin profiles, sticky IP labels, session state, and proxy controls.",
  },
  alerts: {
    title: "Alerts",
    description: "Inspect the latest HD-1 Drop Monitor alert history.",
  },
  settings: {
    title: "Settings",
    description: "Adjust refresh timing, alert channels, push notifications, and backend settings.",
  },
};

export function SectionModal({
  active,
  alerts,
  onOpenChange,
  open,
  profiles,
  settings,
  targetFormSignal,
  targets,
}: {
  active: NavId;
  alerts: BackendAlertLog[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  profiles: BackendProfileRow[];
  settings: BackendSettings;
  targetFormSignal: number;
  targets: BackendMonitorTarget[];
}) {
  const activeItem = NAV_ITEMS.find((item) => item.id === active);
  const copy = MODAL_COPY[active];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:rounded-lg">
        <DialogHeader className="border-b border-border px-4 py-4 text-left sm:px-5">
          <DialogTitle className="flex items-center gap-2 font-display text-base">
            {activeItem && <activeItem.icon className="h-4 w-4 text-primary" />}
            {copy.title}
          </DialogTitle>
          <DialogDescription className="max-w-3xl text-xs leading-relaxed">
            {copy.description}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {active === "monitors" && (
            <MonitorGrid
              targets={targets}
              profiles={profiles}
              openFormSignal={targetFormSignal}
            />
          )}
          {active === "profiles" && <ProfilePanel profiles={profiles} settings={settings} />}
          {active === "alerts" && <AlertLog alerts={alerts} className="max-h-[70vh]" />}
          {active === "settings" && <SettingsPanel settings={settings} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
