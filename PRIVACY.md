# Privacy

OG-E has no servers and collects no telemetry. Everything stays in
your browser unless you opt into the optional cross-device sync.

## Stored locally

- Galaxy scan database and colony history (`chrome.storage.local`).
- UI preferences and settings (`localStorage`).
- An in-memory diagnostic log buffer — only when you enable the
  logger toggle, never persisted, gone when the tab closes.

## Sent to GitHub (only if you turn sync on)

If you paste a GitHub Personal Access Token into the sync section:

- OG-E reads from / writes to a single private gist that **you own**.
  Payload is your scan database + colony history, gzip-compressed.
- Requests go to `https://api.github.com` only, authenticated with
  your PAT. The PAT is stored in `localStorage` and is sent only as
  the `Authorization` header on those gist requests.
- OG-E has no infrastructure to send your data to. No copy is kept
  outside GitHub and your devices.
- Remove the PAT from settings → sync stops. Revoke the PAT on
  GitHub → existing requests fail until you supply a new one.

## What OG-E never does

- No telemetry, analytics, or crash reporting.
- No background tasks against the game server. Every game request is
  a direct response to your own click — see
  [`CONTRIBUTING.md`](CONTRIBUTING.md) §1 (Compliance).
- No third-party fonts, scripts, or trackers.

## Permissions

- `storage` — local scan database and colony history.
- `host: ogame.gameforge.com` — content scripts run on game tabs;
  the XHR observer reads requests the game already fires.
- `host: api.github.com` — only used when you enable gist sync.

## Contact

Open an issue on the project repository.
