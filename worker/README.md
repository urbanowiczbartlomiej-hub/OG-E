# OG-E expedition-reminder Worker

Cloudflare Worker that turns the wave state OG-E writes into a GitHub
gist into push notifications via [ntfy](https://ntfy.sh). Runs on a cron
trigger every minute; independent from the extension build (it lives in
the monorepo only for convenience — nothing in `npm run package` touches
it).

## How it fits together

```
OG-E extension  ──writes──►  gist: oge-reminders.json  ◄──reads/writes──  this Worker  ──push──►  ntfy  ──►  phone/watch
   (sets nextWaveAt)              (config + waves + notifyState)              (every minute)
```

The Worker only ever writes the `notifyState` block; `config` and
`waves` belong to the extension.

## One-time deploy

From this `worker/` directory:

```sh
npm install
npx wrangler login                       # opens a browser; authorise your CF account
npx wrangler secret put GIST_TOKEN       # paste a GitHub PAT with `gist` scope
npx wrangler deploy
```

`GIST_ID` and `NTFY_URL` are already set in `wrangler.toml`. The ntfy
topic normally comes from the gist (`config.ntfyTopic`, written by the
extension). If you want a fallback before the extension has pushed, also
set it as a secret:

```sh
npx wrangler secret put NTFY_TOPIC
```

## Test without waiting for cron

The deployed Worker exposes `GET /run` which performs one cycle and
returns the result as JSON:

```sh
curl https://oge-expedition-reminder.<your-subdomain>.workers.dev/run
```

Expected `reason` values:

| reason | meaning |
|---|---|
| `disabled` | `config.enabled` is false — enable it on the histogram tab |
| `outside-allowed-hours` | current time is outside `allowedHours` |
| `state-unreadable` | gist has no `oge-reminders.json` yet — send a wave first |
| `no-ntfy-topic` | no topic in config and no `NTFY_TOPIC` secret |
| `{ ok: true, sent: [...] }` | pushes were sent for the listed wave ids |

Watch live logs with `npx wrangler tail`.

## Notes

- `GIST_ID` is not a secret: the gist is private and protected by the
  token; the id alone grants nothing. Safe to commit even in a public
  repo.
- `GIST_TOKEN` is a Wrangler secret — never committed.
- Cron schedule is `* * * * *` (every minute) in `wrangler.toml`.
