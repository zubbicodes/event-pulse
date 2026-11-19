import { Boxes, Bell, SlidersHorizontal, Radar } from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { id: "monitors", label: "Monitors", icon: Radar },
  { id: "profiles", label: "Profiles", icon: Boxes },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
] as const;

export type NavId = (typeof NAV_ITEMS)[number]["id"];

export function SideRail({ active, onSelect }: { active: NavId; onSelect: (id: NavId) => void }) {
  return (
    <nav className="hidden w-20 shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar py-4 lg:flex">
      <img
        src="/icon.svg"
        alt="HD-1 Drop Monitor"
        width={40}
        height={40}
        className="mb-4 h-10 w-10 rounded-lg ring-1 ring-primary/30"
      />
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          className={cn(
            "flex w-16 flex-col items-center gap-1 rounded-lg py-2.5 text-[10px] font-medium transition-colors",
            active === item.id
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <item.icon className="h-5 w-5" />
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export function BottomNav({ active, onSelect }: { active: NavId; onSelect: (id: NavId) => void }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          className={cn(
            "flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
            active === item.id ? "text-primary" : "text-muted-foreground",
          )}
        >
          <item.icon className="h-5 w-5" />
          {item.label}
        </button>
      ))}
    </nav>
  );
}
