// @ts-check

// EN mirror of ../alarm-clock.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'alarm-clock',
  category: 'alarms',
  locale: 'en',

  name: 'Alarm clock',
  oneLiner:
    'A reminder you set yourself for a fleet return — it rings on your phone at the time your own send-off determines.',
  flagship: true,
  order: 1,

  idea: [
    "On the game's event list every fleet row gets a small, clickable badge in its arrival-time cell. You tap it to **arm a reminder** relative to that flight (e.g. the moment a fleet-save returns), and a second tap removes it. Waves of returning expeditions are detected and controlled as a whole — one badge for the whole series.",
    'The push is **queued on ntfy.sh** (a notification service you configure yourself with a token in Settings) with a delivery time computed from your send-off. ntfy holds and delivers the message at the appointed hour — after you set the reminder OG-E keeps no watch.',
  ],

  value: [
    'A fleet return or the end of a fleet-save often lands in the middle of the night or the middle of a workday. Instead of doing the math in your head and coming back over and over, you set one reminder and your phone speaks up exactly when the fleet lands.',
  ],

  fairplay: {
    borderline: true,
    summary: [
      'We say it **plainly: this is our one knowingly borderline feature**. That is why we keep it on the safe side and constrain it harder than the rules require.',
      'It is a **player-set reminder for one specific send-off** — not an automaton reacting to in-game events. The ring time follows from your own action (your send-off), not from monitoring the server.',
      'It is **presence-gated**: only ever armed while you are present in the game. OG-E does not watch the game on your behalf while you are away — no page reload, no reading the event list for hostile fleets, no audio, no blinking tab title, no system notifications.',
      "OG-E reads the arrival time **passively from the event list the game already renders** — with no traffic to the game server. The push itself travels through ntfy.sh, a service you configured, off the game's channel.",
    ],
  },

  details: [
    'A fleet-save is detected and scheduled automatically; a slot can only be cancelled inside its cancel window just before delivery.',
    'Configuration and tokens live in the OG-E Settings panel; without an ntfy token the alarm sends nothing outward.',
  ],

  screenshots: [
    { id: 'badge', caption: 'The clickable alarm badge in a row\'s arrival-time cell on the event list.' },
    { id: 'wave', caption: 'A wave of returning expeditions controlled as a single series.' },
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
