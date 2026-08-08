# Europe 2026

Itinerary, budget, nightlife and visa plan for the group.
Amsterdam · Berlin · Budapest · Prague, 2–13 October 2026.

`index.html` is the whole site — one self-contained file, no build step and no
dependencies. Edit it and push, and GitHub Pages redeploys within a minute.

## The tracker

The Tracker tab holds a per-person checklist for every traveller, plus the
group bookings and who owns each one. It syncs automatically: tick a box and it
reaches everyone else within about ten seconds.

Phone numbers saved for the WhatsApp nudge buttons stay in the browser that
entered them. They are never sent to the server, written into this file, or put
in a sync link.

## The roster

Travellers live in the `members` table, not in the code. **Add traveller** on the
Tracker tab adds someone live; everyone else's page picks them up within ten
seconds and they get a column in the tracker, the packing list, the split picker
and the owner dropdowns.

Member **ids are permanent and never reused**. Every checkbox key, expense split
and booking owner refers to an id, not to a position in the list, so adding or
removing someone can never silently reassign somebody else's ticks. Removing a
traveller needs the admin key and deletes their ticks and votes with them.

## Suggestions

The Suggestions tab is where the plan gets argued with. Anyone can post a
suggestion against a city or topic, reply to one, and vote. Shashank holds an
admin key; approving a suggestion pins it to an **Agreed changes** block at the
top of the Overview and Day-by-day tabs, so the plan and the argument about it
stay in one place.

The key is a Worker secret, not in this repo. To change it:

    cd worker && npx wrangler secret put ADMIN_KEY

Anyone who has the page URL can post and reply — there is no login. Authors must
be one of the named travellers and text is length-capped, but treat the board
as unlisted rather than private. Only the admin key can approve, turn down or
delete.

### How the sync works

`worker/` is a Cloudflare Worker backed by a D1 database, deployed separately
from this site:

    cd worker && npx wrangler deploy

- `GET  /state?rev=N` — everything: `{rev, doc, feed, spend, vault, members, rates, here}`, or `{rev, unchanged:true}`
- `GET  /health` — `{ok, rev, moderation, writeAuth, email, rates}`
- `GET  /digest` — the most recent daily digest
- `POST /ops` — `{ops:[{k,v}]}`, applies them and returns the new state
- `POST /checkin` — `{member, city, place, note}`, one row per traveller
- `POST /manifest` — the page posts its own checklist ids so the digest cannot drift

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

## Writes need the group passphrase

This site is public, so the Worker URL is in the page source. Until `GROUP_KEY` is
set the Worker accepts writes from anyone who finds it — including
`/expenses/del` and `/bookings/del`, which take an id and no credentials. Set it:

    cd worker && npx wrangler secret put GROUP_KEY

Then each person enters the passphrase once, on the Tracker tab, and it is kept in
that browser. **Reading never needs it — only saving does.** The admin key also
satisfies the gate, so whoever holds `ADMIN_KEY` does not need both.

Confirm it took effect: `curl .../health` should report `"writeAuth": true`.

## Exchange rates

The settle-up in the Spend tab used to run on constants compiled into the page.
A Cron Trigger now pulls ECB reference rates once a day via Frankfurter and the
page shows which set it is using, with the as-of date. A failed or partial fetch
leaves the last good rates in place rather than writing half a set, so the
settlement never mixes two days' rates.

## The daily digest

The same cron rebuilds a plain-text digest of who is behind, and stores it at
`GET /digest` whether or not email is configured. To have it emailed:

    cd worker && npx wrangler secret put RESEND_KEY
    cd worker && npx wrangler secret put DIGEST_TO      # comma-separated
    cd worker && npx wrangler secret put DIGEST_FROM    # optional

The Worker does not hard-code the checklist — the page posts its item ids to
`/manifest` on load, so the digest always measures against whatever the page
currently lists rather than a copy that drifts.

## Deploying

    cd worker && npx wrangler deploy      # Worker, D1 schema and the cron
    git push                              # the site, via GitHub Pages

New D1 tables are created by `ensureSchema` on first request, so there is no
migration step. Deploying with no new secrets set is safe: write auth stays off
and the rates table falls back to the values the page shipped with.

## Deadline

The Netherlands' Schengen guidance is to lodge no later than 45 days before
travel, which for a 2 October departure is **18 August 2026**. The tracker targets
the **17th** deliberately, to keep a day in hand.
