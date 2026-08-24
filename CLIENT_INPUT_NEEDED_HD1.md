# HD-1 Drop Monitor: Client Input Needed

This document lists what is still left and what must come from the client before the system can be completed safely.

## 1. Final Event List

The client needs to provide the live events they want monitored.

For each event, we need:

- Event URL.
- Event name.
- Ticket platform, for example Ticketmaster, AXS, See Tickets, or Gigs and Tours.
- Venue.
- Sections or areas to watch, for example Arena A, Arena F, Standing, or General Access.
- Minimum ticket quantity.
- Whether only even quantities should alert.
- Maximum ticket price.
- Whether VIP, platinum, premium, resale, or package tickets should be ignored.
- Start monitoring date and time.
- Stop monitoring date and time.
- Assigned MultiLogin profile, if a specific one should be used.

## 2. Alert Recipients

The client needs to confirm who should receive alerts.

Needed:

- Final phone numbers for alerts.
- Whether alerts should go to one person or multiple people.
- Whether alerts should use mobile push, SMS, WhatsApp, or a combination.
- Confirmation that the alert should include event name, section, quantity, price, platform, and ticket page link.

## 3. Twilio Or Alert Provider Access

If SMS or WhatsApp alerts are required, the client must provide sending-provider credentials.

If using Twilio, needed:

- Twilio Account SID.
- Twilio Auth Token.
- SMS sender number.
- WhatsApp sender number, if WhatsApp is required.
- Receiver phone numbers.

If not using Twilio, needed:

- Provider name.
- API credentials.
- Sender setup details.

## 4. MultiLogin Access

The client said they already created MultiLogin and added 5 profiles.

Needed:

- MultiLogin version being used.
- Whether this is MultiLogin X or older MultiLogin.
- Local REST endpoint, if different from `http://localhost:35462`.
- API token, if required.
- Profile IDs.
- Folder IDs, if using MultiLogin X.
- Confirmation that each profile is logged into Ticketmaster, See Tickets, and Gigs and Tours.
- Confirmation that each profile has its own sticky residential IP.
- Which profile should be assigned to which event, if any.

## 5. Basket Automation Decision

The client asked for alerts to open with tickets already in the basket.

This is not finished yet because it is high risk and site-specific.

Client must confirm how far automation should go:

- Open the ticket page only.
- Select ticket quantity.
- Add tickets to basket.
- Stop once tickets are in basket.
- Continue into checkout.

Client also needs to confirm whether this should be built first for:

- Ticketmaster.
- See Tickets.
- Gigs and Tours.
- AXS.

## 6. Ticket Site Priority

The current system is ready for flexible target setup, but production-grade detection still needs site-specific rules.

Client needs to confirm priority order:

- Ticketmaster UK.
- See Tickets.
- Gigs and Tours.
- AXS.
- Any other platform.

For each platform, client should confirm whether the goal is:

- Monitor only.
- Monitor and alert.
- Add to basket.
- Purchase flow support.

## 7. AXS Scope

The client asked about AXS IPs for real on-sale events.

Needed:

- Whether AXS support is required now.
- Whether AXS is for general sale, drop tickets, or both.
- Whether AXS needs monitoring only or checkout/basket support.
- Any broker guidance on suitable IP/proxy setup for AXS.

## 8. Domain And Hosting

The client provided:

```text
http://hd1dropmonitor.com
```

Needed:

- Confirm this is the final production domain.
- Confirm who controls DNS.
- Confirm whether Cloudflare is used.
- Confirm SSL is active.
- Confirm whether the app should force HTTPS.
- Confirm final production Supabase URL.

## 9. Local MultiLogin Bridge

MultiLogin runs locally on the client's computer.

The production website cannot directly control local MultiLogin profiles unless a local helper/bridge is running on the same machine.

Needed:

- Which computer will run MultiLogin.
- Whether a local bridge/helper app is approved.
- Whether that machine will stay online during monitoring.
- Who will start and maintain the bridge.

## 10. Testing Approval

Before launch, client needs to approve:

- Test event target.
- Test alert format.
- Test phone recipients.
- Test MultiLogin profile launch.
- Test sticky IP behavior.
- Test ticket page open flow.
- Any basket automation flow, if built.

## Summary

The main items still needed from the client are:

- Final event URLs and filters.
- Alert phone numbers and preferred alert channels.
- Twilio or other alert-provider credentials.
- MultiLogin profile IDs, folder IDs, and access details.
- Confirmation of how far basket automation should go.
- Ticket site priority order.
- AXS scope.
- Final domain, DNS, SSL, and production Supabase details.
- Approval for local MultiLogin bridge.
- Final launch testing approval.
