// OG-E expedition-reminder Worker.
//
// Cron-triggered every minute (see wrangler.toml). Reads the OG-E gist's
// `oge-reminders.json`, and for every wave that is overdue — while
// reminders are enabled and the current time is inside the allowed
// window — sends a push via ntfy and bumps that wave's counter. Repeats
// per `reminderEveryMinutes` until the extension bumps the wave (a
// re-send) or `maxNotificationsPerWave` is hit.
//
// Field ownership: this Worker only ever writes `notifyState`. `config`
// and `waves` belong to the extension and are preserved verbatim.

const GIST_FILE = 'oge-reminders.json';
const UA = 'oge-expedition-reminder/1.0';

export default {
  /**
   * @param {ScheduledController} _event
   * @param {Record<string, string>} env
   * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  /**
   * Manual trigger / health check. `GET /run` performs one tick and
   * returns the JSON result — handy for testing without waiting for cron.
   *
   * @param {Request} req
   * @param {Record<string, string>} env
   */
  async fetch(req, env) {
    if (new URL(req.url).pathname === '/run') {
      const r = await tick(env);
      return new Response(JSON.stringify(r, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('OG-E expedition reminder worker');
  },
};

/**
 * One reminder cycle.
 *
 * @param {Record<string, string>} env
 */
async function tick(env) {
  const state = await readState(env);
  if (!state) return { ok: false, reason: 'state-unreadable' };

  const cfg = state.config || {};
  if (cfg.enabled !== true) return { ok: true, reason: 'disabled' };

  const now = Math.floor(Date.now() / 1000);
  const tz = cfg.timezone || 'UTC';
  const hours = cfg.allowedHours || { start: '00:00', end: '00:00' };
  if (!withinAllowed(nowMinutesInTz(tz), hours.start, hours.end)) {
    return { ok: true, reason: 'outside-allowed-hours' };
  }

  const everySec = (cfg.reminderEveryMinutes || 10) * 60;
  const max = cfg.maxNotificationsPerWave || 30;
  const topic = cfg.ntfyTopic || env.NTFY_TOPIC;
  if (!topic) return { ok: false, reason: 'no-ntfy-topic' };

  const ns = { ...(state.notifyState || {}) };
  const waves = state.waves || [];
  const sent = [];

  for (const wave of waves) {
    if (now < wave.nextWaveAt) continue;                  // still in flight
    const s = ns[wave.id] || { notifyCount: 0, lastNotifiedAt: null };
    if (s.notifyCount >= max) continue;                   // anti-spam cap
    if (s.lastNotifiedAt != null && now - s.lastNotifiedAt < everySec) continue;

    const ok = await sendNtfy(env, topic, wave, s.notifyCount + 1);
    if (!ok) continue;                                    // retry next cycle
    ns[wave.id] = { notifyCount: s.notifyCount + 1, lastNotifiedAt: now };
    sent.push(wave.id);
  }

  // Drop counters for waves that no longer exist.
  const live = new Set(waves.map((w) => w.id));
  for (const id of Object.keys(ns)) if (!live.has(id)) delete ns[id];

  const changed = JSON.stringify(ns) !== JSON.stringify(state.notifyState || {});
  if (changed) await writeNotifyState(env, state, ns);
  return { ok: true, sent, now };
}

// ── GitHub Gist IO ──────────────────────────────────────────

/** @param {Record<string, string>} env */
async function readState(env) {
  const res = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    headers: ghHeaders(env),
  });
  if (!res.ok) return null;
  const gist = await res.json();
  const file = gist.files && gist.files[GIST_FILE];
  if (!file) return null;
  const text = file.truncated && file.raw_url
    ? await (await fetch(file.raw_url)).text()
    : file.content;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param {Record<string, string>} env
 * @param {any} prev
 * @param {Record<string, unknown>} notifyState
 */
async function writeNotifyState(env, prev, notifyState) {
  const next = { ...prev, notifyState, updatedAt: new Date().toISOString() };
  await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    headers: { ...ghHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(next, null, 2) } } }),
  });
}

/** @param {Record<string, string>} env */
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GIST_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA, // GitHub rejects API requests without a User-Agent.
  };
}

// ── ntfy ────────────────────────────────────────────────────

/**
 * @param {Record<string, string>} env
 * @param {string} topic
 * @param {{ nextWaveAt: number, fleetCount: number, label?: string }} wave
 * @param {number} n
 */
async function sendNtfy(env, topic, wave, n) {
  const t = new Date(wave.nextWaveAt * 1000).toISOString().slice(11, 16);
  const res = await fetch(`${env.NTFY_URL}/${topic}`, {
    method: 'POST',
    headers: {
      Title: `Expeditions back (${wave.fleetCount}) — re-send`,
      Priority: n === 1 ? 'high' : 'default',
      Tags: 'rocket',
    },
    body: wave.label || `Wave of ${wave.fleetCount} expeditions returned ~${t} UTC. Reminder #${n}.`,
  });
  return res.ok;
}

// ── allowed-hours in the user's timezone ────────────────────

/** @param {string} tz @returns {number} minutes of day in tz */
function nowMinutesInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

/** @param {number} nowMin @param {string} startStr @param {string} endStr */
function withinAllowed(nowMin, startStr, endStr) {
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return true;                         // full day
  if (start < end) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end;                 // wraps midnight
}
