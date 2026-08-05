// @ts-check

// EN mirror of ../spyglass-map.mjs. Code discovery lives in the PL base file.

/** @type {import('../_schema.mjs').Feature} */
export default {
  id: 'spyglass-map',
  category: 'spyglass',
  locale: 'en',

  name: 'Position map and range',
  oneLiner:
    'Every body of every watched player plus your own on a single galaxy grid — with rings around those who can reach you in under eight hours.',
  order: 6,

  idea: [
    'The grid is the server seen from above: rows are galaxies, systems run horizontally, and vertically within a row — the position inside a system. A dot is a body; it grows with the player\'s danger, and you assign the colour yourself so you can recognise your regulars. Your planets are white. Hovering (on touch, the first tap) gives the name, coordinates and estimated flight time to your nearest planet.',
    'The `who can reach you` chip computes, for every foreign body, the shortest distance to **any** of your planets — with map wrap-around per the server rules — and converts it into flight time for the **slowest possible attacker**. So a ring means: this player reaches you within eight hours even with his heaviest, slowest fleet. The threshold is deliberately pessimistic, because a faster fleet arrives sooner.',
  ],

  value: [
    '"Who is dangerous" and "who is dangerous **to me**" are two different questions. A player at the far end of the server with a monstrous fleet is a theoretical problem; an average one three systems away is a practical problem. The map answers that with geometry you read in a second — useful for planning a fleet-save, for picking a target, and for deciding where to put your next colony.',
  ],

  fairplay: {
    summary: [
      'Body positions come from the **public server map** — the same file community tools use. The map is therefore complete from the first run and needs not a single scan. Flight times are arithmetic over the game\'s published rules.',
      'The map **sends nothing and pokes nobody** — it is a drawing over data that is public anyway, plus your own coordinates from the game. There is no in-game action here, not even an indirect one.',
    ],
  },

  details: [
    'The map holds only your bodies and players from the watch list — not the whole server, so the drawing stays readable.',
    'The eye next to a chip hides a player from the map without unwatching him; the cross ends the watch entirely.',
    'The colour chip is the one place where you set a player\'s colour — the same one then shows up on his watch-list card.',
    'On touch, the first tap describes the body, the second opens the owner\'s dossier.',
  ],

  demo: {
    id: 'positions-map',
    caption: 'The real positions map over an invented universe. A row is a galaxy, a dot is a body, size grows with danger, your planets are white. The amber ring means "can reach you" — Kestrel sits three bodies deep inside your reach, while Boro grows fat safely far away.',
  },

  screenshots: [
    { id: 'chips', caption: 'Player chips under the map and the "who can reach you in ≤8 h" toggle — colour, hiding, entry to the dossier.' },
  ],

  codeRefs: [
    'src/features/dashboard/index.js',
    'src/features/dashboard/mapPrimitives.js',
    'src/domain/geometry.js',
  ],

  status: 'drafted',
};
