# HD-1 Drop Monitor

Create a modern, dark-mode, high-performance Progressive Web Application (PWA) central monitoring dashboard called "HD-1 Drop Monitor" designed for multi-platform event ticketing analytics and proxy/profile management.

Design Aesthetics & Theme:

- Sleek, dark-themed UI (Deep slate/charcoal background #0F172A, card surfaces #1E293B, glowing accent colors: Emerald Green #10B981 for active/online, Amber #F59E0B for warnings, Cyan #06B6D4 for primary actions, Rose #F43F5E for alerts).

- Highly responsive, mobile-first PWA layout with bottom navigation bar for mobile and a side rail navigation bar for desktop.

- Compact, data-dense cards with clean typography, sharp badge indicators, and fast loading states.

Core Sections & Layout Structure:

1. Top Header Bar:

- App Title: "HD-1 Drop Monitor | Multi-Site Ticket Monitor"

- Real-time Uptime Indicator: "System Active • 12 Targets Live" with a pulsing green dot.

- MultiLogin Connector Status Badge: "MultiLogin Sync: Connected (10 Profiles Active)"

- Quick Action Button: "+ Add New Target URL" (Primary Cyan CTA button).

2. Summary Analytics Bar (4 Top Cards):

- Card 1: Active Monitors (Value: 18 Live Streams | +2 Today)

- Card 2: Ticket Alerts Detected (Value: 142 Drops Today)

- Card 3: Connected Proxy Profiles (Value: 10 / 10 Isolated IPs Active)

- Card 4: Avg Response Time (Value: 142ms across targets)

3. Live Event Ticket Monitoring Grid (Main Feed):

Create a dynamic table/grid of target events being monitored across worldwide ticketing platforms.

Include filters at the top: [All Sites] [Ticketmaster UK/WW] [AXS] [SeeTickets] [Gigs & Tours] [Royal Albert Hall].

Each Row/Card should include:

- Platform Logo / Badge (e.g., Ticketmaster UK, AXS, SeeTickets)

- Event Name & Venue (e.g., "Coldplay - Wembley Stadium", "Oasis - Royal Albert Hall")

- Status Badge: "Tickets Available" (Green), "Monitoring" (Blue), "Captcha Challenge" (Amber), or "Rate Limited" (Red).

- Ticket Availability Metric: (e.g., "Section 102 • 4 Seats Detected", "General Admission In Stock")

- Target URL & Refresh Rate: (e.g., Refreshing every 3.5s)

- Profile/Proxy Assigned: Badge showing "Profile #04 (UK Residential Sticky IP)"

- Action Buttons: "Launch Session" (Primary CTA) | "Pause Monitor" | "View Logs".

4. MultiLogin & Proxy Profile Management Bar (Drawer/Tab):

A quick-view section for managing assigned profiles and fingerprint isolation:

- Table displaying 10 Active Profiles (Profile 01 through Profile 10).

- Columns: Profile Name, Assigned IP / Proxy Region (e.g., London Residential, Manchester Mobile 5G), Cookie Status ("100% Persisted"), Ticketmaster Session ("Authenticated"), Fingerprint Health Score ("Clean / No Leaks").

- Toggle Switches: "Auto-Rotate Proxy on Rate Limit" & "Maintain Sticky Mobile IP".

5. Real-Time Alert Log & Notification Drawer:

- A sliding side-drawer or bottom log showing real-time event drops:

  - Example Log: "19:42:01 - Ticketmaster UK: 2x Standing Tickets detected for Event ID #8841. Profile #02 notified."

  - Example Log: "19:40:15 - AXS: Queue opened for Event ID #9102. Auto-routing via Profile #07."

6. Global Controls & Settings Panel:

- Global Refresh Interval Slider (1s to 30s)

- Sound & Desktop/Mobile Push Notification Toggles

- API Key Settings for MultiLogin Local REST Port (e.g., http://localhost:35462)

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/b953ae68-395b-4028-bf8d-5ecda34f136d).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Production monitor scheduler

Persistent ticket checks run inside the Node/Docker server. Production must run exactly one
scheduler-enabled instance with these environment values:

```sh
EVENTPULSE_SCHEDULER_ENABLED=true
EVENTPULSE_SCHEDULER_TICK_MS=1000
EVENTPULSE_PUBLIC_URL=https://your-production-domain.example
MULTILOGIN_TOKEN_EXPIRY_WARNING_HOURS=72
```

The scheduler reloads Global Controls & Settings from Supabase on every pass. Increasing or
decreasing Global Refresh Interval therefore changes the next due check without restarting the
container. Every completed due check creates a full snapshot alert and sends it through each
enabled and configured delivery channel. Run only one scheduler-enabled replica to prevent
duplicate alerts; additional web replicas must set `EVENTPULSE_SCHEDULER_ENABLED=false`.

Telegram and Discord receive every alert that web push receives. Each Telegram chat and Discord
webhook has its own in-process queue that stays under the provider rate limits (Telegram groups:
20 messages/minute, Discord webhooks: about 30 messages/minute), waits for `retry_after` on HTTP 429,
and combines alerts that arrive while it waits into one message instead of dropping them. Use
**Test All Channels** in Global Controls & Settings to send one test alert through every enabled
channel and see per-channel results.

Captcha challenge pages remain visible as a target status but do not create alert-log entries or
send push, Telegram, Discord, SMS, or WhatsApp messages. This prevents challenge pages from
repeating a notification on every interval.

## Monitor health

`GET /api/eventpulse/health` always answers HTTP 200 with `ok: true` (it backs the Docker health
check, and a blocked ticket site must not restart the container). Its `monitor` field reports
whether ticket checks actually work:

- `ok`: an active target had a clean check within `EVENTPULSE_HEALTH_STALE_MINUTES` (default 30).
- `degraded`: active targets exist but none had a clean check in that window (blocked IP, launcher
  or proxy problem). The scheduler logs one "no successful ticket checks" notice, a reminder every
  6 hours, and one notice when checks recover.
- `idle`: no target is active (all paused or outside their monitoring window).
- `unknown`: Supabase did not answer.

Set `EVENTPULSE_OPS_WEBHOOK_URLS` (comma-separated Discord-compatible webhooks) to receive every
operational notice in an operator-only channel. Client ticket channels stay ticket-only.

## Linux launcher and Stealthfox quick profiles

The production launcher container (`mlx-launcher`) only runs Stealthfox (Firefox). The approved
client profiles are Mimic (Chromium), so that launcher refuses to open them
(`browser mimic is not supported in this deployment`). When the launcher reports this, the monitor
switches automatically to temporary Stealthfox quick profiles: each check starts a throwaway
profile, reads the page over WebDriver BiDi, and stops it. The approved profiles, their cookies and
their sticky proxies are never opened or changed. Without a scraper proxy pool these checks use the
launcher host's own connection, so the per-profile safety interval still applies.

`MULTILOGIN_QUICK_BROWSER` selects the quick-profile engine: `stealthfox` (default) or `mimic`
(only on a desktop Multilogin agent).

## Rotating scraper proxies

Set `MULTILOGIN_SCRAPER_PROXIES` to a JSON array of server-side proxy URLs to use a different
temporary Multilogin quick profile for each target check:

```sh
MULTILOGIN_SCRAPER_PROXIES=["http://user:password@host1:8000","socks5://user:password@host2:1080"]
```

Entries may be `scheme://user:pass@host:port` (`http`, `https`, `socks5`, `socks5h`), `user:pass@host:port`, `host:port:user:pass` (common provider export) or `host:port`. Passwords may contain `@ # / ?` unescaped. The value can be a JSON array or a plain comma/new-line separated list. The pool rotates sequentially and wraps to the first proxy
after the last. Each quick profile is stopped and deleted after its check. Existing approved
Multilogin profiles, cookies, and sticky proxy assignments are not edited. Leave the value as `[]`
to keep using the assigned regular profiles. Store this value only in the deployment secret manager;
never commit real proxy credentials.

`/api/eventpulse/health` reports token state without exposing the credential. Finite tokens trigger
one warning per 24 hours through enabled notification channels after entering the configured warning
window. Multilogin may include a provider-managed technical JWT expiry even when `no_exp` is
requested, so deployment must follow the expiry reported by this health endpoint. Changing the
master account password also invalidates active automation tokens.

The token authenticates the Multilogin workspace; it does not run browser profiles by itself. A
remote production host must also run a reachable Multilogin launcher, either through Multilogin's
supported launcher container or a securely connected machine running the desktop launcher. Keep the
application and launcher together on a private Docker network where possible.

For a headless production launcher, configure `MULTILOGIN_LAUNCHER_ENDPOINT` with its private
network URL, set `MULTILOGIN_CDP_HOST` to the launcher host, and set
`MULTILOGIN_HEADLESS=true`. Local desktop development can leave the endpoint override empty and use
`MULTILOGIN_HEADLESS=false`.
