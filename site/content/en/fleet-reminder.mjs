// @ts-check

// EN mirror of ../fleet-reminder.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'fleet-reminder',
  category: 'fab',
  locale: 'en',

  name: 'Fleet reminder',
  oneLiner:
    'A loud in-tab button reminding you that your fleet-save is back and sitting exposed — so you send it out again right away.',
  order: 6,

  idea: [
    'When your fleet-save returns and sits exposed on a body, a **prominent, "louder" button** appears on every game page. Tapping it takes you to the right body and lets you send the fleet out again immediately; after a longer idle spell the button starts pulsing to catch your eye.',
    'The reminder disappears only once you close the matter (re-dispatch or dismiss it manually) — it does not clear "on its own".',
  ],

  value: [
    'A returned fleet sitting idle is easy prey. Re-doing a fleet-save is easiest to forget exactly when you come back to the game after a break — this button exists so it does not slip by.',
  ],

  fairplay: {
    summary: [
      'It works **only while the tab is open** and does nothing in the background: when the tab is hidden it does not even pulse. It knows about the returned fleet from **the event list the game displays anyway** — not from any server tracking.',
      'This is the in-tab layer; the optional push notification while you are offline is a separate feature, described honestly alongside the alarm clock.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'The "Fleet reminder" button — the fleet is back and sitting exposed.' },
    { id: 'pulse', caption: 'Pulsing after a longer idle spell — a "refresh and handle your fleet" signal.' },
  ],

  codeRefs: [
    'src/features/alarmClock/guardian.js',
    'src/features/alarmClock/producer.js',
    'src/state/fleetReminders.js',
  ],

  status: 'drafted',
};
