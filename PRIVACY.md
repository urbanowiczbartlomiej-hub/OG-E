# Privacy

OG-E runs no servers of its own and collects no telemetry. Everything
stays in your browser unless you opt into one of two features that talk
to a third party *you* control: cross-device sync (your GitHub gist) and
fleet-landing reminders (the public ntfy.sh push service). Both are off
until you turn them on.

## Stored locally

- Galaxy scan database and colony history (`chrome.storage.local`).
- Sync + reminder credentials and switches — the GitHub token, ntfy
  token, and the sync / reminders master switches (`chrome.storage.local`,
  so one entry covers every universe).
- Other UI preferences and per-device settings (`localStorage`).
- An in-memory diagnostic log buffer — only when you enable the
  logger toggle, never persisted, gone when the tab closes.

## Sent to GitHub (only if you turn sync on)

If you paste a GitHub Personal Access Token into the OG-E Dashboard's
Sync tab:

- OG-E reads from / writes to a single private gist that **you own**.
  Payload is your colony history, colonization decisions, per-universe
  preferences and schedules, Daily Run routes, your manual fleet-save
  marks, and your Spyglass watch-list decisions (starred players,
  map colours, scan preferences) — gzip-compressed.
- Your OGame account password (the optional "Account password (for
  abandon)" field) **never leaves the device**: it is excluded from the
  sync payload and from Export files, and an incoming sync/import can
  neither read nor overwrite it. Enter it once per device that uses the
  abandon flow.
- Requests go to `https://api.github.com` only, authenticated with
  your PAT. The PAT is stored in `chrome.storage.local` (extension-private,
  not reachable by any web page) so a single entry applies to all your
  universes; it is sent only as the `Authorization` header on those gist
  requests.
- OG-E has no infrastructure to send your data to. No copy is kept
  outside GitHub and your devices.
- Remove the PAT in the Dashboard → sync stops. Revoke the PAT on
  GitHub → existing requests fail until you supply a new one.

## Sent to ntfy.sh (only if you turn reminders on)

Fleet-landing reminders deliver a phone notification shortly before a
fleet returns. They are off by default; the master reminders switch must
be enabled and you must paste an ntfy access token (both in the OG-E
Dashboard's Reminders tab). When armed, OG-E talks to the public push
service [ntfy.sh](https://ntfy.sh):

- Requests go to `https://ntfy.sh/<topic>` only (POST to schedule a
  notification, GET to reconcile the queue, DELETE to cancel). No other
  ntfy endpoint is contacted.
- `<topic>` is derived one-way from your token (`oge-` + a SHA-256
  prefix), so it is unguessable but reproducible across your devices.
  The token is never sent in the URL path — only as ntfy's auth header.
- The notification carries low-sensitivity flight data: the universe id,
  the mission type, the landing coordinates, the arrival time, and (for
  fleet-save reminders) the ship count. **Treat the topic as a secret:**
  anyone who learns it can read these notifications. This is an accepted
  trade-off for convenience — do not enable reminders if that bothers you.
- The token is stored in `chrome.storage.local` (extension-private, not
  reachable by any web page) so one entry applies to all your universes
  and the extension page can show the queue. Clearing the token, or
  turning the master switch off, stops all ntfy traffic.
- Notification icons are referenced by a `raw.githubusercontent.com`
  URL inside the push; your phone's ntfy app fetches them, not OG-E.

## What OG-E never does

- No telemetry, analytics, or crash reporting.
- No background tasks against the game server. Every game request is
  a direct response to your own click — see
  [`CONTRIBUTING.md`](CONTRIBUTING.md) §1 (Compliance).
- No third-party fonts, scripts, or trackers. The only outbound traffic
  is to the services above (GitHub for sync, ntfy.sh for reminders), and
  only after you opt in.

## Permissions

- `storage` — local scan database and colony history.
- `unlimitedStorage` — lifts the browser's 10 MB default cap on that same
  local database. Nothing new is collected or sent; it only stops writes
  from failing once you play several universes (each keeps its own scan
  cache). Data still never leaves your device unless you opt into sync.
- `host: ogame.gameforge.com` — content scripts run on game tabs;
  the XHR observer reads requests the game already fires. The Spyglass
  dashboard's **⟳ Refresh** button also fetches the same universe's
  **public** statistics API (`/api/*.xml`) directly, with no game cookie
  attached (`credentials: 'omit'`) — the same public data OG-E already
  reads in-game, only triggered by your click from the dashboard page.
- `host: api.github.com` — only used when you enable gist sync.
- `host: ntfy.sh` — only used when you enable fleet-landing reminders.

## Contact

Open an issue on the project repository.
