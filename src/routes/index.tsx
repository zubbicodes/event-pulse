import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/eventpulse/Header";
import { SideRail, BottomNav, type NavId } from "@/components/eventpulse/Nav";
import { SummaryBar } from "@/components/eventpulse/SummaryBar";
import { MonitorGrid } from "@/components/eventpulse/MonitorGrid";
import { ProfilePanel } from "@/components/eventpulse/ProfilePanel";
import { AlertLog } from "@/components/eventpulse/AlertLog";
import { SettingsPanel } from "@/components/eventpulse/SettingsPanel";
import { getDashboardDataFn } from "@/lib/eventpulse/server-fns";

export const Route = createFileRoute("/")({
  loader: async () => ({
    dashboard: await getDashboardDataFn(),
  }),
  head: () => ({
    meta: [
      { title: "HD-1 Drop Monitor | Multi-Site Ticket Monitor Dashboard" },
      {
        name: "description",
        content:
          "Real-time ticketing analytics across Ticketmaster, AXS and SeeTickets with MultiLogin proxy profile management.",
      },
      { property: "og:title", content: "HD-1 Drop Monitor | Multi-Site Ticket Monitor" },
      {
        property: "og:description",
        content:
          "Monitor worldwide ticket drops, proxy profiles and fingerprint health from one dark-mode command center.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [tab, setTab] = useState<NavId>("monitors");
  const [targetFormSignal, setTargetFormSignal] = useState(0);
  const { dashboard } = Route.useLoaderData();
  const sectionRefs = {
    monitors: useRef<HTMLDivElement>(null),
    profiles: useRef<HTMLDivElement>(null),
    alerts: useRef<HTMLDivElement>(null),
    settings: useRef<HTMLDivElement>(null),
  };

  function selectTab(nextTab: NavId) {
    setTab(nextTab);
    sectionRefs[nextTab].current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function openTargetForm() {
    setTab("monitors");
    setTargetFormSignal((value) => value + 1);
    sectionRefs.monitors.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <SideRail active={tab} onSelect={selectTab} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          activeTargets={dashboard.stats.activeMonitors}
          activeProfiles={dashboard.stats.connectedProfiles}
          backendConnected={dashboard.backendConnected}
          backendMessage={dashboard.backendMessage}
          onAddTarget={openTargetForm}
        />

        <main className="flex-1 space-y-5 px-4 pb-24 pt-4 lg:px-6 lg:pb-8">
          <SummaryBar stats={dashboard.stats} />

          {/* Mobile: one section at a time via bottom nav */}
          <div className="space-y-5 lg:hidden">
            {tab === "monitors" && (
              <MonitorGrid
                targets={dashboard.targets}
                profiles={dashboard.profiles}
                openFormSignal={targetFormSignal}
              />
            )}
            {tab === "profiles" && (
              <ProfilePanel profiles={dashboard.profiles} settings={dashboard.settings} />
            )}
            {tab === "alerts" && <AlertLog alerts={dashboard.alerts} className="max-h-[70vh]" />}
            {tab === "settings" && <SettingsPanel settings={dashboard.settings} />}
          </div>

          {/* Desktop: full command center */}
          <div className="hidden gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-5">
              <div ref={sectionRefs.monitors}>
                <MonitorGrid
                  targets={dashboard.targets}
                  profiles={dashboard.profiles}
                  openFormSignal={targetFormSignal}
                />
              </div>
              <div ref={sectionRefs.profiles}>
                <ProfilePanel profiles={dashboard.profiles} settings={dashboard.settings} />
              </div>
            </div>
            <aside className="space-y-5">
              <div ref={sectionRefs.alerts}>
                <AlertLog alerts={dashboard.alerts} className="max-h-[420px]" />
              </div>
              <div ref={sectionRefs.settings}>
                <SettingsPanel settings={dashboard.settings} />
              </div>
            </aside>
          </div>
        </main>
      </div>

      <BottomNav active={tab} onSelect={selectTab} />
    </div>
  );
}
