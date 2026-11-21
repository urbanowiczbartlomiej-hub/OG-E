// @ts-check

// EN mirror of ../alarm-clock.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'alarm-clock',
  category: 'dashboard',
  locale: 'en',

  name: 'Alarm clock',
  oneLiner:
    'Your phone rings when your fleet-save or an expedition wave comes back — at a time set by your own dispatch.',
  flagship: true,
  order: 3,

  idea: [
    'The alarm clock schedules phone notifications through **ntfy.sh** — a free notification app. It needs two tokens: **ntfy** (the **Alarm clock** tab in the Dashboard) and **GitHub** (the **Sync** tab) — the alarm clock keeps its reminder list in your private gist. Then switch on **Enable alarm clock** and subscribe to your topic on the phone.',
    'Three kinds of reminders, each switched on separately: **Fleet-save** (detected automatically — a big fleet on a long flight), **Expeditions** (a whole wave of returns as one series) and **Ad-hoc** (a bell you set by hand on any flight in the event list). For each one you choose when it rings relative to landing.',
    'Scheduled reminders ring even with the game closed. You see them all under **Reminders set**.',
  ],

  value: [
    'A fleet-save lands at 3 a.m. or in the middle of your workday. Instead of doing the maths in your head and logging in "just in case", you set it once — the phone rings when the fleet lands.',
  ],

  fairplay: {
    borderline: true,
    summary: [
      'We say it plainly: **this is our one feature on the edge of the rules**, which is why we keep it narrow.',
      'It is **an alarm for a time you already know** from your own dispatch — not a game watchdog. It does not watch enemy fleets and does not reload the page. It only schedules reminders while you have the game open yourself.',
      'OG-E reads the landing time from the event list the game already shows. The notification is sent by ntfy.sh, and the reminder list is kept in your gist — services you set up yourself. The game server has nothing to do with it.',
    ],
  },

  details: [
    'By default a fleet-save is a fleet of 100,000+ ships on a flight longer than 10 minutes — both thresholds can be changed.',
    '**Landed-fleet reminder** rings (by default 20 min after landing) if a fleet-save is still sitting on the planet after landing.',
    'ntfy schedules at most 3 days ahead. A later fleet-save or wave is scheduled the next time you open the game; an ad-hoc reminder further than 3 days out is not possible.',
    'When a reminder cannot be scheduled (e.g. the daily ntfy limit is used up), a clear notice appears in the game.',
  ],

  screenshots: [
    { id: 'reminders', caption: 'Reminders set — scheduled bells: an expedition wave, an ad-hoc flight and a fleet-save.' },
    { id: 'fleetsave', caption: 'Fleet-save settings: how many ships count as a fleet-save, when to ring, the message text and the Landed-fleet reminder.' },
  ],

  codeRefs: [
    'src/features/alarmClock/index.js',
    'src/features/alarmClock/producer.js',
    'src/features/alarmClock/eventList.js',
    'src/sync/alarmClock.js',
    'src/sync/ntfyReconciler.js',
  ],

  status: 'drafted',
};
