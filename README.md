# Europe 2026

Itinerary, budget, nightlife and visa plan for six travellers.
Amsterdam · Berlin · Budapest · Prague, 1–13 October 2026.

`index.html` is the whole site — one self-contained file, no build step and no
dependencies. Edit it and push, and GitHub Pages redeploys within a minute.

## The tracker

The Tracker tab holds a per-person checklist for all six travellers, plus the
group bookings and who owns each one. It syncs automatically: tick a box and it
reaches everyone else within about ten seconds.

Phone numbers saved for the WhatsApp nudge buttons stay in the browser that
entered them. They are never sent to the server, written into this file, or put
in a sync link.

### How the sync works

`worker/` is a Cloudflare Worker backed by a D1 database, deployed separately
from this site:

    cd worker && npx wrangler deploy

- `GET  /state?rev=N` — returns `{rev, doc}`, or `{rev, unchanged:true}`
- `POST /ops` — `{ops:[{k,v}]}`, applies them and returns the new state

Each checkbox is **one row**, not part of one shared blob. Two people ticking
different boxes at the same moment therefore touch different rows and cannot
overwrite each other; the same box twice is last-tap-wins. Only the origins
listed in `worker/src/index.js` may call it.

The page keeps working with no signal — ticks apply immediately, queue in
localStorage, and flush when the connection returns. The pill by the "I am"
dropdown always says which state you are in. If the backend is ever unreachable,
**Copy sync link** still works as a manual fallback.

Note that **Reset wipes the tracker for everyone**, not just the device that
presses it.

## Deadline

The Netherlands' Schengen guidance is to lodge 45 days before travel, which for a
1 October departure is **17 August 2026**.
