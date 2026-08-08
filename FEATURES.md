# Europe 2026 — feature backlog

Written 8 August 2026, against the deployed app: `index.html` on GitHub Pages plus
a Cloudflare Worker on D1. Four items are now built and are marked **done**.

Everything here is costed against the **free tier** you are on: Workers 100,000
requests/day, 10ms CPU per invocation, 5 Cron Triggers, 50 subrequests; D1 500 MB
per database. At roughly three hours of use each per day across seven people you
are using about 8% of the request budget, so nothing below is blocked by quota.

Effort is rough calendar time for one person who knows the codebase. "Rides the
poll" means the feature needs no new client plumbing because `fullState()` already
ships everything on the existing ten-second poll.

---

## Done in this pass

| Feature | Why it mattered |
|---|---|
| **Group-passphrase write auth** | `/expenses/del` and `/bookings/del` took an id and no credentials, and the Worker URL is in public HTML. Anyone could have wiped the vault with one curl. |
| **Live ECB rates, daily cron** | Settle-up ran on constants baked into the page. Forint and koruna drift enough over eight weeks to matter when dividing a tab seven ways. |
| **Check-ins — "where is everyone"** | The door advice splits you 2+2+3 and the plan assumes phones die at 04:00. |
| **Daily digest of who is behind** | Nothing pushed. The only way to learn you were three documents short was to open the page and press Nudge. |

---

## Tier 1 — worth doing before 18 August

### 1. Web Push, so the digest actually reaches phones
**Effort:** 2–3 evenings. **Cost:** free. **Rides the poll:** no.

The digest exists and is emailed if you set a provider key, but email is easy to
ignore. Web Push reaches the lock screen. It works on Android in Chrome, and on
iPhone **only if each person adds the page to their Home Screen** — iOS has no
web push for a plain Safari tab. The Worker would need VAPID ES256 signing and
aes128gcm payload encryption, both doable with Web Crypto but the fiddliest thing
on this list. Your service worker already exists, which is half the work.

**Do it if** you want the 18 August deadline to chase people rather than the
reverse. **Skip it if** email plus the WhatsApp nudges are landing.

### 2. Per-person deadline nudges rather than one group digest
**Effort:** half an evening once email works. **Cost:** free.

Right now the digest is one message about everybody. A per-person email that says
only *your* four outstanding items converts far better than a leaderboard. The
manifest already gives the Worker everything it needs.

### 3. Passphrase rotation
**Effort:** an hour. **Cost:** free.

One shared secret with no way to change it except a redeploy is fine for seven
friends, less fine if a phone is lost in Budapest. Support two valid keys at once
so you can rotate without locking anyone out mid-trip.

---

## Tier 2 — before departure

### 4. Live train status for the three legs
**Effort:** 1 evening for deep links, 2–3 days for a real integration.
**Cost:** free for links; DB's API needs a key and has quotas.

The Hannover–Berlin closure is the known risk in the itinerary and it starts the
day you land. The cheap version is a "check this leg now" button per leg, deep
linking to bahn.de, MÁV and RegioJet live departures with the date and stations
pre-filled. The expensive version polls an API and shows delays in-app. **The
cheap version captures most of the value** — you need this three times, not
continuously.

### 5. Offline PDF pack
**Effort:** 1 evening. **Cost:** free.

One button that prints the Emergency tab, the Adults-only scam rules, the visa
cover-letter reasoning and each day's plan to a single PDF. The service worker
already caches the page, but a PDF on the phone survives a dead battery on someone
else's phone, and border officers ask for paper.

### 6. Booking-reference reminders keyed to dates
**Effort:** half a day. **Cost:** free, reuses the cron.

The vault holds refs but nothing watches the clock. RegioJet is refundable to 15
minutes before; Anne Frank tickets drop Tuesdays at 10:00 CET; the Sparty sells
out. A cron that says "this is the last Tuesday you can get Anne Frank tickets for
your dates" is more useful than a checklist item.

### 7. Split the payload
**Effort:** half a day. **Cost:** free, and reduces load.

`fullState()` returns every post, comment, vote, 500 expenses and 200 bookings on
every change. It is fine today and it is the thing that will stop being fine
first. Give the feed its own endpoint with a separate rev before adding anything
high-volume.

---

## Tier 3 — on the trip

### 8. Shared photo album
**Effort:** 2–3 days. **Cost:** free within R2's 10 GB.

The thing you will actually want in November. R2 with presigned uploads, thumbnails
generated client-side before upload to keep egress sane. Do **not** put this in
`fullState()` — separate endpoint, paginated.

### 9. Live spend-vs-budget
**Effort:** 1 day. **Cost:** free.

The Money tab has a planned budget per category and the Spend tab has actuals.
Nothing compares them. A single bar per category — planned, spent, remaining —
answers "can we afford the good dinner in Prague" on day nine.

### 10. Offline city maps
**Effort:** don't. **Cost:** n/a.

Real vector tiles in a single static file is not a sane project. The honest answer
is a checklist item telling each person to download the four cities as Google Maps
offline areas before they fly, which works better than anything you would build.

### 11. Night-transport "get me home"
**Effort:** 1 day. **Cost:** free.

Given a city and the time, show the one thing that matters: in Prague, get to
Lazarská; in Budapest, tram 6 runs all night; in Berlin on Mon–Wed the rail stops
at 01:00 so it is night buses. This is already written in prose across three tabs —
surfacing it as one answer at 03:00 is the feature.

---

## Deliberately not doing

**Passport and visa scans in the vault.** Wrong place for them. Public origin, one
shared passphrase, no per-user auth, and the payoff is small — a photo in each
person's own phone does the same job with none of the exposure.

**Per-person logins.** Seven friends do not need an identity system, and every
option adds a dependency and a failure mode at a club door at 02:00. The shared
passphrase is the right size of solution.

**Real-time location sharing.** Check-ins are one tap and deliberately coarse.
Continuous location means background permissions, battery drain and a privacy
conversation, to replace something that already works.

**Currency conversion at spend time.** Already handled: amounts are stored in the
original currency *and* in euro cents, so historical expenses do not silently
re-price when rates move. Worth knowing so nobody "fixes" it.

---

## Order I would actually do them in

1. Deploy what is built and set `GROUP_KEY` — the security hole is live until you do
2. Wire the digest to email — the deadline is inside two weeks
3. Live train status, cheap version — the disruption is real and dated
4. Offline PDF pack — the trip is the deadline
5. Everything else, if there is time
