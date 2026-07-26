// @ts-check

// EN mirror of ../fleet-reminder.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'fleet-reminder',
  category: 'fab',
  locale: 'en',

  name: 'Fleet reminder',
  oneLiner:
    'An in-tab button reminding you that your fleet-save is back and sitting exposed, so you send it out again right away.',
  order: 6,

  idea: [
    'When your fleet-save returns and is available on the planet, a prominent, new button appears reminding you about your fleet. You can turn it on manually from the Fleet1 panel, or it turns itself on when the FS lands.',
    'You turn it off by re-sending the fleet with this button — it then uses your AGR fleet-save configuration — or manually: from the Fleet1 panel, or by long-pressing the button. Tapping it takes you to the right planet and lets you send the fleet out again immediately; after a longer idle spell the button starts pulsing to catch your eye.',
    'It only works on the tab you are on — if you are on another tab, you will not be notified there. It plays no sounds.',
  ],

  value: [
    'A returned fleet sitting idle is easy prey, and it is easy to forget even while you are online, just busy doing something else. This button makes sure you send the FS before you go offline — so it does not slip by.',
  ],

  fairplay: {
    summary: [
      'It works **only while the tab is open** and does nothing in the background: when the tab is hidden it does not even pulse. It knows about the returned fleet from **the event list the game displays anyway** — not from any server tracking.',
      'This is the in-tab layer; the optional push notification while you are offline is a separate feature, described honestly alongside the alarm clock.',
    ],
  },

  screenshots: [
    { id: 'button', caption: 'The "Fleet Reminder" button in the Fleet1 panel — the fleet is waiting to be re-dispatched.' },
    { id: 'pulse', caption: 'The "Fleet Reminder" orb lit up next to another active button — a signal that the fleet is still waiting.' },
  ],

  codeRefs: [
    'src/features/alarmClock/guardian.js',
    'src/features/alarmClock/producer.js',
    'src/state/fleetReminders.js',
  ],

  status: 'drafted',
};
