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
