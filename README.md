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

## Suggestions

The Suggestions tab is where the plan gets argued with. Anyone can post a
suggestion against a city or topic, reply to one, and vote. Shashank holds an
admin key; approving a suggestion pins it to an **Agreed changes** block at the
top of the Overview and Day-by-day tabs, so the plan and the argument about it
stay in one place.

The key is a Worker secret, not in this repo. To change it:

    cd worker && npx wrangler secret put ADMIN_KEY

Anyone who has the page URL can post and reply — there is no login. Authors must
be one of the six named travellers and text is length-capped, but treat the board
as unlisted rather than private. Only the admin key can approve, turn down or
delete.

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
