# HD-1 Drop Monitor Handoff

This file compares the client notes in `HD1dropmonitor.docx` with the current app changes.

## What The Client Asked For

The client confirmed that HD-1 Drop Monitor is the name of the impulse tracker project.

They need a flexible ticket monitoring system where they can:

- Add an event URL at any time.
- Track events that may happen soon or later.
- Start and stop monitoring for a chosen time window.
- Filter by ticket section or area.
- Filter by ticket quantity.
- Filter by price.
- Get alerts on phone.
- Open the ticket page quickly from the alert.
- Use MultiLogin profiles with sticky residential IPs.
- Avoid disrupting real accounts and real profile data.

## What Has Been Done

### 1. Project Name Updated

The visible app name has been changed from `EventPulse` to `HD-1 Drop Monitor`.

This was updated in:

- Main dashboard header.
- Browser page title and social metadata.
- PWA install manifest.
- Push notification titles.
- README project heading.

Internal file and function names still use `eventpulse` in some places. These were left alone on purpose because changing internal names is not needed for the client-facing request and could add unnecessary production risk.

### 2. Client Document Ignored By Git

`HD1dropmonitor.docx` has been added to `.gitignore`.

This keeps the client document out of Git and avoids committing private notes, links, phone numbers, and account context.

### 3. Flexible Event Target Setup Added

The target form now supports the filters described in the client document:

- Event URL.
- Platform.
- Event name.
- Venue.
- Section filters, for example `Arena A, Arena F`.
- Minimum ticket quantity.
- Maximum price.
- Normal tickets only.
- Even ticket quantities only.
- Start monitoring time.
- Stop monitoring time.
- Assigned MultiLogin profile.
- Assigned proxy or sticky IP label.

This covers examples such as:

- First Aid Kit: Arena A or Arena F only, even ticket quantities only.
- Dylan Gossett: General Access / Standing, any ticket quantity.

### 4. Monitoring Time Windows Added

The backend monitor now checks whether a target is inside its monitoring window.

If a target has a future start time, it will not be checked yet.

If a target has passed its stop time, it will no longer be checked.

This supports the client request to monitor something only for a short period, such as 5 hours.

### 5. Sticky IP Behavior Made Safer By Default

The default proxy behavior was changed to match the client note.

Sticky IP is now the default.

Automatic proxy rotation is now off by default.

This is safer for ticket sites because rotating IPs can lose sessions or cause the site to treat the browser as suspicious.

### 6. Multi-Phone Alert Support Added

The Twilio alert settings now support multiple recipients.

Phone numbers can be added as comma-separated values in environment variables.

Example:

```env
TWILIO_SMS_TO=+447000000000,+447000000001
TWILIO_WHATSAPP_TO=whatsapp:+447000000000,whatsapp:+447000000001
```

The real client phone numbers were not committed into code.

### 7. Safer Ticket Link Wording

The button text was changed from `Launch Deep Link` to `Open Ticket Page`.

This is intentional.

The client asked for alerts to open with tickets already in the basket, but the current app does not have safe site-specific checkout automation for that yet.

Using wording that promises basketed tickets would be misleading and could create production risk.

## What Was Not Done Yet

### 1. Automatic Basket / Checkout Flow

The app does not yet place tickets into the basket automatically.

This needs site-specific work for Ticketmaster, See Tickets, Gigs and Tours, AXS, and any other ticket site.

This should not be guessed or handled with generic URL parameters because ticketing sites can change quickly and checkout sessions are fragile.

Before building this, the client must confirm exactly how far automation should go:

- Open page only.
- Select ticket quantity.
- Add tickets to basket.
- Stop at basket and alert the broker.
- Continue further into checkout.

### 2. Real MultiLogin Credentials

The client said they have created MultiLogin and added 5 profiles.

The app still needs real MultiLogin access details before live profile launch can be tested.

Needed from client:

- MultiLogin version.
- Local REST endpoint, if different from `http://localhost:35462`.
- API token, if required.
- Profile IDs.
- Folder IDs, if using MultiLogin X.
- Confirmation that each profile is logged into the needed ticket sites.
- Confirmation that each profile has its sticky residential IP configured.

### 3. Real Alert Provider Details

The app supports web push and Twilio SMS / WhatsApp, but production delivery needs real credentials.

Needed from client:

- Preferred alert channel: push, SMS, WhatsApp, or a combination.
- Final phone numbers for alerts.
- Twilio Account SID.
- Twilio Auth Token.
- Twilio SMS sender number.
- Twilio WhatsApp sender number, if WhatsApp is required.
- Confirmation that test alerts are received on the client's phones.

### 4. Final Event List

The document includes two Ticketmaster examples, but the client also said the market changes often.

Needed from client for each live event:

- Event URL.
- Event name.
- Platform name.
- Section or area filters.
- Minimum ticket count.
- Whether only even quantities should alert.
- Maximum price.
- Whether VIP, platinum, premium, or resale tickets should be ignored.
- Start monitoring time.
- Stop monitoring time.
- Assigned MultiLogin profile, if specific.

### 5. Ticket Site Rules Need Final Confirmation

The current monitor has basic keyword-based checking.

Production-grade detection still needs reliable per-site logic.

Needed from client:

- Which sites must be supported first.
- Whether Ticketmaster UK is highest priority.
- Whether See Tickets and Gigs and Tours need basket support immediately.
- Whether AXS is for drop tickets, general sale tickets, or both.

### 6. AXS Information

The client asked about AXS IP information for real on-sale events.

No AXS-specific IP strategy has been added in code.

This needs separate research and operational confirmation before implementation.

Needed from client:

- Whether AXS support is in scope now.
- Whether AXS is needed for monitoring only or purchase flow too.
- Broker guidance on acceptable IP/proxy setup for AXS.

### 7. Production Domain

The client provided:

```text
http://hd1dropmonitor.com
```

Needed from client:

- Confirm this is the final production domain.
- Confirm who controls DNS.
- Confirm whether Cloudflare is being used.
- Confirm SSL is active and stable.
- Confirm final production Supabase URL and service role key.

### 8. Local Bridge For Production MultiLogin Use

MultiLogin runs locally on the user's computer.

The production website cannot directly control a browser profile on the client's machine unless there is a local bridge/helper running on that same machine.

Needed from client:

- Confirm which machine will run MultiLogin.
- Confirm whether a local helper app is acceptable.
- Confirm who will keep that helper running during monitoring.

## Current Safe Status

The app has been updated for the client-facing requirements that can be safely supported now:

- Correct project name.
- Flexible target setup.
- Start and stop monitoring windows.
- Section, price, quantity, and even-quantity filters.
- Sticky IP default behavior.
- Multi-recipient alerts.

The higher-risk parts have been left for client confirmation:

- Basket automation.
- Real MultiLogin credentials.
- Real phone alert credentials.
- Final event list.
- Final domain / DNS / SSL setup.
- Site-specific Ticketmaster, AXS, See Tickets, and Gigs and Tours automation rules.

## Checks Completed

After the code changes:

- TypeScript check passed.
- Targeted ESLint check passed on changed source files.
- Production build passed.

Full repo lint still has existing Prettier / CRLF noise across many untouched files. That was not fixed because it is unrelated to the client note and could create a large unnecessary diff.
