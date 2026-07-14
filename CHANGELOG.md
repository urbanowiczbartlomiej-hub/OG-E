# Changelog

All notable changes to this project will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
version numbers follow [Semantic Versioning](https://semver.org).

## [1.49.0] — 2026-07-14

### Added

- **A touch-sized galaxy navigation bar under the system list.** On the Galaxy
  page the header's inputs, arrows and buttons sit at the very top and render
  tiny on a phone — so stepping through systems meant scrolling up to the
  header, tapping, and scrolling back down to the rows you were watching.
  There's now a full-size mirror of those controls directly below the table:
  large −/+ steppers with coordinate fields, a Start button, and Phalanx /
  Spy / Discovery. It drives the game's own controls underneath, so every
  rule (system wrap-around, galaxy-switch costs, "phalanx unavailable here")
  behaves exactly as it does up top. It rides the existing **Readability**
  toggle in Display settings; with the bar on, the cramped original header is
  hidden so there's only one set of controls.

### Changed

- **The expedition slot at the bottom of the system list no longer makes the
  table jump.** That row grows taller on systems that have expedition debris,
  which used to nudge everything below it — now including the new navigation
  bar — up and down as you stepped between systems. Its readout is now a
  fixed-height single line (Metal / Crystal / Pathfinders and the Reduce
  action on one row, in the bar's own styling), so the table height stays put
  and the buttons stop moving under your finger.

## [1.48.2] — 2026-07-14

### Fixed

- **The Colonization button no longer lies right after a page load.** It used
  to enable immediately, answer an early tap with a false "No more
  candidates", and then find candidates a second later once the server
  occupancy data finished loading. The button now stays greyed on "Wait…"
  until the free positions are actually computed, then enables in the same
  instant the "N free" counter appears — with its first tap already aimed at
  a real candidate. If the data can't load at all (offline), the button
  releases into the old scan-only behaviour instead of waiting forever.

### Changed

- **One status-colour language across all the send buttons.** A red flash
  now always means "the tap failed" (no ship, no fuel, no route, every fleet
  slot busy) and an amber flash always means "nothing to act on right now —
  come back later" (cooldowns, everything already sent). Daily Run joins the
  convention: its failure flashes recolour the button ring too, where they
  used to change only the text.
- **Shorter, calmer labels.** The overflowing "No more candidates" became a
  "No targets" flash that fits the button, and the expedition's "All maxed!"
  is now "All sent" — the same phrase the Daily Run button already uses when
  the day's work is done.

## [1.48.1] — 2026-07-14

### Fixed

- **The Daily Run button no longer flickers between states.** Labels used to
  flash wrong states for a fraction of a second — mid-selection, right after
  a send, or over an error message — because background repaints could
  overwrite what the button was actually doing. It now follows the same
  stability contract as the expedition button: labels change only when the
  underlying state really changes, the armed "(tap to send)" state no longer
  flaps while the game re-validates the form, and after a send the whole
  button stays greyed on "Sent" until the page reloads. A second tap while
  the game isn't ready yet now answers with a brief "Wait…" instead of doing
  nothing.

## [1.48.0] — 2026-07-13

### Added

- **Your Spyglass intel now syncs across your own devices.** Spy reports,
  galaxy-activity looks and watched-player names ride your private gist
  automatically, so both devices show the same coverage — the observation
  timeline can't be re-derived by re-spying, and per-device divergence was
  the root cause of "two devices, two different views".
- **Presence history — the long-horizon offline-pattern explorer.** A new
  dossier section keeps months of day×hour "seen active / looked & quiet"
  coverage (far past the 45-day activity rings) and lets you read it by
  cycle: week×hour, daily rhythm, or day-of-month. Colour = how reliably
  offline that phase is (the strike window), tap any cell for exact counts.
- **Alliance pool feeds the presence explorer.** One alliance sync now also
  shares your presence history and pools everyone's — months of looks from
  the whole alliance in one heatmap, the intended way to find recurring
  offline windows. Still inside the privacy floor: hour-grain bits, no
  coordinates, no report contents.

### Changed

- **Alliance share is safe across your own devices.** Sharing under the same
  name from two devices no longer overwrites — blocks now union (newest wins
  per field, presence history OR-merged). The config collapsed to just the
  token: the gist id and your share name derive themselves. A gentle "share
  due" nudge appears after a day so the pool stays fresh (one click shares
  yours and pulls everyone's — never automatic).
- **The alliance file is compressed** (gzip), so a busy alliance's shared
  file stays small; older plain-file shares still read.

### Fixed

- **Two devices no longer diverge, and alliance sync no longer wipes a
  device's data** — the two issues that started this work.

## [1.47.4] — 2026-07-13

### Changed

- **Watchlist cards put every control on the face.** The hidden ⚙ settings
  face is gone — its tiny gear sat one graze away from the destructive ✕.
  Each card now ends in a command bar pinned to its bottom edge: the
  galaxy / probes watch toggles and the ↻ re-scan flag are always visible and
  one tap away (↻ lights amber while a re-scan is pending), with the intel
  age beside them. The remove ✕ stands alone in the top corner with a real
  finger-sized target.
- **Enemy/Friend/Neutral tags became map colours.** You now pick a plain
  colour per tracked player (red, orange, gold, green, blue, violet) from a
  swatch popover on the map's player chips — the tag rows on the card and in
  the dossier are gone, and the card's dot just mirrors the map. Old tags
  convert automatically (enemy → red, friend → green, neutral → default
  grey). The patrol no longer exempts 'friend'-tagged neighbours — your
  buddies and alliance members are still skipped via the game's own flags.
- **Alliance share now shares observations only.** Your block carries
  last-spy / last-seen times and names for players you actually hold data on
  — never your watch list, tags or any settings. The shared table lost its
  Tag column, moved off the Spyglass tab onto the Sync card (it scrolls
  instead of flooding the page) and gained its own Alliance sync button
  there; the Spyglass title keeps a one-line summary. The whole section has
  a master switch like "Sync across devices".
- **The alliance gist sets itself up.** Leave the gist id empty — the first
  sync finds the token account's alliance gist (or creates a fresh secret
  one) and fills the id in; alliance-mates with the same token auto-find it
  too. A mistyped id now gets a clear message instead of a raw HTTP 404.
- **Better phone layouts.** Below 640 px the players table re-packs: the
  watch pill stacks above the nick, the ships composition note gets its own
  line, and the ≈ signs are gone. The dashboard top-bar collapses into the
  compact server pill already below 850 px, and the Coords/Names toggle
  rides the "Who's spying on you" header instead of spending a row.

### Security

- **Your account password (for abandon) never leaves the device any more.**
  It used to ride the encrypted-nowhere sync payload and Export files; it is
  now excluded from both, an incoming sync or import can neither read nor
  overwrite it, and the next sync round scrubs it out of your gist's current
  contents. Enter it once per device that uses the abandon flow. If you ever
  pointed the alliance share at the same GitHub account as your personal
  sync, consider deleting that gist (sync recreates it) — gist edit history
  keeps old revisions.

## [1.47.3] — 2026-07-12

### Fixed

- **The Spyglass "Look" no longer gets stuck re-loading the same system.**
  After you probe a player, the galaxy view shows the activity marker your own
  probe lit — and the Spyglass rightly refuses to count that marker as the
  owner's activity. But refusing it also erased the proof that you LOOKED, so
  the button kept proposing the very same system on every tap: for up to an
  hour after a probe, or indefinitely for a colony that had moved away since
  the last universe-data update. Browsing a system now counts as "seen" the
  moment it renders, whatever its markers show — while the activity readouts
  stay exactly as honest as before.

## [1.47.2] — 2026-07-12

### Fixed

- **The Spyglass button no longer blinks on every page load.** Its
  visibility is driven by the watch-list, which loads asynchronously — so on
  every navigation the button vanished for a beat and then popped back in.
  The last shown/hidden verdict is now remembered on the device and the
  button mounts instantly (in its dim loading state) while the real list
  loads; if the list turns out to be empty, it quietly removes itself.

## [1.47.1] — 2026-07-12

### Changed

- **Configs save themselves — the Save buttons are gone.** Daily Run routes,
  the colonization config and the alarm-clock config now persist on change,
  like every other dashboard control. Edits survive a universe switch and a
  closing tab (a pending save is flushed, not dropped); saves never repaint
  the form under your fingers; and a change that changes nothing writes
  nothing — no more sync churn from idle clicks. Because "Reset to defaults"
  now also saves (and syncs) what it restores, it asks for a second tap
  before wiping anything.

### Fixed

- **Floating-button orbits respect screen edges.** Drag the button into a
  corner of a tall phone screen and the satellite orbs used to pile onto the
  near edge and slide under the button while the other side of the screen sat
  empty. The fan now rotates just enough to fit on-screen, keeps its spacing,
  sticks to its side of the screen while you drag (no mid-drag teleports),
  and no longer flips away from free space when the button sits near a single
  edge.

## [1.47.0] — 2026-07-12

### Added

- **Alliance Spyglass share (opt-in co-op).** Pool your Spyglass coverage
  with alliance-mates through a shared, alliance-owned private gist. The new
  "Alliance" button at the top of the Spyglass tab runs ONE round per click —
  share your block, pull everyone else's — and nothing ever syncs in the
  background. What leaves your device: watched players' ids, names,
  relationship tags, last-spy / last-seen times and a spied-bodies count — no
  coordinates, no report contents. Each member writes only their own block,
  so nobody can clobber anyone else's data. Configure it on the Sync tab
  (alliance token + gist id + your share name); the pulled union renders as a
  coverage panel under the Spyglass title and stays display-only — it never
  feeds your danger scores or scan plans.

### Fixed

- **One consistent "loading" look across the floating command buttons.**
  While the fleet page's event list is still loading, every FAB command
  button now greys out the same way (dim fill, label and node, module-coloured
  ring): Daily Run and Colonization no longer wear a gold ring during the
  wait, and the Lifeform Discovery button no longer stays fully vivid with
  only its node greyed.

## [1.46.1] — 2026-07-12

### Fixed

- **Distances now respect the universe's donut geometry.** "Who's spying on
  you" (in-game panel and the dashboard proximity strip) measured distance as
  the naive coordinate difference, so a prober at 4:450 read as "430 sys" from
  your 4:20 planet — while the game always flies the wrapped shortest path (69
  systems on a 499-system donut). Distances now wrap on both axes per the
  server's donut flags, so aggressors sitting across the seam show as the
  close-range threat they really are.

### Changed

- **Spy probes launch from your NEAREST planet.** A galaxy look is free from
  anywhere, but a probe flight costs real minutes both ways. When the Spy
  button proposes a probe (ordinary scan or moon-strike check), it now first
  switches you to the own planet closest to the target — donut-aware flight
  distance, moons excluded — and only then arms the send from there. One tap
  = one hop, as always; the extra tap buys a much faster report.

## [1.46.0] — 2026-07-11

### Changed

- **Sweep the whole account before any verdict.** The strike ladder (lone /
  newest / any alike) now speaks only once EVERY body of the player has
  been looked at within the last hour. Partial knowledge never proposes a
  probe — it proposes more looking: the Spy button queues the player's
  unseen systems as "strike? · sweep account" looks, and only a completed
  sweep yields the verdict. Looks are free and undetectable; a fresh planet
  mark elsewhere now refutes a false candidate BEFORE a probe is spent and
  your espionage shows in their log.

## [1.45.0] — 2026-07-11

### Added

- **Patrol territory mode (Spyglass).** The watch-list is the sniper's tool;
  this is the territorial predator's: your colonies become a coverage
  lattice and the prey is whoever NEARBY slips. One knob — `Patrol ± N
  systems` in the Spyglass scan preferences (0 = off, synced across
  devices) — and the in-game Spy button starts walking those systems
  through its Look proposals and hunting moon-strike signals on ANY
  neighbour there (friends, your alliance, noob-protected, vacation and
  banned players are skipped). A new Patrol card on the Spyglass tab shows
  the strikes it found — coords deep-link to the galaxy, each signal names
  its honest claim (fresh landing? / parked fleet? / owner around?), and a
  one-tap "watch" promotes the neighbour onto the watch-list — plus a
  coverage summary saying how well the grounds are being walked. The card
  renders only while a patrol radius is set; the detector and prey filters
  are the SAME code the in-game button runs, so the two surfaces can never
  disagree.
- **Spy-calibrated civil baseline (Spyglass dossier).** Your own spy
  reports now calibrate the "how many of those ships are combat" model. A
  player whose scans account for their WHOLE current military score
  (defence + fleet, civil ships at 50% — the game's own weighting) is
  provably seen in full: an unscanned moon, a fleet in flight or a stale
  report all break that identity, so bad samples exclude themselves. Such
  verified players' dossiers state the seen composition directly ("X
  combat · Y civil ships — fully scanned"). From three or more of them
  OG-E learns the server's civil-ships-per-economy ceiling and every other
  dossier gains an opposite-direction read: "at least ~N beyond any civil
  need" — ships no plausible civilian fleet explains. Still a count (a
  probe swarm exceeds any ceiling — the transporter/probe-swarm veto
  applies), still dossier prose only, still never fed into the danger
  score.
- **Type-to-set number boxes beside the Galaxy Viewer sliders.** Each
  slider (Offline window, Farm reach, Spot gap) is paired with a compact
  number box bound to the same value — drag for coarse sweeps, type for
  single-system precision (the 2–250 Spot gap range was impossible to hit
  by finger).

### Changed

- **The dashboard is now mobile-first.** A full pass over every tab at
  phone widths: the tab bar is a single row that scrolls sideways under
  your finger (edge glows say "more tabs this way", the active tab pulls
  itself into view) and stays stuck to the top of the screen, so switching
  tabs from the bottom of a long table no longer costs a full scroll back
  up. Wide tables (players, dossier per-body, Galaxy Viewer results, the
  presence heatmap) scroll inside their own wrappers — the page itself
  never scrolls sideways. Small controls grew real touch targets, the
  smallest text sizes came up a notch, and stat cards form a tidy
  two-column grid on phones.
- **Hover is an enhancement, never the carrier.** Every number and verdict
  that used to live only in a hover tooltip is now reachable by touch: the
  map readout lines also respond to taps, the system card opens INLINE
  under its strip or map instead of floating over content, and on the
  positions map the first tap on a body prints its details (name, coords,
  reach hours) into a caption line — only a second tap opens the player.
- **The server codename is the phone top bar's tool.** On narrow screens
  the top-right pill shows which server you're looking at (e.g. `s163-pl`)
  and tapping it drops in the row that changes it — server selector plus
  Export/Import, now dressed in the same dark-field-and-pill language as
  the rest of the page (the last natively-styled controls are gone).
- **Control clusters became command blocks.** The Spyglass scan
  preferences and the Galaxy Viewer configuration read top-to-bottom as
  one bordered block: muted keyword captions, hairline dividers, two
  columns that stack on phones, full sentences demoted to tooltips. The
  Galaxy Viewer sliders wear the settings panel's look (slim track, lit
  progress, ringed thumb) and the Sync / Alarm clock action buttons the
  chip-pill look.

## [1.44.0] — 2026-07-11

### Added

- **Moon strike setting (Spyglass).** The "a fleet may be sitting on that
  moon" detector is now an explicit option — one `Moon strike` selector in the
  Spyglass scan preferences, a ladder where each level includes the previous:
  `off` · `lone` (only the moon is lit and the rest of the account is
  confirmed quiet — the classic fleet-save-landing signature) · `newest`
  (default: the moon holds the account's newest activity, or the last trace
  before everything went quiet — a parked fleet outlives its 60-minute
  marker, so this catches "left it and logged off" up to 8 hours back) ·
  `any` (any lit moon, even beside active planets — the owner may be around,
  and every surface says so). Signals name their claim honestly: "fresh
  landing?", "parked fleet?", or "owner around?" — always "spy to confirm",
  never "fleet is there". The setting syncs across devices.
- **Re-look nudge for ambiguous moons.** When a moon and a planet light up
  inside the same fuzzy "<15 min" band, no honest call is possible — but the
  markers mature into exact minutes after a quarter hour. The galaxy Look
  plan now proposes revisiting that system exactly in the window where one
  look settles the order ("moon order? · look now"), and drops the nudge
  once the markers die.
- **Reports step on the Spy button.** After a probing run the button now
  closes the loop with "Reports · N new" — one tap opens the messages page
  (which is also what feeds the reports into Spyglass). A probe destroyed by
  the defender stops counting after 30 minutes, so the button can never get
  stuck.

### Changed

- **Look-first intel loop.** The Spy button now orders its proposals:
  strike → galaxy looks → probes → reports. Looks are free and undetectable,
  and browsing BEFORE probing reads the target's activity while your own
  probes haven't lit any markers yet — the probes that follow act on that
  clean picture. Only a strike cuts the line.
- **Several moons lit at once.** The strike flags one moon at a time (the
  newest mark, with "N moons lit" shown when others glow too) and rotates
  automatically: probing the flagged moon moves the flag to the next one.
  Co-lit moons no longer downgrade the signal — a human playing touches
  planets; activity concentrated on moons alone reads as landings.
- **Expedition auto-redirect hops moons.** An expedition sent from a moon now
  redirects to the next moon in your list (previously a moon-launched send
  got no redirect at all).
- **Daily Run walks moons.** A Send All started from a moon advances
  moon→moon instead of jumping to a planet, and the button shows the moon's
  own name (moons have names too).

### Fixed

- **Fleet reminder could fleet-save the wrong fleet.** On a fleet page the FR
  button now verifies the ACTIVE body — coordinates AND planet-vs-moon — is
  the one being watched before driving the save; anywhere else it snoozes and
  navigates there instead. Being on "a" fleet page is no longer enough.
- **Send All skipped the planet under its own moon.** With the collect target
  on moon A, planet A was excluded from the collection walk (same
  coordinates read as "that's the target"); the walk now tells planets and
  moons apart, on targets and on already-collected origins alike.
- **False strike on an inactive moon.** A marker showing 40–55 idle minutes
  seen during a fresh look counted as "lit NOW", so a moon nobody touched in
  an hour could fire the strike while your own probes lit the planets.
  Freshness is now keyed on the interaction time the marker implies; the
  15–60-minute tail is reported as "parked fleet?" with its age instead of
  masquerading as live activity.

## [1.43.0] — 2026-07-11

### Fixed

- **Hidden-fleet estimates were too low for cargo-heavy players.** The
  military highscore counts civil ships (transporters, recyclers, colony
  ships, probes, satellites, crawlers) at half their value; Spyglass had been
  treating them at full value, so a player parking a big transporter fleet
  read as having far less hidden than they really did. Spyglass now subtracts
  the visible fleet in the score's own currency and shows the hidden fleet in
  **resources** (the units a spy report uses) beside the exact visible fleet —
  no more mystery gap between a scan and the estimate.

### Changed

- **Danger reads composition more sharply.** The res/ship signal now accounts
  for the civil-ship weighting, and the assumed makeup of a player's flying
  fleet leans toward warships when the signs point that way — a warrior-class
  alliance, a fleet spread wide across the server, a heavy kill history, or a
  high bandit rank. An aggressive player's hidden fleet is treated as more
  combat-heavy than a builder's.
- **Settings panel command block.** The size slider is now the bottom segment
  of the FAB block it controls (a slim modern slider with a filled track), the
  Dashboard launcher matches the module tiles (logo over label, same height),
  and the section headings read as headings.
- **Dashboard enable switches are all chips now.** The last checkboxes (alarm
  clock, cross-device sync, the colonization "prefer" switches, route pause)
  became toggle chips like the rest, and every chip behaves correctly on
  touch — a tap no longer leaves a phantom highlight that looked enabled.
- **Floating-button menu spacing.** The satellite orbs keep an even gap
  whether you have two modules or six, instead of flinging two to the extremes
  and cramming six together.

## [1.42.1] — 2026-07-10

### Changed

- **Settings panel polish.** The button-size slider wears the panel's design
  language — slim rounded track with a filled progress side and a round accent
  thumb — and sits evenly spaced between the command block and the options
  below. The preferences panel gains matching side margins, so everything under
  the full-width command block reads as one aligned column.
- **Dashboard launcher says what it does.** The button now reads
  "Open Dashboard" instead of "OG-E Dashboard" — fused flush with the module
  tiles, the old name read as a section title rather than a clickable control.

## [1.42.0] — 2026-07-10

### Added

- **Spyglass reads a player's fleet-save rhythm.** A new "FS windows" block in
  the dossier brackets when a watched player's fleet *left* and *came back* —
  paired from your own spy reports plus the galaxy activity you already gather
  passively. Every line is an honest time window ("left Tue 21:40 → 23:15"),
  narrowed to a likely moment only when a single activity marker pins it, never
  a fake exact minute. It flags its own doubts: a fleet that may have just
  moved next door (`relocated?`), a moon departure that could be a jump-gate
  hop (`gate?`), or sibling bodies it couldn't check. The "is a real fleet
  home" bar scales to each player (a fraction of their own peak / total fleet),
  so it catches a small farm's save and ignores a big player's recycler junk
  alike.

### Changed

- **Watchlist cards and the dossier show visible fleet beside hidden.** The
  hidden-fleet estimate swings with scan timing — a fleet caught home reads
  "~0 hidden" exactly when it sits catchable — so the scan-confirmed *visible*
  parked fleet now sits next to it ("visible 48M · hidden ~12M"), the stable
  number beside the volatile one, colour-coded (blue = seen, amber = computed).

## [1.41.1] — 2026-07-10

### Changed

- **The dashboard "Who's spying on you" card packs more in.** Each prober is
  now two lines instead of three — its distance and last-seen sit inline beside
  the name, so more scouts fit at a glance — and the geometry line leads with
  the origin (`from … · at your bodies`), since a scout almost always comes
  from one spot but touches several of yours. The card's title now reads
  exactly "Who's spying on you", matching the messages-page panel.

## [1.41.0] — 2026-07-10

### Changed

- **The dashboard "Who's spying you" card caught up to the in-game panel.**
  Probers from your own system now stand out with a red hot-row treatment, the
  card lists every body a scout probed (it used to stop at two), and a 💀
  legend explains the same-system flag — matching the messages-page panel,
  while keeping the dashboard-only watch / dossier / coords-or-names tools.
- **One spy eye across both surfaces.** The 👁 emoji on the messages-page
  "Who's spying on you" header is now OG-E's own eye glyph in spy gold — and
  that same mark sits beside the Spyglass tab title (the "experimental" badge
  is gone; its hidden-fleet caveat lives on as the eye's tooltip).

## [1.40.2] — 2026-07-08

### Fixed

- **The "Who's spying on you" panel is back on the messages page.** Newer
  AntiGame builds stopped injecting the overview element the panel anchored
  to, so it silently vanished. The panel now mounts on the game's own message
  list whenever the espionage tab is open — AntiGame is no longer needed for
  it to appear (when AntiGame's overview IS present, the panel keeps its old
  spot right above it). It also shows up on an empty espionage tab now.

## [1.40.1] — 2026-07-08

### Added

- **Server map: "🛡 Protected" toggle.** The Occupancy view can now hide
  admin/vacation/banned slots, so farms and threats pop instead of drowning in
  protected clutter. The legend follows the toggle.
- **Hide individual FAB buttons.** The Colonize module can be switched off in
  the dashboard's Big Colony Hunting ⚙ settings, and the Expeditions module in
  Settings ▸ Expeditions — each hides that button (and its orbit orb) without
  touching the rest of the floating button.
- **The Spy button now pulses while there is something to scan** — the same
  gentle attention glow the Fleet reminder uses. It stops the moment the scan
  plan empties or a send takes over the button.

### Changed

- **The Spy button went gold.** One pale-gold family across idle / loading /
  Look / armed / done — the eye node, rim and glow finally agree in every
  state — with the shared FAB red for errors. The champagne shade is
  deliberately lighter than the Fleet reminder's orange so the two buttons
  never read as siblings. The messages-page "Who's spying on you" panel wears
  the same gold accent.
- **Spyglass tab decluttered.** The header freshness chips are gone; the
  "planets to scan" button and its ranked preview are gone too — the scan
  settings now sit as an always-visible footer bar of the Watchlist card, with
  labels that explain themselves: "Probes per scan" (the number of espionage
  probes sent), "Re-scan probes after N h", "Re-look galaxy after N h".
- **Watchlist and "Who's spying you" cap their height** and scroll inside, so
  a long list never pushes the Players table below the fold. "Who's spying
  you" now shows the last 30 days.
- **The whole-player re-scan ↻ moved into the dossier's "Watch via" row**,
  right next to the probes toggle it flags for — and shows only while probes
  are on.
- The ⚙ Filters toggle shows a pressed state while its panel is open; the
  map's system card says "Free positions:" instead of a bare "Free:"; the two
  "moved to the dashboard" signpost paragraphs left the in-game settings panel.

### Fixed

- **No more colonization proposals in galaxies that don't exist.** Stale
  out-of-grid leftovers in the stored scan data (e.g. galaxies 8–9 on a
  7-galaxy server) are now ignored — the server's own API data defines the
  real grid, so phantom "fully free" galaxies stop topping the rankings.

## [1.40.0] — 2026-07-08

### Added

- **Your watch list now follows you across devices.** With cloud sync on, the
  starred players, relationship tags, probe/galaxy watch toggles, map mutes,
  the planets/moons filter and the re-scan cadence ride the same private gist
  as the rest of OG-E's sync — star a player on the desktop and they're on the
  laptop. Un-starring propagates too (no resurrection by the other device);
  the most recent edit wins; the per-device knobs (probe count, one-off
  re-scan flags) deliberately stay local.
- **Export JSON grew from 2 to 13 datasets.** The dashboard backup used to
  carry colony history and galaxy scans only. It now also includes the watch
  list, spy reports, proximity alerts, the galaxy-activity history (the
  presence heatmap's memory — the one thing a new machine can never
  re-observe), watched players' profiles, alliance classes, your own planet
  list, colonization decisions and the three synced configs. Old export files
  still import, and the import summary now lists exactly what each dataset
  gained. Tokens and sync internals never enter the file — an export is safe
  to hand to another person.
- **Watch passively from the galaxy view.** Browsing a system records the
  activity markers of every watched body in it — no probes, no espionage-log
  entry, nothing the target can ever see. The spy FAB now proposes the best
  next intel action of BOTH kinds: probe a body, or "Look" — one tap opens the
  single system whose watched bodies most need a sighting (one visit covers
  them all). Each dossier has a "Watch via" control to mute galaxy proposals
  or probes per player, independently.
- **Presence heatmap.** A dossier now distills your own galaxy looks into an
  hour-by-hour picture of when that player tends to be around — with
  confidence drawn as its own axis (an hour you never observed reads as
  unknown, never as offline) and the best-covered quiet window framed. It
  measures observed activity, not "online", and the wording keeps that honest.
- **Fleet-landing "strike" flag.** When exactly one of a watched player's
  bodies lights up, it is a MOON, and every other body you have recently seen
  is quiet, OG-E flags a likely fleet-save landing: a 🎯 marker in the
  dashboard and a hot "Strike" spy FAB that jumps that moon to the top of the
  scan plan. Always a candidate to confirm with one probe — never an
  auto-action.
- **Honour ranks in the Galaxy Viewer.** Occupant bands now read the honour
  rank straight from the API markers, and a "Normal" band sits between the
  outlaw and honoured tiers so ordinary players stop inflating either count.

### Changed

- **One re-scan cadence.** The hot/warm/cold danger tiers collapsed into a
  single "re-scan after N hours" knob plus a galaxy-sighting cadence — the
  same behaviour with two numbers instead of four.
- **The activity column tells the truth.** A body's "last active" now derives
  from positive markers' implied interaction time — a quiet look reads as
  "inactive ≥1 h at that look", never as fresh activity — and markers caused
  by your own probes are discounted instead of being counted as the target's
  activity.
- **The player cache no longer grows forever.** Player records not seen in any
  galaxy view for 60 days are swept on load; watched players are exempt, so
  dossiers keep their names and ranks indefinitely.

## [1.39.1] — 2026-07-06

### Added

- **Alliance combat class now lights up without spying.** 1.39.0 read a warrior-class
  alliance only from a spy report, so strong players you hadn't scouted sat one signal
  short of "apex". OG-E now harvests each alliance's class straight from the in-game
  alliance ranking — open it once and every alliance on the page is captured — so the
  "warrior alliance" signal fires for any member, no scouting needed. A Spyglass banner
  and a per-card hint flag watched players whose class isn't known yet, each deep-linking
  to that alliance in the ranking so one click fills it in.
- **Galaxy links in the dossier.** Every body coordinate in a player's scan table
  (e.g. `4:474:8`) is now a link that opens that system in the in-game galaxy view.

### Changed

- **Fleet-return alarm clock — fair-play caution.** The Alarm clock tab now carries a
  clear notice: a fleet-return alarm clock has no official public ruling from Gameforge
  yet, so it is borderline and should not be used on public servers until it is publicly
  confirmed. Use at your own risk.

## [1.39.0] — 2026-07-06

### Added

- **"Who's spying on you" moved onto the messages page.** The defensive digest that
  used to hide in the small AntiGame sidebar now sits at the top of the spy-report
  tab (Szpieguj), above AntiGame's own spy overview — a compact, scannable table of
  who's been probing you, with a one-click jump to each prober's full dossier in the
  dashboard. More room, right where you review espionage.
- **Spot gap slider (Galaxy Viewer).** A new control beside Offline / Farm reach sets
  the minimum distance between listed spots — spread proposals out across the server,
  or pack them tight around one hotspot. (Greys out under "Longest streaks".)
- **Alliance combat class feeds Danger.** A warrior-class alliance (combat bonuses)
  now reads as a capability tell — a few extra Danger points and an "apex" signal.
  Sourced from spy reports, since the public API doesn't expose it.
- **Moon scan coverage.** Moons count as their own spiable bodies everywhere: the
  coverage readout splits planets vs moons, and each moon has its own re-scan flag
  (gated by the Scan planets / moons / both chip).

### Changed

- **Galaxy Viewer is no longer "experimental".** A terse header with data-freshness
  chips (snapshot age · last checked · calibration) replaces the wall of text, the
  noisy "Context" tile is gone, and bandits / honoured fighters are split per honour
  tier (Bandits ! / !! / !!! · Honored ★ / ★★ / ★★★), each a distinct-player count.
- **Spyglass laid out in cards**, matching the Galaxy Viewer: Watchlist,
  "Who's spying you", the positions map and the players table each get their own
  panel. Clicking a player row now turns that row INTO the dossier's header — same
  colour, no duplicated name.
- **Scan intel, made legible.** The cryptic per-planet stat line is now a labelled
  table — def / fleet / loot in aligned columns, with an indented moon row per slot
  (its own scan age + parked fleet, flagged gold when found). Coverage reads at a
  glance: 17/17 planets · 12/17 moons · to scan: 5 moons.
- **The Ships column tells the truth.** res/ship is now measured on the FLEET
  estimate, not raw military — so a bunker farmer's cheap transporters no longer read
  as "28K · combat" while the dossier (correctly) said cheap hulls. One number now,
  consistent everywhere.
- **Plainer wording** across Danger / verdicts — game vocabulary instead of model
  jargon ("14.2M fleet × 0.34 combat quality", "mostly transporters/probes",
  "needs a real fleet to attack") — and the reassuring civil-baseline verdict is now
  green.
- **Daily Run collect options are chips** now, matching the Spyglass Scan control:
  Deployment / Transport · Most / All.
- **Positions map:** each galaxy row carries a visible band, so the galaxy divisions
  read at a glance.

### Fixed

- **Empire / standalone pages stay clean** — the floating OG-E button and the
  "install AntiGameReborn" banner no longer appear on `?page=standalone` views.
- **Spyglass FAB:** tapping it while it still shows "loading…" no longer fires a
  stray action (and the generic errors that followed); "Sent!" now greys out like the
  other busy states.
- **Deep-links always land on a row.** Opening a player from a watchlist card, the
  "who's spying" table or a map chip now shows their row even when the top-N cap or a
  filter would have hidden it (appended with an "outside the cap" note).
- **Apex signals could read "5/4"** — the count and its denominator now stay in step
  (out of 6).
- **Galaxy Viewer census** no longer shows a permanent "0 Honorable" or a collapsed
  bandit count — both are split per honour tier.
- The 💀 "scout in your system" legend only appears when there's actually a
  same-system prober to explain.

## [1.38.1] — 2026-07-06

### Added

- **Refresh Spyglass data on demand.** A new **⟳ Refresh** button in the Spyglass
  header pulls the latest public-API data — Danger, mobile-fleet estimates, the
  positions map — for the selected universe straight from the dashboard, so you no
  longer have to hop back into the galaxy view just to freshen it.

### Changed

- **Spyglass controls, tidied into one row.** Left to right: search · 🗺 map ·
  🧭 planets to scan, with **⚙ Filters** and the row cap (top 50 / 100 / 200 /
  all) grouped on the right. The old "N targets in range" caption is gone (the row
  cap took its place), the Filters panel now opens full-width, and the **Probes**
  count moved into the *planets to scan* panel where it belongs. The Intel column
  is centred, and the header's "?" help was dropped.
- **"Planets to scan" is always available** — it no longer disappears when nothing
  is queued; the button opens a panel with the Probes count and the ranked order.
- **Hide your own planets on the map.** Click the **You** chip in the map legend
  to toggle your planets off/on, the same way the watched-player chips already mute.
- Watchlist cards dropped the redundant ▸ — the whole card already opens the
  dossier, so only the ✕ (remove) remains.

### Fixed

- De-jargoned a Danger reason: "FS spot amid spread (aggressor tell)" now reads
  simply "FS spot amid spread".

## [1.38.0] — 2026-07-05

### Changed

- **A smarter Danger score.** The whole-server threat rating was overhauled so
  far fewer players pin at a meaningless 100/100. Danger is now an *absolute*
  reading — where a player sits on the server's real combat-fleet ladder — so the
  top few percent spread across ~90–100 instead of everyone at the ceiling, and a
  fresh colony no longer reads half the server as maximally dangerous.
- **Cheap fleets stop masquerading as war fleets.** Danger and the civil-fleet
  baseline now read the free composition tell — resources-per-ship on the *fleet*
  (defence excluded) — so a hoard of small transporters or probes is scored as the
  logistics swarm it is, not a combat armada. Once you spy a player, their known
  defence is subtracted and the estimate re-settles lower for defensive farmers.
- **Aggression is read from position, not just points.** A player who scatters
  planets tactically across a few galaxies (with a tight fleet-save pair amid the
  spread) reads as a real hunter; a defensive cluster reads as a builder — even at
  the same military score.
- **"Destroyed" is gated by real fleet.** A mega-bunker earns destroyed points
  defensively (its walls eat attackers), so that history now counts as aggression
  only in proportion to the player's actual combat fleet — a turtle no longer
  reads as a predator.

### Added

- **Loot tracking.** For watched players, each planet now shows its average and
  peak loot from your scan history, and the **hoard ("mother") planet** — where a
  collector funnels their daily income — is flagged 🏦. The raid verdict now also
  weighs **defence**, so a fat-but-walled hoard reads "loaded · heavily defended"
  instead of just "fleet risk".
- **Composition and rank at a glance.** The Ships column bands resources-per-ship
  (civilian / combat / defence-inflated); the player and Military columns show
  overall and military highscore rank.

### Fixed

- The raid-verdict line was de-jargoned — no emoji, no confusing "confidence"
  tag, and it now spells out *why* a target is risky.
- Spyglass layout polish: the positions map opens above the control row; the
  "who can reach you" and "You" markers match the watched-player chips; player
  search comes first; the galaxy map draws its lines at system boundaries; the
  watchlist card gained an open-dossier control and a clear red-✕ remove; and the
  data-freshness chips moved onto the title line.

## [1.37.0] — 2026-07-05

### Changed

- **Spyglass gets a clarity pass.** The tab now opens with a one-line summary
  instead of a paragraph — the full explanation moved into a **"?"** popover — and
  the filter row became **chip buttons** (hide inactive · in range · scan list ·
  top-N), matching the Galaxy Viewer. The rarely-touched military-score range and
  probe count tuck behind a **⚙** button. Less to read, the same controls.
- **Watchlist cards are the new landing view.** Above the finder table, each
  watched player now shows as a card that answers the one question in words —
  **raid or skip, and the loot** — with the headline fleet number, an hour-of-day
  activity sparkline, and how fresh your intel is. Click a card to open the full
  dossier. The table is still right below for browsing the whole server.
- **Average resources-per-ship is now a column, not a tooltip.** The Ships cell
  shows it as a second line, colour-tiered so a cargo/probe **swarm** (thousands
  per ship) reads differently from a **capital-ship** fleet (tens of thousands) at
  a glance — the fleet-composition tell you needed without hovering.
- **"Who's been near you" is now a digest.** Instead of a flat list of every raw
  scan alert, it groups by player (how many times, when, from where) and **flags a
  prober in your own system** — a fleet parked there reaches you fast even at
  Deathstar speed. Live counts show in the collapsed header; each row offers a
  one-click **watch** and a jump to the dossier; the raw log is still one click away.
- **The dossier reads in two columns** on a wide screen — the raid judgement beside
  the planets and routine, instead of one long scroll.

### Added

- **Manage the positions map right at the map.** Every watched player is a chip
  under it: a coloured dot for their **relationship** (click to cycle enemy →
  friend → neutral), their name (opens the dossier), an **eye** to hide them from
  the map without un-watching, and an **✕** to stop watching. Starring a player now
  places them on the map immediately — no more wondering how a player gets on or
  off it.

## [1.36.0] — 2026-07-05

### Added

- **The routine tracker now fills from the galaxy view, not just spy reports.**
  The activity markers you already see while browsing the galaxy (colony hunting,
  checking systems) now feed a watched player's **hour-of-day activity** — a far
  denser source than the handful of reports you open, for zero extra probes. It
  stays honest: a marker your **own probe** caused is excluded (so the tool never
  measures its own scanning rhythm), the dossier names how many samples came from
  each source, and "activity" still means a body was interacted with — never
  "online".
- **Suggested scan order.** A new strip on the Spyglass tab ranks your scan list
  by danger × how stale your intel is, with a small nudge when a target's observed
  active window is open right now. The in-game **Spy** button proposes the same
  order — so what the dashboard lists first is exactly what the button offers next.
  It stays one deliberate tap per probe; the strip has no send button of its own.
- **Probe pre-flight on the Spy button.** On the fleet screen the button now shows
  whether the current planet actually has enough probes for the scan — an early
  "No probes!" or an "N/20 probes" hint — instead of only discovering a shortage
  when the send fails.
- **"Who can reach you" overlay** on the positions map (opt-in): rings every
  tracked body close enough to land on one of *your* planets within 8 hours at
  Deathstar (RIP) speed. Deathstar is the slowest attacker, so the ring is the
  conservative floor — anything faster arrives sooner.

### Fixed

- **The Spy button's "No probes!" label now shows in every empty-hangar case**
  (it previously caught only one of the two internal outcomes, so a plain empty
  hangar showed a raw error instead).
- **Old re-scan flags are cleaned up** on load — a flag old enough that any report
  it would mark is already stale on age alone is dropped, so they no longer pile up.

## [1.35.0] — 2026-07-04

### Added

- **Spyglass becomes a "Watchlist Workbench".** The whole-server discovery wall
  gives way to a focused, per-player intelligence view built around one question
  per target: **raid or skip, and when**. The finder table shrinks from 14 columns
  to 7; clicking a player opens a full dossier.
- **Per-player dossier.** One panel stacks a glanceable **raid verdict + loot
  estimate** (the go / no-go at the moment you decide), the honest **mobile-fleet
  interval** (a bounded low→high range, never fake-precise), the danger reasons,
  the hidden-fleet subtraction, a per-planet scan grid, and a **civil-fleet
  baseline** (economy → expected civil ships → the combat surplus over it, shown
  as a weak upper bound, never fed into the danger score).
- **Routine tracker.** From the spy reports you open over time, the dossier shows
  a player's **hour-of-day activity**, **weekday resource pattern**, **collection
  planet**, and a **spy-history timeline** — every line sample-gated and labelled
  with its coverage, so it only ever claims what you actually sampled ("activity"
  means a body was interacted with, never "online").
- **Spyglass positions map.** A dedicated attack-planning / player-tracking map:
  your planets and your watched players' on an otherwise-empty grid, coloured by a
  **relationship** you tag per player (enemy · friend · neutral; you are white)
  and sized by danger. Click a marker to open that player's dossier. The
  colonization occupancy map stays in the Galaxy Viewer.
- **Find any player by nickname** — including ones the filters hide, each with the
  reason why and a "show anyway" override.
- **"Who's been near you"** — a defensive strip listing who has scouted your
  planets recently, and from where.
- **Partial and moon spy reports are now kept.** A low-probe "just the loot" scan
  or a moon scan is no longer discarded — the loot number it carries is often the
  decision-relevant fact — while the hidden-fleet coverage stays honest (a moon is
  a second spiable body, and a section a scan didn't reveal is never read as zero).

### Changed

- **Spyglass reads far more out of each spy report** — on-planet resources, the
  real plunder %, all four highscore axes, character class and mine levels — which
  feed the loot estimate and the civil-fleet baseline.
- **Spy-report history is remembered per watched player** (a bounded ring) instead
  of each report overwriting the last, so the routine tracker has a record to read.
- **Danger colours are unified** across the Galaxy Viewer and Spyglass (one shared
  palette; the two had drifted apart).

### Fixed

- **The Galaxy Viewer → Spyglass link no longer silently does nothing** when the
  player is filtered out of the current view — it opens their dossier directly.
- **Re-opening the same spy report no longer churns** the dashboard (an
  identical-timestamp re-read is now a no-op).

## [1.34.0] — 2026-07-04

### Added

- **Per-player danger scoring.** Every occupant on the map and in the analyzer
  now carries a single Danger score that separates a harmless defensive whale
  from a real aggressor. It reads the whole-server military highscore's *ship
  count* (0 ships = cannot attack, whatever the point total) and the lifetime
  *military-destroyed* history (kills only combat produces), bounded — never
  fake-precise — and leant by bandit rank and planet dispersion. Fully-spied
  players collapse to their exact fleet (military − known defence). Your
  alliance and buddies are excluded outright.
- **Spyglass — a whole-server hidden-fleet finder.** The Colonizations tab's
  target list gains Danger and Fleet columns and sorts by Danger by default,
  turning espionage reports into a ranked read of who is actually dangerous and
  where the loot is. Two-way deep-links tie the map and Spyglass together:
  click a threat on the map to find the player in Spyglass, and back.
- **"Top threats" panel** in the Galaxy Viewer census, summarising the
  highest-danger occupants in view.

### Changed

- **Galaxy Viewer control refresh.** The view / zone / find selectors are now
  chip groups in a single config card, the Field and Occupancy maps render at
  equal height, region rows expand inline instead of jumping to a panel at the
  bottom, and the census is grouped for a faster read.
- **API freshness is now a two-clock model with per-feed resilience.** The
  public-API feeds (now including economy, destroyed, and lost) refresh
  independently — one feed failing no longer aborts the whole refresh — and a
  universe regeneration re-fetches automatically.

### Fixed

- **Spy-report timestamps were off by a factor of 1000** (seconds vs
  milliseconds), which could misorder or misdate reports; report times are now
  normalised to a single unit.
- **A mid-flight expedition recall could schedule a duplicate set of return
  reminders.** When a recall split one live wave's returns across the 5-minute
  clustering gap, the tail half was mistaken for a brand-new wave and given its
  own reminder schedule (and could even cancel the original). The wave is now
  re-unified before matching, so one wave stays one wave.

## [1.33.0] — 2026-07-02

### Added

- **Daily Run's "Send All" (collect) zone is now configurable per universe.**
  Pick the Mission (Deployment — stay, or Transport — drop & return), how many
  Ships to send (Most, leaving a reserve — the new default, or All), and how
  much of the Resources to load (Most or All) from the Daily Run tab's Settings
  panel. Each choice saves instantly, no extra step.
- **"Galaxy Viewer" — a new server map + zone analyzer, replacing the old
  "Scanned data" tab.** A black-background temperature map plots the whole
  server in either a **Field** view (red = threat pressure within your Offline
  window, gold = farm value within your Farm reach — a smooth, strategy-
  independent read of where danger and loot concentrate) or a sharp
  **Occupancy** texture (every planet slot, coloured by status); click any cell
  to jump to that system in-game. Below it, pick a **Zone** — Safe zone, Farm
  hub, or PvP zone — and a **Find** mode — Best spots (rates the neighbourhood
  around every free-slot system) or Longest streaks (hunts contiguous fully-
  free runs) — and every candidate gets a single 0–100 **Fit** score, broken
  down into safety / farm / streak / target channels in its tooltip so the
  ranking explains itself. The Offline-window and Farm-reach sliders now drive
  both the map and the ranking together.

### Changed

- The six ranking presets (Peaceful, Safe expansion, Farmer, Honor/PvP,
  Aggressive, Longest streak) are superseded by the Zone + Find pair above —
  a saved preset preference is auto-migrated to its closest zone/find
  equivalent, so nothing resets silently. "Colony Scout" is renamed **Big
  Colony Hunting** to make room for the new Galaxy Viewer sub-tab.
- The settlement-region detail panel's "Ignore worst" now re-reads the map's
  own threat field with the dropped players actually removed, instead of a
  flat score penalty — so excluding a bandit measurably raises the area's
  safety read, not just its ranking.

## [1.32.0] — 2026-07-02

### Added

- **Neighbourhood strength at a glance — average points on the region detail.**
  The settlement-region panel gains two stat cards built from the server's
  public highscore data: **Avg points** (mean total score of the neighbours in
  range — higher = a stronger area to think twice about settling in) and
  **Avg military** (mean military points — where the fleets actually
  concentrate). Shown automatically when API data is available; no extra
  scanning needed.
- **New "Safe expansion" strategy for ranking regions.** It rewards regions
  whose neighbours are ranked *below* you — settle where you out-rank the
  locals — alongside free slots and inactives, and penalises areas whose
  residents out-rank you. The same rank-relative signal also feeds the
  per-system heat strip, so a system full of weaker neighbours reads greener.
  Uses your own highscore rank, which OG-E already knows.

## [1.31.2] — 2026-06-28

### Fixed

- **The Expedition button no longer "eats" a tap when sent quickly.** At high
  send volume an eager tap could land while AGR was still filling the fleet and
  the game's Send control was momentarily disabled. The button used to report
  "Sent!" and lock for a moment without actually launching anything, so you had
  to tap a second time. It now waits out that brief disabled window and fires as
  soon as the control is ready — one tap reliably sends one expedition.

## [1.31.1] — 2026-06-27

### Fixed

- **The Colonization button no longer flickers or misfires around a send.** Just
  after you hit Send it could briefly flip back to an unlocked, wrong-looking
  state before the page reloaded — it now stays locked through the reload, the
  same way the Expedition button does. And immediately after a reload it could
  read "No more candidates" before its data had finished loading; it now waits
  for the page to be ready (like the Daily Run button) before showing a target,
  so an early tap can't trigger that false message.

## [1.31.0] — 2026-06-26

### Added

- **New "Spyglass" tab — find who's hiding their fleet.** A universe-wide board
  of active players ranked by military points, with an estimate of how much fleet
  each one is *hiding* (their military score minus the defence and visible fleet
  you've actually spied). The estimate is broken out into **Defence / Visible /
  Hidden** columns, with **Coverage** (how many of their planets you've scanned)
  and **Scanned** (how fresh your intel is — green when recent, amber when older
  than a week). Open a player to see their planets laid out in a responsive grid:
  each one shows when it was last scanned plus the defence and fleet found there,
  or "needs scan" if you've never looked. Built-in filters let you set a military
  range, widen or switch off the noob-protection band, and include vacationing /
  inactive / banned players — so you decide who shows up instead of OG-E hiding
  them silently.
- **One-tap espionage scanning from in-game.** Hit **+ scan** on a player to drop
  them onto a new floating **Spy** button that appears in-game only when you have
  targets to scan. Each tap sends espionage probes to that player's next planet
  (un-scanned, or stale, or one you flagged) and steps to the next — you press
  send each time, nothing is automated — and once everything's scanned it offers
  a jump to your messages to read the reports. Use **↻** in the dashboard to mark
  a player or a single planet for a re-scan when you think their fleet has moved.

### Changed

- **Colony Scout's top-region summary is now a row of stat cards.** The dense
  one-line readout (active / farmable / vacation / bandits / honoured / nearest
  colony …) became colour-coded cards — the same look as the "Scanned data" tab —
  with threats in red/orange, farm value in gold/green, and bandits broken out by
  tier (King / Lord / Bandit). Hover any card for the detail.
- **Multi-device sync is quieter and faster.** OGame reloads the page on every
  click, and the old sync re-checked the cloud on each load and polled every few
  minutes — wasteful, and with two tabs open it could burn through the request
  quota. Now a tab only pulls when something actually changed (a sibling tab or
  device left a marker, or you've been away a while), and two tabs on the same
  machine sync the instant one of them writes — with no extra network calls. Your
  explicit "Sync now" and the dashboard's clear/tombstone still force a full
  round-trip.

## [1.30.13] — 2026-06-25

### Added

- **Colony Scout now tells you WHO sits on an occupied position, not just
  "Occupied".** Active neighbours are classified by the game's own
  noob-protection brackets — **Weak** (protected, can't be honourably raided),
  **Honorable** (a fair fight that earns honour) or **Strong** (out-guns a fresh
  colony) — and the dot in the system card is tinted to match. Players the game
  hasn't classified, or systems you've only seen via the API (never scanned
  in-game), stay "Occupied". Each settle area also gets a **🎯 Targets** line —
  e.g. *2 honorable · 1 weak · 3 strong* — so you can pick a spot next to the
  neighbours you actually want.

### Fixed

- **An auto-detected fleet-save more than 3 days out is no longer unreadable in
  the event list.** It used to paint a solid amber fill and dim the cell, hiding
  the arrival timer underneath (black-on-black); it now shows a light dashed
  frame, so the countdown stays legible while still flagging "detected, will arm
  within 3 days".
- **The planet-marker legend (the "?" hover) no longer hides behind the page or
  overflows its box.** It now opens above everything else no matter which side it
  appears on, its rows wrap instead of spilling out (room for future
  translations), and the longest entry was shortened to "Fleet reminder — landed
  fleet".

## [1.30.12] — 2026-06-25

### Changed

- **Clearer wording across the alarm clock / reminders.** Every reminder is one
  *you* set the moment you send a fleet — for a return time the game already
  shows you — and it rings on your phone like an alarm clock; OG-E never watches
  the game while you're away. The dashboard now says so plainly: "Currently
  queued" → **"Reminders set"**, "Fires at" → **"Rings at"**, and the badge
  states read **set / armed / rang** instead of queued / fired / scheduled. No
  behaviour change — only the labels.
- **The landed-fleet watch is now "Fleet reminder" (FR) — the counterpart to FS
  (Fleet save).** A fleet is safe while flying (FS); once it lands it sits
  exposed, so the planet marker and the in-game button now read **FR**. The
  landed marker is brighter and pulses harder, so an exposed fleet is easy to
  catch at a glance.
- **The in-game "mark this fleet" button moved into the empty ship tile next to
  the espionage probe.** It used to sit above "Continue", where — without a
  Fleet Admiral — it crowded that button and shrank it. Now it fills the unused
  grid cell, shows a lighthouse icon and a steady **"Set FR"** label, and lights
  up when active.
- **A few toggles renamed** so they no longer read as "alarms": the event /
  Merchant menu-pulse options are now "highlight", matching what they actually
  do (in-tab emphasis, never an off-device notification).

## [1.30.11] — 2026-06-24

### Changed

- **Colony Scout: the play-style strategies now analyse the AREA around a colony
  spot, not just a slot streak.** Picking Peaceful / Farmer / Honor PvP /
  Aggressive switches to a new control set: a **Radius** slider (how far left and
  right of the spot to weigh the neighbourhood) and an **Ignore worst** option
  that drops the N most stat-ruining neighbours from the score — e.g. a top-tier
  bandit ranked far above you — so one outlier no longer condemns an otherwise
  great area (you'll just avoid that single system). Longest streak is unchanged
  (Slots + Tolerance).
- **Colony Scout: the result strip is now coloured by your intent.** Each system
  is tinted red → grey → green by how well it fits the CURRENT strategy and its
  weights (a super-aggressor reads red under Peaceful; farms read green under
  Farmer), instead of by raw status. Move the weight sliders and the map
  re-tints live.
- **Colony Scout: the table is interactive.** Click any row to inspect that
  candidate below (top row selected by default). Hovering a system pops a
  friendly card with its occupants, ranks and free slots; click a cell to pin
  it. Systems are clearly separated and the colony spot is ringed.
- **Colony Scout: clearer neighbour read-out.** The "Nbrs" tooltip now always
  spells out the bandits (with tier), strong/active players, honoured fighters
  and **how many neighbours out-rank you** — the headline danger for a fresh
  colony.
- **Banned players are treated as an eternal vacation.** A banned account can
  never attack, so it no longer counts as a bandit, a strong threat or a
  "ranked above you" danger anywhere in the Scout — it's folded into the
  protected/vacation tally instead.
- **Scanned data: clearer per-position stats.** Dropped the confusing "systems
  scanned" coverage number (with the full map it was always ~100%) and added a
  heading that names the position the counts are for — so "Mine: 3" reads as
  "3 of my colonies on slot 8", not "I only have 3 colonies".
- **Alarm clock settings tidied.** The "Enable alarm clock" switch now lives
  inside the token box (like the sync panel), and the topic hint points at the
  token field right above it.

## [1.30.10] — 2026-06-24

### Changed

- **Event box: bigger, lower countdown.** The time-to-next-event number is a
  touch larger and sits slightly higher in the card, with a bit more breathing
  room above the mission-count row.

## [1.30.9] — 2026-06-24

### Changed

- **Fleet-movement status link: consistent font across devices.** The Fleets /
  Expos counts now render in the same width on the phone as on desktop. They
  used to inherit OGame's wide Verdana, which only exists on desktop — on
  Android the text fell back to a much narrower font and looked shrunken. The
  counts are also a touch larger and wider, with a lighter, borderless card.
- **Fleet-movement status link: no more wrapped second step.** After preparing a
  fleet-save, the count box is no longer squeezed into a fixed narrow width that
  pushed the text onto extra lines and hid it behind the panel below — it now
  sizes to its content like the first step.
- **Notification bar: same cross-device font.** OGame's notification bar now
  uses the same device-consistent typeface, so its text reads the same on phone
  and desktop.

## [1.30.8] — 2026-06-24

### Changed

- **Fleet-movement status link: readable "capped" red.** When a slot count is
  full (e.g. expeditions 15/15), the red now reads as a vivid, high-contrast
  red instead of AGR's pale salmon — it was washing out on the dark card,
  especially on small phone screens. The digits also gained a subtle shadow so
  they stay legible over whatever shows through the card, and the text no longer
  auto-rescales on mobile browsers.
- **Fleet-movement status link: bigger, cleaner.** The Fleets / Expos counts are
  larger and easier to read, and the box dropped its border and rounded corners
  for a flatter, less boxed-in look that sits flush in the header.

## [1.30.7] — 2026-06-24

### Changed

- **Fleet-guardian button: progress arc.** A ring on the button now fills up
  over the configured ACK interval (default 3 minutes). When the arc reaches
  full, the orange pulse fires — a heads-up that "You here?" is active before
  the alert escalates. Tapping the button resets the arc to zero.
- **Fleet-guardian button: "hold to skip" / "Send FS".** The hold hint now
  reads "hold to skip" instead of "hold to dismiss". The ready-to-send state
  reads "Send FS" instead of "Save now".
- **Help chip (?) positioning.** The badge-list help chip is now positioned
  closer to the header row so it no longer overlaps planet-list content.

## [1.30.6] — 2026-06-24

### Added

- **Your manual fleet-save marks now sync across your devices.** Marking a
  landed fleet as a fleet-save on one device now shows up on your others through
  your own private cloud-sync gist. Unmarking or re-saving propagates too, so a
  mark you clear on one device won't reappear from another.

### Changed

- **"Reminders" is now "Alarm clock", and the under-attack feature is the in-tab
  "threat highlight".** The naming everywhere now matches what these features
  actually are: an alarm clock you set for times you already know from your own
  actions, and a louder rendering — inside the open tab only — of the attack
  state the game already shows you.
- **OG-E now does nothing while its tab is hidden.** When you switch tabs,
  minimise, or (on mobile) leave the app or lock the screen, OG-E stops reading
  the game entirely — no event-list scanning, no re-checks, no background
  observers — and picks back up the moment you return. Lighter on battery, and
  it never looks at the game while you're away.
- **Fleet-guardian button wording.** Its states now read "You here?" / "Fleet
  save" / "Snoozed" / "Save now" — clearer, and making plain the button is your
  own prompt, not the game being watched.
- **Daily Run button polish.** The two labels are nudged toward centre, and its
  "waiting for the event list" state no longer shows a gold pulsing ring, so it
  matches the other command buttons.
- **Settings copy.** The Colonizations settings no longer mention a "Scan
  button" / re-scan removed back in 1.30 (free positions come from OGame's public
  API now); the Alarm clock settings now spell out that OG-E never watches the
  game while you're away.

## [1.30.5] — 2026-06-22

### Fixed

- **Reminder bookkeeping is no longer occasionally lost during rapid in-game
  activity.** Two reminder syncs that overlapped — e.g. clicking quickly while
  one was still talking to the cloud — could each save their own view of your
  scheduled pushes, the later one silently overwriting the other's. Reminder
  syncs now run strictly one at a time, so nothing is dropped.

- **First-time cloud-sync setup can no longer create a duplicate sync file.** On
  a fresh device the cloud-sync engine and the reminders engine could each
  create their own GitHub gist at the same instant, orphaning a copy. They now
  coordinate so exactly one is created (and converge on the oldest if two ever
  existed).

### Changed

- Internal hardening with no user-visible behaviour change, listed for
  source-review transparency: the sync scheduler is now table-driven (one slot
  registry instead of eight hand-unrolled copies), the in-game `?page=ingame`
  URLs are built from one shared helper, and the galaxy-view reader plus the
  reminder-list section headers are de-duplicated. Plus opt-in test-coverage
  tooling and a few dead-code/release-script cleanups.

## [1.30.4] — 2026-06-22

### Fixed

- **Two devices left open at once no longer burn through the GitHub sync quota.**
  The periodic cross-device sync backstop used to run a full download+upload
  every minute. With two tabs open, each tab's upload looked like a remote change
  to the other, so the two devices ping-ponged and could exhaust GitHub's
  5000-requests/hour limit between them. The backstop is now a **download only**,
  every 5 minutes and paused while the tab is hidden — so an idle tab stays quiet
  and two open devices can't trigger each other. Refocusing a stale tab still
  pulls a peer's changes immediately.

- **The GitHub rate-limit backoff now survives a page reload.** OGame reloads the
  page on every fleet send; a fresh page used to forget that GitHub had asked us
  to back off and retried right away, compounding the rate-limiting. The backoff
  deadline is now persisted (and shared across same-origin tabs), so a 403/429 is
  respected until it actually expires.

## [1.30.3] — 2026-06-21

### Changed

- **You now pick the Import/Export reminder mode instead of OG-E guessing it.**
  The red Import/Export glow used to try to auto-detect the occasional "import
  refreshes 6× today" event from an inbox message — which proved unreliable.
  OG-E now shows two mode chips at the top of the Import/Export page: **1×/day ·
  from 14:00** (the normal once-a-day import, the default) and **6×/day · every
  4 h** (the event cadence on the 00/04/08/12/16/20 slots). When a recent "6×
  today" message is seen in your inbox OG-E flips you into 6× automatically;
  switch back to daily yourself when the event ends. The choice is per-device
  and is not synced.

- **An exposed ("bare") fleet-save now keeps nagging until it is actually safe.**
  The orange **"FS"** planet marker for a fleet that landed and sits exposed used
  to disappear on its own after two hours. It now stays — on the planet markers
  and the floating guardian warning — until that fleet re-saves or leaves the
  body, or you dismiss the landing yourself. No more silently going dark on a
  fleet you forgot about.

### Fixed

- **The "Mark FS" chip no longer vanishes from the fleet-dispatch form.** It is
  now pinned next to the **"Dalej"** / continue button in a spot that AGR's live
  cargo- and coordinate-refreshes do not wipe out, so it stays put while you set
  up a send.

- Dashboard sync inventory now labels the **API cache** and **Colonization
  decisions** categories (previously shown by their raw storage keys).

## [1.30.2] — 2026-06-21

### Fixed

- **Fleet-guardian reminders now appear in the dashboard.** When the guardian
  queues a phone push for an exposed ("bare") fleet, that push is now listed in
  the reminders preview under its own **"Fleet guardian reminders"** heading —
  with the fire time and the fleet's coordinates — alongside your expedition,
  ad-hoc and fleet-save reminders. Previously the push was queued on ntfy but
  never shown there.

## [1.30.1] — 2026-06-21

### Fixed

- **Colonization decisions now reliably reach your other devices.** A position you
  blocked on one device — a colonizer you sent (even one you sent and recalled) or
  a target you skipped by hand — could fail to register as taken on another device,
  so the two disagreed on how many free positions were left. OG-E now pushes these
  decisions right after a page loads instead of only after a quiet pause — the
  game reloads the page the instant you send a fleet, which used to cut that pause
  short and drop the update. An already-open game tab now also re-syncs on its own
  about once a minute and the moment you switch back to it, so a second device
  catches up on its own without a manual refresh.

## [1.30.0] — 2026-06-21

### Added

- **Colonization now sees the whole universe, not just what you've scanned.**
  OG-E reads OGame's public statistics API for the current universe and
  composites that server-wide occupancy with your live galaxy scans, so the
  colonize button knows which positions are actually free everywhere — not only
  in systems you happen to have scanned. A live **"N free"** sub-label shows how
  many target positions remain open across the entire universe (your configured
  slots in parentheses), and it updates the instant you send or skip one. Each
  target is re-confirmed against the game the moment you arm a send, and the
  colonize menu is now a single Send action — the separate Scan step is gone.
- **Pick up colonizing where you left off — on any device.** OG-E keeps a compact
  log of your colonization decisions (sent / mine / abandoned / taken / reserved)
  and syncs just that, so a second device can continue the remaining free
  positions without re-scanning the galaxy first.
- **Mark a fleet-save by hand.** On the fleet-dispatch page a small "Mark FS" chip
  lets you flag the current planet or moon as fleet-saved yourself — handy when a
  save wasn't auto-detected. The mark sticks until you clear it and arms the
  guardian straight away. If you use push reminders, a manual mark also schedules
  the guardian's ntfy alert for that body — so a hand-marked fleet still reaches
  you with the tab closed, even when automatic fleet-save detection is off.
- **The guardian can now perform the fleet-save for you.** When a fleet is sitting
  exposed, the guardian's button becomes a two-tap "Re-Save" that runs the
  fleet-save through AntiGameReborn — no need to set it up by hand.
- **A gentle "still watching?" nudge.** If a fleet is parked bare and you've gone
  a few quiet minutes without touching the page, the guardian button now pulses
  softly as an in-game presence check (no push needed). Off the fleet-dispatch
  page its first tap just acknowledges — silencing the pulse and snoozing the
  push without yanking you away — and a second tap navigates. Set the interval
  under the guardian's row in the Dashboard.
- **Daily Run now sends fleet 2 with empty holds at full speed.** The micro step
  zeroes the cargo and forces 100% speed automatically, so the routine fleet goes
  out exactly as intended.

### Changed

- **Sync is dramatically lighter.** Galaxy scans, the player list and your own
  profile are no longer uploaded — every device re-derives them from the public
  API on its own — so a universe's synced payload shrank from a couple of
  megabytes of scan data to a few bytes. Only the things that genuinely need
  sharing (colonization decisions, colony history and your configs) still travel
  between devices.
- **The guardian wears a lighthouse.** Its old "!" is now a lighthouse glyph — a
  beacon that keeps watch and guides fleets home — and the in-game button and its
  Dashboard rows are now labelled "Fleet guardian".
- **The colonize button's label now matches the others** in size, with a short
  hint of your configured target positions.
- **Clearer "AGR isn't ready" feedback on the action buttons.** The expedition and
  fleet-save buttons now say so plainly when AntiGameReborn's matching routine
  isn't present, instead of looking like a generic timeout.
- **The Lifeforms button dropped its red "cap" dot** — the "3600+" artifact label
  already said everything it did.

### Fixed

- **Fleet status markers no longer linger after a fleet has finished.** The
  optimistic marker cache had no expiry, so a dot for a fleet that completed while
  the tab was closed could stay painted on every reload; markers now expire on
  their own once the fleets they represent have arrived.
- **The merchant 6× import highlight now survives the entire multi-day event.** It
  keys off the announcing news message (a fixed multi-day run) instead of the day
  it was first seen, and re-arms itself on a steady four-hour cadence without
  needing a visit to the Trader page — so it no longer goes quiet on day two or on
  a second device. The highlight also stopped flickering on the auctioneer's
  one-second countdown.
- **The "Mark FS" chip no longer disappears when you reach fleet dispatch from the
  top menu.** It finds the current planet/moon from the page itself rather than
  from the URL, so it's present however you navigate there.
- **Skipping a colonization target now always sticks.** Holding to skip records a
  durable "taken" decision, so it works even for universe-wide candidates you've
  never live-scanned.

## [1.29.0] — 2026-06-20

### Added

- **Bare-fleet guardian — a warning when a fleet-save lands and is left sitting
  exposed.** When one of your fleet-saves touches down with nothing covering it,
  OG-E now flags it so you don't leave a fleet parked and vulnerable: an orange
  "!" button appears on the floating menu — tap it to jump straight to the planet
  or moon, hold it to dismiss. If you use OG-E's push reminders, the guardian
  also sends an escalating ntfy notification a set number of minutes after
  landing and keeps nudging until the fleet is safe. Switch it on and set the
  interval under Reminders. A built-in safeguard guarantees a fleet-save reminder
  still reaches you even if you never re-open the game after the fleet lands.
- **A legend for the planet status markers.** A small "?" chip now sits at the
  top of the planet list; hover it for a key that explains every marker — the
  swatches are the real markers, so the legend always matches what's on screen.
- **A heads-up when AntiGameReborn isn't detected.** OG-E relies on AGR for the
  game data it reads, so if AGR is missing or disabled you now get a clear notice
  instead of features quietly doing nothing.

### Changed

- **The incoming-attack marker is now a bold red "!!!"** instead of the small
  red square — an attack heading at one of your planets is impossible to miss.
- **The expedition marker is now a plain blue heart**, cleaner and easier to tell
  apart from the other status dots.
- **Everything that refreshes on a timer now shares one visibility-aware clock.**
  OG-E's periodic re-paints and safety re-checks used to each run their own
  forever-ticking timer; they now ride a single clock that pauses while the tab
  is hidden and snaps every countdown and marker up to date the instant you
  switch back — quieter in the background, identical when you're looking at it.
- **The merchant 6× import-event highlight now lasts the whole multi-day event.**
  It's recognised from two distinct sightings on the same day, so the
  Import/Export highlight stays put across the full run instead of dropping out
  on a second device.

### Fixed

- **The Daily Run button's label and its enabled state can no longer disagree.**
  Both are now driven by the same "event box ready" gate, so the button never
  shows an active label while it's still waiting (or the reverse).

## [1.28.0] — 2026-06-20

### Added

- **Planet status markers — a glanceable column of status dots beside every
  planet and moon**, replacing the old single green expedition dot. Each fleet
  in your event list now leaves a small marker on the body it lands on: a red
  square for an incoming attack, a red dot for your own attack heading out, a
  yellow dot for a detected fleet-save, a teal heart for an expedition, green
  for logistics (transport / deploy / ACS defend), and blue for a recycle. At
  most three per body, highest-priority first — and click or tap any marker for
  the per-fleet detail (where each fleet is going and when it arrives). The
  whole point is to tell at a glance that your fleets are well positioned
  without burying the planet skins under clutter. Toggle it under Settings →
  Display ("Fleet status markers on planets"); your old "Expedition badges"
  setting carries over.
- **A cross-universe Sync diagnostics view in the OG-E Dashboard.** A new "Sync"
  tab answers "what's synced where" at a glance: for every universe it shows a
  freshness chip (just synced / stale / rate-limited / failed), the last
  ↑ upload and ↓ download times, and an inventory of what's stored per category
  with approximate sizes — so it's obvious why, say, one device has fewer galaxy
  scans than another.

### Changed

- **Multi-device sync and reminder settings moved into the OG-E Dashboard, and
  now apply to every universe at once.** The sync master switch + GitHub token
  moved to the Dashboard's Sync tab, and the reminders master switch + ntfy
  token + your push topic moved to the Reminders tab. A token entered there is
  shared across all your universes, so there's no more retyping it on each
  server. The in-game Settings panel now just points you to the Dashboard.
  Existing per-universe tokens are lifted up automatically the first time this
  build runs — nothing to redo.
- **The readability-boost event box is now a full-width, edge-to-edge strip**
  rather than a narrower inset box, so the upcoming-event countdown reads more
  cleanly across the bar.

### Fixed

- **The merchant 6×-event timing now travels with multi-device sync.** The
  trader import-event day and next-due time are included in the synced daily
  state, so the Import/Export menu highlight stays consistent across all your
  devices instead of re-appearing on a second machine.

## [1.27.0] — 2026-06-19

### Added

- **Attack alarm — a loud, full-screen alert the moment you come under
  attack.** When OGame flags an incoming attack, OG-E can throw a pulsing red
  frame around the whole screen plus a top banner that names how many hostile
  fleets are inbound, when the soonest one lands, and which planet it targets —
  read live from the event list. It also blinks the browser-tab title and swaps
  in a red tab icon, so you notice even when you're on another tab or in another
  app. The red frame is click-through, so you can jump straight to defending
  without dismissing anything first; dismissing the banner mutes it until the
  attack actually changes (a new or faster wave re-fires it). It is **off by
  default** — switch it on under Settings → Display, where a "Preview" button
  shows you exactly what it looks like before you commit.

## [1.26.1] — 2026-06-19

### Added

- **Daily Run routes now have a far richer editor.** A route can be paused
  without deleting it, carry a multi-ship fleet instead of a single ship type,
  pick its own mission, and aim at an arbitrary external coordinate (not just
  one of your own planets/moons). The per-ship picker lists the full mobile-ship
  catalogue, and the "already sent today" guard is now mission-aware. Your
  existing routes migrate automatically the first time the new build loads —
  nothing to redo.

### Changed

- **"Sync now" now validates your token too, and the sync status reads as one
  block.** The standalone **Validate** button is gone: "Sync now" runs the token
  check first and shows the result, then syncs. The token result and the
  ↑ upload / ↓ download times now sit together under a single **Sync status**
  label instead of in two separate rows.
- **Daily Run routes are edited entirely through the controls now.** The old
  free-text "Advanced" route syntax has been retired in favour of the visual
  editor (routes are stored as plain JSON under the hood).
- **Custom Daily Run targets lost their pin icon.** External targets are
  recognisable by their lack of an inventory name, so the pin glyph on the chips
  and on the inline add-coords form was dropped as visual noise.
- **A placeholder Settings panel appears on the Daily Run tab.** A collapsible
  "⚙ Settings" section is in place for future per-tab options; there is nothing
  to configure there yet.

### Fixed

- **A fleet send can no longer slip to the planet instead of the moon (or the
  other way round).** When OG-E advances to the second fleet step it now
  re-checks the game's own planet/moon selector and corrects it if an earlier
  click didn't register — closing a rare race where the wrong body type could be
  armed at launch.

## [1.26.0] — 2026-06-18

### Added

- **Player intel now syncs across devices.** The player data behind galaxy
  scans — ranks, alliance, and the active / inactive / strong / newbie / …
  flags — plus your own rank and profile now travel with the rest of your
  cloud sync, per universe. A device that hasn't itself re-scanned the galaxy
  sees the same neighbour rankings and relative-strength scoring as the device
  that recorded them. (Until now only the raw scans synced; the player
  metadata stayed on the device that captured it, so rankings looked stale or
  empty elsewhere.)
- **The Multi-device sync settings now explain themselves.** A note spells out
  exactly what is synced (and what stays on each device), a **Validate** button
  checks your GitHub token on the spot, and hitting GitHub's rate limit shows a
  "retry after HH:MM" countdown instead of a bare error.

### Fixed

- **Import/Export nudge clears once the day's offers are used up.** During a
  "6× per day" Import/Export event, taking the last container now stops the
  prompt from nagging for the rest of the day — it had stayed lit because the
  "come back tomorrow" message carries no time for it to re-arm against.
- **Cloud sync no longer risks data loss on a flaky connection.** If the
  pre-upload read of your gist fails (network blip, rate limit), the upload now
  aborts and retries instead of pushing a partial snapshot — which on a
  multi-universe account could overwrite another server's data — and the status
  row reports the failure rather than a false "synced". A galaxy scan that
  lands mid-sync is no longer dropped.
- **A setting introduced by a newer version is no longer lost when an older
  device syncs.** Cross-version syncs now keep settings the older build doesn't
  recognise yet, instead of quietly dropping them from the shared gist.
- **Dashboard Export → Import keeps lifeform discoveries.** The import path now
  uses the same merge as cloud sync, so re-importing a backup no longer erases a
  lifeform marker that a later plain rescan had overwritten.

## [1.25.4] — 2026-06-18

### Fixed

- **Lifeform "Max fleets" state no longer shows system coordinates.** The
  fleet cap is account-global, so the viewed system `[g:s]` was noise on the
  blocked discovery button; it has been dropped (it had slipped back in during
  1.25.3).

## [1.25.3] — 2026-06-18

### Changed

- **Event box and fleet-movement link: readability rework.** The next-event
  countdown is now larger and carries a dark outline so it stays legible even
  when it overlaps the mission-type text. Both surfaces are restyled to
  OGame's own colour palette (gold countdown, green/red fleet status) and the
  mission counts now show both the own- and friendly-event tallies. The whole
  event-box card was repositioned and re-spaced to sit cleanly in the top bar.
- **Fleet-movement link shows short, language-independent labels.** Whatever
  locale OGame renders ("Floty:" / "Ekspedycje:", "Flotten:", …), the link now
  reads `Fleets: x/y` and `Expos: a/b`, bigger and bolder, so the counts stay
  readable when OGame is zoomed out on a phone.

### Fixed

- **Lifeform "Max fleets" state shows the system coordinates.** When discovery
  is blocked by the fleet cap, the button's subtext now carries the viewed
  system `[g:s]`, matching the discover/navigate states.

## [1.25.2] — 2026-06-18

### Added

- **Ad-hoc fleet reminders now follow a full schedule, not just one ping.**
  The Dashboard ▸ Reminders ▸ Ad-hoc tab gains the same chip-style schedule
  editor as fleet-save: a list of offsets relative to the fleet's arrival
  (`−` before, `0` at, `+` after). Arming a leg in the event list schedules
  every slot in that schedule, and editing the schedule re-times all
  already-armed reminders. Your previous single ad-hoc lead time carries over
  automatically.
- **More reminder wildcards.** Ad-hoc and fleet-save message bodies gain
  `{direction}` (outbound / return), `{index}` and `{total}` (this reminder #
  of how many), and ad-hoc also gains `{offset}` (before / at / after arrival)
  — so the two kinds now share one identical wildcard set.
- **"Currently queued" shows the exact message.** Each still-queued reminder
  on the Dashboard ▸ Reminders tab now lists its fire time alongside the
  precise push text that was registered, slot by slot.

### Fixed

- **Ad-hoc push bodies now fill their fleet wildcards.** `{origin}`,
  `{target}`, `{targetName}`, `{shipCount}` and `{direction}` were rendering
  blank in ad-hoc reminders because the per-leg metadata wasn't reaching the
  message renderer; they now resolve correctly.

### Changed

- **Floating command buttons: visual polish.** A single-zone button now dims
  its centre node along with the rest when it goes busy/disabled (no more lone
  bright "island"); long two-word labels (e.g. "All maxed!") wrap to two lines
  instead of crowding the rim; the Expeditions label size now matches the other
  buttons; bottom-zone labels on split buttons sit a touch higher; and a couple
  of redundant hint lines were removed.

## [1.25.1] — 2026-06-18

### Changed

- **Reminder message wildcards: a tidier, non-redundant set.** The
  customisable reminder bodies (Settings ▸ Reminders) drop two duplicate
  placeholders: `{label}` (which was only ever `{mission} → {coords}`) and
  `{landTime}` (an exact alias of `{arrivalTime}`). Ad-hoc and fleet-save now
  advertise an identical wildcard set, differing only by fleet-save's
  schedule-relative `{offset}`, and `{mission}` is now offered on expedition
  reminders too. The default messages were updated to compose `{mission} →
  {coords}` directly. Any custom message you saved earlier keeps working —
  the retired placeholders still render, they just no longer appear as chips.

## [1.25.0] — 2026-06-18

### Added

- **Trader reminder follows the "import refreshes 6× today" event.** On the
  special days when the Import/Export offer renews several times instead of
  once, OG-E detects the event from its in-game news message and lights the
  Trader reminder right away — no waiting until 14:00. After you take a
  container, it reads the page's "come back at HH:MM" time and re-lights the
  Trader menu exactly when the next offer is due, for each of the day's
  refreshes. Reverts to the normal once-daily behaviour the next day.

### Changed

- **Settings ▸ Reminders: tidier topic row.** "ntfy.sh — your topic" now shows
  the masked topic on the right with its Reveal and Copy buttons stacked neatly
  above it, and the separate "topic privacy" label is gone — its note now reads
  as a plain caption under the topic.

## [1.24.1] — 2026-06-18

### Fixed

- **Daily Run now reliably aims at the planet vs the moon you picked.** The
  first fleet you sent on a freshly-opened fleet dispatch page could ignore the
  chosen target type — firing at the planet when you wanted the moon, or the
  moon when you wanted the planet — because the game's AGR helper wasn't ready
  yet when OG-E set the type, and a single attempt was silently dropped.
  Going back to step 1 and tapping again worked around it. OG-E now confirms
  the type actually switched and retries until it sticks (in both directions),
  instead of waiting a fixed moment — so the first send goes to the right body.
  Most noticeable on mobile, where the page settles more slowly.

## [1.24.0] — 2026-06-18

### Added

- **Colony Scout reads far more about your neighbours.** As you scan the galaxy,
  OG-E now keeps a per-server player roster (de-duplicated by player id) holding
  the signals the galaxy view exposes but the per-system map dropped — active vs
  merely on-vacation, strong, newbie, buddy, outlaw, alliance rank, and whether a
  player is in **your** alliance. Colony Scout surfaces these in the Top-region
  summary and the per-region tooltip (e.g. "2 strong · 1 active-on-vac · 1
  outlaw") and folds them into the strategy ranking: the **Peaceful settler** /
  **Farmer** presets now avoid strong and "active-on-vacation" neighbours (a live
  player hiding behind vacation mode, not a safe farm), and the PvP presets prefer
  outlaws (fair-game targets). Older scans are unaffected; the data fills in as you
  re-scan.
- **Neighbour ranks are now shown relative to you.** OG-E reads your own highscore
  rank off the in-game header bar, so the Top-region card annotates the strongest
  neighbour as e.g. "#11 (239 above you)" instead of a bare number — instantly
  telling you whether the area's top player out-guns you or not.
- **Reminder pushes can carry far more fleet detail — one shared wildcard set.**
  Ad-hoc and fleet-save message templates now expose the SAME `{wildcard}` set,
  read from the event list when the reminder is armed / detected: alongside
  `{mission}` / `{coords}` you can now use `{origin}` / `{originName}` (the
  launching planet or moon), `{target}` / `{targetName}` (the mission target),
  and `{shipCount}` (ad-hoc gained it; fleet-save already had it). Expedition-wave
  reminders keep their series wildcards (`{returnTime}` / `{index}` / `{total}`) —
  a wave's pushes are queued before the burst's makeup is known.
- **Reminder schedules now print a plain-language summary.** Under the offset
  chips, OG-E spells out what the whole schedule adds up to — e.g. "15m & 5m
  before landing · at landing · 20m after landing" — so you can sanity-check the
  set at a glance instead of decoding each chip.
- **Your ntfy topic is now explained and protected.** The Reminders tab shows how
  the topic is derived (a one-way hash of your access token — unguessable and not
  listable) and how to lock it down further; the topic is masked by default
  behind a show/hide toggle and treated as the secret it is. The in-game Settings
  panel carries the same masked topic plus a short privacy note.

### Changed

- **Galaxy Observations folded into the Colonizations tab.** The dashboard now
  has a single **Colonizations** tab with three sub-tabs — **Planet sizes** (the
  field-size histogram), **Scanned data**, and **Colony Scout** — mirroring the
  one in-game Colonizations button that both scans positions and colonizes.
  The two separate ⚙ Settings panels (colonization / abandon knobs + scan
  re-scan policy) are now one combined panel below the sub-tabs, with a single
  Save / Reset.
- **Colony Scout "Top region" graphic now matches the rest of the dashboard.**
  The region strip used its own ad-hoc colours that disagreed with the galaxy
  map (empty looked like debris, "fleet sent" looked free, etc.). It now uses
  the canonical status palette, gains a **legend**, draws a thin divider
  **between systems**, and each cell's hover shows the **full per-slot
  breakdown** (status, flags, owner with rank + alliance tag) instead of just
  the system number. The summary line also reports distance to your nearest
  colony. The sub-tab is now tagged **experimental** while its scoring
  heuristics and neighbourhood intel keep evolving.
- **The Colony Scout "Ally tag" field is gone — alliance proximity is automatic
  now.** You no longer type your alliance tag: the galaxy view already tells OG-E
  which neighbours are in *your* alliance, so the proximity bonus applies on its
  own (and self-corrects when alliances change, no re-typing). The "Longest
  streak" preset stays pure length; the other strategies gain the auto bonus.
- **Reminder schedule chips are slimmer; the icon & priority pickers are
  redesigned.** The offset chips dropped their redundant inline phrase (the value
  already reads as text), so they hug their content like the Daily Run chips. The
  message **icon** is now picked from real-image swatches — you see the actual
  push icon, not a dropdown label — and **priority** is a 1–5 segmented control
  with a calm→alarm colour ramp and the level's name.
- **"Currently queued" badges describe the ntfy state and sit by the date.** They
  now read one consistent vocabulary across waves / ad-hoc / fleet-save — queued
  / fired / scheduled / not scheduled / cancelled / "> 3 days out" — instead of
  the wave-only "in flight" / "overdue", and sit next to the date (the cancel ✕
  moved to the right) rather than stranded in the middle of the row.

### Fixed

- **"Set password" from the abandon flow now opens the right tab.** It used to
  deep-link to the old Galaxy Observations tab, which never held the password
  field; it now opens the Colonizations tab, whose ⚙ Settings hold the abandon
  password.
- **Colony Scout no longer shows "nothing" when free slots are scattered.**
  Typing a single slot (e.g. `8`) returned no results unless five+ systems in
  a row had it free — common to never happen once you start colonising that
  slot. When no such region exists, Colony Scout now lists every **individual
  free system** (scored and strategy-ranked), with a clear note explaining why.
- **The dashboard Copy-topic button no longer sticks on "Copied!".** It used to
  overwrite the topic field with its own feedback and then read that back on the
  next click, jamming the display; the feedback now lives on the button and copy
  always uses the real topic.
- **The "Urgent" reminder icon now shows in the dashboard picker.** Its image was
  never bundled into the built extension, so the swatch came up blank; it now
  ships alongside the other icons.
- **The in-game Settings ntfy rows no longer overflow their column.** The masked
  topic plus its show/hide and Copy buttons used to spill past the narrow value
  column into a horizontal scroll, and the topic-privacy note was squeezed into a
  sliver; both rows now span the full panel width with the label as a heading.

## [1.23.0] — 2026-06-17

### Added

- **"Prefer farthest systems first" colonization toggle.** A new per-server
  switch (Galaxy Observations → ⚙ Settings) controls how the Colonize button
  orders free systems *within your home galaxy*. On (the default, unchanged
  behaviour) it proposes the farthest free system first, spreading colony-ship
  arrival times; turn it off to colonize the nearest free system first. Other
  galaxies stay in their usual order.

### Changed

- **Galaxy Observations split into two sub-tabs.** The per-system scan summary
  ("Scanned data") and the Colony Scout settlement analysis now live on
  separate sub-tabs instead of one long stacked page.
- **Reminder schedules shown as compact chips.** Expedition-wave and Fleet-save
  reminder offsets now render as a wrapping row of labelled chips (e.g.
  "10m before", "at landing", "15m after") — full description on hover, invalid
  entries flagged in red — instead of stacked rows of long inline text. Each
  reminder sub-tab also lays its settings beside its message template on wider
  screens (stacking on narrow ones).
- **Galaxy rescan-timing fields packed into a responsive grid** (1–3 columns)
  instead of one tall single-column list.

### Fixed

- **Colonize button no longer gets stuck on a planet it can't settle.** When the
  next free coordinates turn out to be un-colonizable — the slot is now
  occupied, the player is on vacation, it's reserved for a planet-move, or the
  server refuses for any other reason — the button marks that spot, drops it
  from future picks, and on your next tap retargets to the next free slot in
  place (without leaving the fleet screen) instead of looping forever on
  "Wait… / Stale".
- **Galaxy scans no longer bleed between servers when Cloud Sync is on.** With
  sync enabled and more than one universe on the same account, each server's
  scan database is now kept separate. Before, scans from one server could merge
  into another, so the Colonize button could propose coordinates that were empty
  on a different universe but already taken on yours. (Existing mixed data heals
  itself as you re-scan; nothing is deleted.)

### Removed

- **"Clear observation data" button.** The bulk button that wiped all galaxy
  observation data for the current server has been removed; clear per galaxy
  with the per-galaxy ✕ reset buttons instead.

## [1.22.0] — 2026-06-17

### Added

- **Hold the Explore button to skip a planet.** Long-pressing the floating
  expedition button (a 2-second hold, with the ring filling as you press) jumps
  to the next planet still under the per-planet cap *without* sending — for
  deliberately passing over the planet you're on. The round-robin walk then
  carries on from there.

### Changed

- **Artifact Shop event highlight stops once you're done.** The pulsing
  left-menu highlight for the Artifact Shop event now switches off as soon as
  every reward rank is claimed — even though the event keeps running for days
  afterwards. It lights up again automatically when the next Artifact Shop
  event begins.
- **Expedition auto-redirect spreads sends evenly (round-robin).** With "Max
  expeditions per planet" set to 2, the after-send hop now tops every planet up
  to one expedition first, then comes back round for the second — instead of
  stopping after a single pass once every planet had one. It still skips
  planets that have reached the cap and continues to the nearest one that
  hasn't, so manually skipping a planet just moves on. (No change at the
  default of 1.)
- **Clearer "not scheduled yet" fleet-save reminders.** A fleet-save more than
  3 days out can't be queued yet (ntfy schedules at most 3 days ahead). The
  in-game event-list badge now dims and explains it'll be set automatically
  once the fleet is within 3 days of landing, and the dashboard's Reminders
  queue shows "> 3 days out" with the same note — instead of a bare,
  unexplained "Set automatically" / "not scheduled".
- **Dashboard Reminders & Daily Run polish.** The Reminders queue drops the
  redundant server name (it's already chosen in the Server selector) and its
  status line now reflects the selected server; the stale ntfy setup hint was
  trimmed. The Daily Run description matches the button's current labels.

## [1.21.0] — 2026-06-16

### Changed

- **Reminders are now per-server.** Expedition-wave cadence, ad-hoc lead time,
  and the message templates are configured per OGame server (the server comes
  from the Dashboard's top switcher), matching fleet-save. The brief
  "all servers / this server" override toggle is gone — every server simply has
  its own reminder config.
- **Dashboard restructure.** The "Colony Sizes" tab is now **Colonizations**,
  and every tab follows one pattern: the data view leads, with its options
  tucked into a collapsed **⚙ Settings** panel at the bottom. The colonization
  knobs (target positions, prefer neighbouring, arrival gap, abandon threshold,
  abandon password) moved from Galaxy Observations into Colonizations → Settings.
- **In-game settings panel slimmed.** The Dashboard launcher is now its own
  named section, and the redundant reminders signpost row was removed — enable +
  token + topic is the whole minimum; the rest is discoverable in the Dashboard.
- **Polished, responsive settings.** The ⚙ Settings panels (Colonizations,
  Galaxy Observations, Reminders) now share one clean input / select / chip
  style, and the Reminders settings split into three sub-tabs — Expedition
  waves, Ad-hoc, Fleet-save. Lays out cleanly on narrow screens too.
- **New abandon icon.** The Abandon button now shows a snapped colony flag —
  a clearer "this place is being let go" than the old lift-off rocket.

### Added

- **Lifeform artifact-cap badge.** The lifeform discovery button no longer
  blocks at the artifact cap — it keeps discovering and shows a small badge,
  refreshing its counter only when it has drifted.

### Fixed

- **Floating button size now applies to the Abandon button live**, like the
  other FAB modules, when you change the size in settings.
- **Colony histogram now syncs to your other devices.** Colony-size history is
  stored per server, but it synced as one shared blob — so on a second device
  the data landed under the wrong server and the histogram looked empty. History
  now syncs per server, matching where it is stored and shown.
- **The floating button's progress / charge ring no longer leaves a stray dot**
  when empty (a Chrome round line-cap artifact).

## [1.20.0] — 2026-06-16

### Added

- **Custom reminder messages.** In the Dashboard's Reminders tab you can now
  shape the push for each of the three reminder kinds — expedition waves,
  ad-hoc fleet, and fleet-save — choosing the message text, the icon, and the
  priority. Drop in wildcards like server, time, mission, coordinates or ship
  count (click a chip to insert one) and watch a live preview update as you
  type. Defaults match the previous built-in messages, so nothing changes
  until you edit it.
- **Per-server reminder scope.** Expedition-wave and ad-hoc reminders were
  global before; now a server can override the whole group (enable, schedule,
  lead time, and the messages) just for itself, with an "all servers / this
  server" toggle.

### Changed

- **Colony abandon is now one button on the floating action button.** The
  separate "new planet" banner and the red abandon overlay are gone. Instead,
  a freshly-colonized colony that's too small to keep surfaces a red **Abandon**
  button on the FAB (with its field count read straight from the planet list);
  tapping it jumps to that colony, and on its overview the same button walks
  the give-up steps one tap at a time. If no abandon password is set yet, the
  button opens the Dashboard so you can set it.
- **Dashboard tidy-up.** *Target positions* and *Prefer neighbouring galaxies*
  moved into the Colonization section of the Galaxy Observations tab, next to
  the rest of the colonize settings.

## [1.19.5] — 2026-06-15

### Changed

- **Configuration moved into the Dashboard.** The in-game settings panel now
  holds only the essentials — the on/off switches, your sync + ntfy tokens,
  the display toggles, and the expedition options. The detailed config lives in
  the OG-E Dashboard now, next to the data it shapes:
  - **Galaxy Observations tab** — the colonization knobs (arrival gap, the
    abandon field-threshold, and the abandon password) join the per-universe
    scan settings.
  - **Reminders tab** — the expedition-wave + ad-hoc schedules and the
    per-server fleet-save thresholds/offsets, edited through a friendly
    per-entry offset editor that shows each reminder in plain language
    ("10 min before landing", "at landing", …).

  Nothing is editable in two places any more. *After updating, set these once
  in the Dashboard* — they start at defaults (no automatic carry-over from the
  old in-game values).
- **Max expeditions per planet is now a simple 1 / 2 choice** instead of a
  1–20 slider — as a rule you shouldn't send more than two from one planet.

## [1.19.4] — 2026-06-15

### Changed

- **Stronger Trader highlight.** The Trader menu entry and the Auctioneer /
  Import-Export overview tiles now pulse with the same punchy glow as the event
  highlight — the previous outline was so faint it was easy to miss. (Event
  highlights are unchanged.)

## [1.19.3] — 2026-06-15

### Fixed

- **Dashboard Reminders topic really shows now.** The 1.19.2 fix wrote the
  ntfy-token mirror inside the reminder sync, but that sync is skipped on an
  ordinary page reload when the event list hasn't changed — so the dashboard
  still read "set your ntfy.sh access token". The push-topic mirror is now
  refreshed on every producer pass, before that short-circuit, so the topic
  appears whenever ntfy is configured in-game. (Per-wave cards still come from
  cloud sync.)

## [1.19.2] — 2026-06-15

### Fixed

- **Dashboard shows your ntfy topic without cloud sync.** The Reminders tab
  could read "set your ntfy.sh access token" even with a valid token set
  in-game, because the topic mirror was written only after the cloud-sync
  (gist) step. The token is now mirrored independently, so the topic appears
  whenever ntfy is configured. (Per-wave preview cards still need cloud sync —
  that's where wave state lives.)

### Changed

- **Brighter button edge.** The outermost pixels of each command button now
  carry a crisp, vivid state-coloured edge (like the FAB menu orbs), instead of
  fading into the dim fill gradient — single- and split-zone alike.
- **Larger colonization glyph.** The lander now fills its node / menu orb to
  match the other glyphs (it read small and sat low before).

## [1.19.1] — 2026-06-15

### Changed

- **Larger button node.** The "oczko" inside each command button is ~20%
  bigger for better glanceability. On single-zone buttons it's nudged slightly
  up so the larger node grows upward and keeps clear of the label below.

## [1.19.0] — 2026-06-15

### Changed

- **Floating-button menu is always on.** The FAB's module picker is no longer
  hidden behind a +/× handle — the other modules now ride permanently as small
  satellite orbs around the button. Tap one to switch; the picked module flies
  into the button and the previous one drops back into orbit. Orb captions are
  gone (the glyph speaks for itself).
- **Button "oczko" matches its orb.** The node inside each command button now
  wears the same module-coloured dome as that module's satellite orb (no more
  gold medallion), so switching reads as the orb sliding into the button. The
  retired gold node now marks the settings "Open Dashboard" button.
- **Brighter rim filament.** The thin state-coloured thread just inside each
  button's chrome edge now glows instead of sitting dim.
- **Tidier labels.** Tighter line spacing keeps a two-line primary (e.g. "All
  maxed") clear of the node, and the split-button labels sit closer to centre.
- **Simpler Reminders settings.** Dropped the read-only "fires at" preview
  rows (the schedule fields already carry the offsets). Ad-hoc per-fleet
  reminders are now always on — the enable toggle is gone; the lead-time field
  stays.

## [1.18.1] — 2026-06-14

First public (listed) build of the 1.18 line — same features as the 1.18.0
test build, plus packaging and lint fixes.

### Added

- **Configurable Galaxy-Scan strategy (dashboard → Galaxy Observations).**
  Per-status freshness windows for the Scan button — e.g. `6h`, `5d`, or `0`
  (never re-scan). The target-positions list and "prefer neighbouring
  galaxies" preference moved here too. Per-universe and cloud-synced.

### Changed

- **OG-E mark on floating buttons.** Each button's glyph now sits in a small
  gold "glass node" framed by the OG-E orbit symbol; the rim still carries the
  live state colour.
- **Gold FAB handle** that rides the FAB edge facing the screen centre and
  re-aims live as you drag or resize; picker orbs keep their per-module
  colours.
- **Buttons wait for page load before responding** — all four (Expeditions,
  Colonization, Daily Run, Lifeforms), not just Expeditions — with a
  consistent disabled look across single and split shapes.

### Fixed

- **Fleet-send buttons no longer fire someone else's fleet.** Each button
  tracks ownership of the fleet1→fleet2 transition it started and routes to a
  fresh dispatch page if step 2 is already claimed by a manual send or AGR.
- Inline SVG is now built without `innerHTML`, clearing the add-on linter's
  "unsafe assignment" warnings.

## [1.18.0] — 2026-06-14

### Added

- **Configurable Galaxy-Scan strategy (dashboard → Galaxy Observations).**
  Per-status freshness windows for the Scan button — e.g. `6h`, `5d`, or `0`
  (never re-scan). Suits farm-hunting, slot-finding, or watching active
  players. Target-positions list and "prefer neighbouring galaxies" also moved
  here from the AGR panel. Per-universe and cloud-synced.

### Changed

- **OG-E mark on floating buttons.** Each command button's glyph now sits in
  a small gold "glass node" — a convex cabochon framed by the OG-E orbit
  symbol (three gold arcs + three beads). The rim still shows live state
  colour; the node stays gold in all states. On split buttons (Colonization,
  Daily Run) the node sits centred on the seam with the dividing line
  inverted to frame it; on single buttons (Expeditions, Lifeforms) the node
  sits in the upper section.
- **Gold FAB handle.** The floating-button picker handle now shows a gold
  ring + gold "+" (rotating to "×" when open) instead of tinting to the
  active module's colour. Picker orbs keep their per-module colours.
- **FAB handle tracks the screen centre.** The "+"/"×" handle rides the FAB
  edge facing the viewport centre — the same side the picker orbs fan toward
  — and re-aims live as you drag or resize the window.
- **Floating buttons wait for page load before responding.** All four buttons
  (Expeditions, Colonization, Daily Run, Lifeforms) sit visibly disabled
  until OGame's event list finishes loading on the fleet-dispatch page, then
  enable themselves. Previously only Expeditions guarded this, and only by
  flashing "Wait…" after tapping.
- **Consistent disabled appearance.** A greyed-out button dims only its inner
  face and label; rim, progress ring and gold node stay bright — same on
  single-face and split buttons.

### Fixed

- **Fleet-send buttons no longer fire someone else's fleet.** Each button
  tracks ownership of the fleet1→fleet2 transition it started. If step 2 is
  already claimed by a manual send, AGR, or another OG-E button, the button
  blocks and routes to a fresh fleetdispatch page instead of continuing the
  foreign fleet. AGR routine-7 expeditions (position 16 + Pathfinder) are
  still recognised and remain one-tap sendable.

## [1.17.0] — 2026-06-10

### Added

- **Subtle background glyphs on the floating buttons.** Each command button
  now carries a faint, monochrome line-glyph behind its label as a
  glanceability cue — a comet for Expeditions, a landing craft for
  Colonization, a planet-with-flight-arc for the Daily Run, and a DNA helix
  for Lifeforms. The glyph is tinted to the button's current state colour
  (so it stays quiet in the amber "wait" / rose "error" states and brightens
  with the active colour) and sits below the label, ring and charge arc so
  it never competes with them. Single-zone buttons show one half-size glyph
  tucked toward the top; split buttons carry a smaller glyph in the lead zone
  only.

### Changed

- **Hold-to-confirm is now 2s (was 3s)** on the two buttons that use it — the
  Colonization "skip/scan" hold and the Daily Run "set collect target" hold.
- **Lifeforms button labels tidied.** "Empty → next" → "Empty", "To galaxy" →
  "Discover", and the "(N left)" counter is gone (with thousands of systems
  always pending, the number carried no useful signal).

### Fixed

- **Cross-device sync no longer drops lifeform discoveries.** A plain galaxy
  rescan on one device could overwrite a lifeform discovery recorded on
  another after a sync round-trip, because scans merged as a whole unit keyed
  on the regular scan timestamp. Lifeform markers now reconcile independently
  (newest discovery wins; discovered positions are unioned), so a routine
  rescan can't erase a discovery from another device.

## [1.16.5] — 2026-06-10

### Added

- **Floating "Lifeforms" button** (violet, single zone). Automates OGame's
  system-discovery action across the whole universe — one tap per system,
  TOS-safe (the button clicks the game's own `#discoverSystemBtn`; it never
  originates an HTTP request itself).
  - Off galaxy view → navigates to the galaxy page.
  - On galaxy, current system undiscovered → clicks the game's discover
    control; the result is observed via the new `discoveryHook` bridge and
    `lfScannedAt` / `lfPositions` are stamped in the scan store.
  - On galaxy, current system already covered → in-page hops to the
    **nearest** still-undiscovered system (wrap-aware: dist(499, 1) = 1).
  - `shipsSent: 0` (game reports system fully sent) → still marks the system
    as covered so the button advances cleanly.
  - Fleet-cap rejection ("Maksymalna liczba flot") → surfaces "Max fleets",
    marks nothing; the system remains queued.
  - 7-day per-system retention gate (same store as colonisation scanning;
    colonisation rescans do not wipe lifeform markers).
  - Enabled by default. Settings: "Floating Lifeforms button" toggle +
    size slider (40–560 px, default 320 px).

## [1.16.4] — 2026-06-10

### Added

- **Per-button identity colours.** Each floating button now has its own
  colour signature: expedition in cerulean blue (`#4aa8ff`), colonisation
  in cyan (`#13d1de` ready / `#12b3c2` idle) with a muted cyan scan zone
  (`#3a9fb0`), daily-run in pure green (unchanged). Status colours (amber
  wait, rose error, slate disabled) remain shared and unchanged.
- **`--glow` intensity multiplier.** A new `--glow` CSS variable (default
  `1`) scales the button's resting and hover glow radius. Expedition is
  set to `1.3` for a visibly stronger glow; other buttons stay at `1`.

### Fixed

- **Mobile keyboard no longer pops up on button tap (split buttons).**
  `mousedown.preventDefault()` in the tap-wire layer prevents the browser
  from focusing `<button>` elements on touch without suppressing the click
  event. Complements the `tabIndex=-1` fix from 1.16.3.
- **Mobile keyboard no longer pops up on page load after navigation.**
  `installFocusPersist` now skips programmatic `button.focus()` on
  `pointer:coarse` devices, where focus restoration has no UX value and
  could trigger the virtual keyboard.

## [1.16.3] — 2026-06-09

### Added

- **Symmetrical planet prime function in fleet executor.** Mirror of the moon
  prime logic — `primeAgrPlanet()` ensures AGR's planet flag is set before
  writing coordinates (needed because AGR guards planet-type clicks with
  `isTrusted`, blocking synthetic events).

### Fixed

- **Daily-run button label now shows correct next target on page load.** Added
  1 Hz ticker (matching send-colony pattern) to refresh labels even if
  `#eventContent` populates late — ensures "N left" counter and target name
  are accurate from the moment the page loads.
- **Mobile keyboard no longer pops up when tapping floating buttons.** Changed
  button `tabIndex` from `0` to `-1` — buttons remain clickable but exit tab
  flow, preventing unwanted focus on touch.

### Changed

- **Button touch-action CSS.** Changed from `none` (blocks all gestures) to
  `manipulation` (allows tap, blocks auto-zoom and system tap highlights) for
  better mobile UX.
- **Daily-run dim state now uses controller API.** Replaced manual `dimZone()`
  calls with `controller.setDim()` for consistency with expedition/colony
  buttons and reliability.

## [1.16.2] — 2026-06-09

### Added

- **Progress arc on colonization wait.** While waiting for the colony-ship
  min-gap (the "Wait Xs" state), a visual progress arc fills proportionally
  as the wait elapses — giving real-time feedback on how much longer until
  the send becomes available.

### Fixed

- **Moon page home-planet detection.** On moon pages where OGame places the
  highlight marker on the moon-link rather than the row element, the
  colonization button now correctly identifies your home planet.

### Changed

- **Colonization "Send Colony" label shortened to "Send".** Shorter label
  fits the new HUD-style button design while coords remain visible below.
- **Fleet dispatcher integration.** The send-colony hook now reads the
  target from `window.fleetDispatcher.targetPlanet` when available,
  allowing fleet-courier links to work without encoding coords in the URL.

## [1.16.1] — 2026-06-09

### Added

- **Event highlight auto-silences when all daily tasks are done.** Once you
  complete every task on the Rewards page the orange pulse on the event menu
  button disappears for the rest of the day (14:00 reset). It comes back
  automatically the next game-day, when a fresh batch of tasks is available.
- **Daily-action state syncs across devices.** "Rewards done today", last
  trader bid, and last import trade are now included in the Gist sync — so
  completing tasks on one device silences the highlights on all others within
  the next sync cycle.

### Changed

- **Button "Wait…" state is now consistent and grayed out.** All three
  floating buttons (expedition, colonization, daily-run) now show **Wait…**
  while an async operation is in progress and dim to 50 % opacity for the
  duration — replacing the earlier mix of "Loading…" and "Preparing…" labels
  on the expedition button.
- **Colonization button label hierarchy flipped.** The action label is now the
  large primary line; coordinates and hints appear smaller below it.
  Send zone: **Send Colony** (large) → `[g:s:p]` → *(hold to skip)*.
  Scan zone on galaxy view: **Scan** (large) → `[g:s]` → *(N left)*.
  Scan zone elsewhere: **To galaxy** (large) → *N left*.

## [1.16.0] — 2026-06-09

### Added

- **Per-universe settings sync via Gist.** Each universe you play now gets
  its own section in the Gist — expedition/colonization slots, daily route,
  fleet-save and reminder settings — so switching universes no longer
  overwrites your other accounts. One Gist, all universes, fully
  independent.
- **Expedition fleet memory.** After landing on fleet1 for an expedition,
  long-press the button to save the current ship selection as your preset.
  Every subsequent tap replays that preset at 51 % of available ships (as
  before). No preset saved yet? The button shows "Hold to set" so you
  always know where you stand.
- **Colonization: skip a blocked target with a 3-second hold.** If the
  colony-ship is already flying toward a slot, you can hold the Send zone
  to jump past that target and queue the next candidate instead of
  waiting for it to clear.

### Changed

- **Expedition and Colonization buttons are now independent of AGR.**
  OG-E drives the fleetdispatch page directly — no `#ago_routine_7` or
  `#sendall` hooks — so the buttons continue to work even when AGR is
  disabled or absent. Target coordinates are written straight into the
  native form inputs; the game fires its own `checkTarget` as normal.
- **Daily Run button** (formerly "Daily Resource Run") renamed to the
  shorter "Daily Run" across the dashboard tab, hover tooltip and settings
  panel.
- **Reliable fleet-dispatch readiness.** All three buttons now wait for
  the game's own `#dispatchFleet` element to be ready (absence of the
  `.off` class) before firing — eliminating the race condition where an
  early click would lock the button without sending.
- **Moon targets supported.** The courier correctly fills in planet-type 3
  when the configured destination is a moon, fixing a silent no-send for
  moon-to-moon operations.
- **Colonization re-entry wait.** After a colony-ship dispatch OG-E pauses
  until fleetdispatch reloads before resetting the button, preventing a
  double-click from landing on a stale page.

### Fixed

- Daily Run: ship-count edits in the settings panel now correctly activate
  the Save button.
- Daily Run: moon planet name is now read from the icon `alt` attribute
  instead of `.planet-name`, matching what the game sets in that context.
- Fleet: `setTargetType` also calls `fd.setTargetType` to bypass AGR's
  `isTrusted` guard that was silently dropping the call.
- Multiple smaller bugs in the Colonization / Daily Run send flow
  (galaxy/system/position not wiring, mission not being armed, result not
  being awaited).

## [1.15.5] — 2026-06-04

### Changed

- **Engraved button title sits on the ring.** The curved title now rides
  along the ring band near its top, instead of dropping onto the lit
  button face — so each button's name reads as cut into the ring itself.

## [1.15.4] — 2026-06-04

### Changed

- **Floating buttons get a tactile tap effect.** Tapping a button now
  sends a light ripple out from the exact touch point and briefly
  brightens the pressed area. On the two split buttons (Colonization,
  Daily Resource Run) the ripple starts in whichever half you pressed,
  so it is obvious which action you triggered.
- **Engraved title ring.** Each button now carries a thicker ring with
  its name engraved along the top of the ring itself —
  `EXPEDITIONS`, `COLONIZATION`, `DAILY RESOURCE RUN` — in a dark,
  cut-in style that stands out against the band.
- **Deeper outer shadow.** The buttons cast a stronger, layered shadow
  for a clearer floating look, with a tight rim that keeps them defined
  against bright backgrounds.

## [1.15.3] — 2026-06-04

### Changed

- **Floating buttons redesigned to match the OGame look.** The three
  draggable buttons — **Expeditions**, **Colonization** and **Daily
  Resource Run** — share a new decorative layer drawn on top of their
  state colours: a thin light rim, a darkened edge vignette and a soft
  top sheen give each one a glassy, game-native finish instead of the
  flat technical look. Drop shadows are deeper for a clearer sense of
  the buttons floating above the page.
- **Each button now has a hover title.** A subtle native tooltip names
  the button (`Expeditions`, `Colonization`, `Daily Resource Run`) on
  hover, so its identity is discoverable without cluttering the face.
- **Daily Resource Run polish.** Zone colours are now semi-transparent
  to match the other two buttons, labels use sentence case (`Dispatch`,
  `Send All`, `Send`) instead of shouting capitals, and holding the
  collect zone shows a radial sweep that fills as the long-press arms.

## [1.15.2] — 2026-06-04

### Changed

- **Button label redesign — three-level layout.** All in-flight and idle
  states now use a consistent *main / subtitle / micro-hint* hierarchy
  (same small font for every secondary line):
  - **DISPATCH idle (has route):** `SETUP` + `Collectors (no routes)` at
    hint size (no middle subtitle). `DISPATCH` + `Collectors (n)` when a
    route exists.
  - **DISPATCH in-flight:** `Collectors route` + `to G:S:P 🌙/🪐` +
    `Next` (step 1) or `Send` (step 2).
  - **SEND ALL idle:** `SEND ALL` + `to G:S:P 🌙/🪐` + `(Hold to change
    target)`, or `(Hold to set target)` when no target is chosen yet.
  - **SEND ALL in-flight:** `Collect All` + `to G:S:P 🌙/🪐` + `Next`
    (step 1) or `Send` (step 2).
- **SEND ALL state detection fix.** The button no longer activates its
  collect sequence states when the player manually navigates to the bare
  `?component=fleetdispatch` page — only a URL generated by clicking
  SEND ALL (which carries `galaxy` / `system` / `position` params) now
  triggers the intermediate labels and auto-dispatch logic.

## [1.15.1] — 2026-06-04

### Changed

- **Daily Transport renamed to Daily Resource Run.** The feature, its dashboard
  tab, and its settings section are now consistently named "Daily Resource Run"
  across all UI surfaces.
- **Button labels refreshed.** The top zone now reads **SETUP** (no routes
  configured) or **DISPATCH** with a *Collectors (n)* subtitle. The bottom zone
  now reads **SEND ALL** with a *to G:S:P [moon]* destination line and
  *(Hold to change/set target)* micro-hint.

## [1.15.0] — 2026-06-04

### Added

- **Body inventory capture and route picker.** OG-E now reads your planet and
  moon list from the in-game left bar on each page load and persists a
  snapshot. The dashboard's **Routes editor** now shows a clickable picker for
  both route source and destination instead of manual coordinate entry; you
  see body names (P1, K1) with icons and can click to select. Dead-body
  reconciliation runs automatically — if you abandon a colony or destroy a
  moon, any routes using it as a source or target are pruned, and a route
  that loses all sources or targets is dropped entirely.

- **Fleet-save routes redesign — multi-source + automatic migration.**
  Routes can now depart from **any of your planets or moons** instead of a
  single hardcoded source. Old single-source routes from 1.14.0 are
  automatically migrated. Each route independently tracks its departure
  bodies, so a route can use multiple sources; the collect sequence sends
  from each in turn.

- **Daily Transport button — unified three-zone design.** The floating button
  now combines micro-fleet, target pick, and collect actions in a compact
  two-zone layout with new micro-navigation:
  - **Micro zone** (top-left): send a single small cargo to the route
    destination, if a route exists.
  - **Collect zone** (bottom-right): run the full multi-source fleet-save
    sequence.
  - Current route destination displays under each zone; tapping "no route" on
    the Collect zone opens the dashboard route editor.
  - Real-time **send counter** shows in-flight vs total targets (e.g. `2 ⇄ 5`).
  - **Long-press hint** on smaller viewports to aid mobile discovery.

- **Cross-device route sync.** Your fleet-save routes now sync across devices
  via your private GitHub gist, alongside the other settings and data that
  already sync — set up a route on one device and it appears everywhere.

- **Dashboard fleet-save Routes editor** — full-featured management UI:
  - Click routes in the list to edit or delete.
  - Clickable **source picker** (any of your planets/moons) with names + icons.
  - Clickable **target picker** (any coordinates, any body type).
  - **Save button** with dirty-state indicator — unsaved changes are
    highlighted visually.
  - Reconciliation feedback — removed routes are logged to console when bodies
    disappear.

### Changed

- **Daily Transport button renamed** — previously labeled "Fleet Save" (v1.9.0);
  now correctly named to reflect what it does. The button sends daily cargo
  fleets to your designated target, not a "fleet save" per se.
- **Ship names now display in English** — routes show ship types as "Small
  cargo", "Large cargo", "Pathfinder" instead of Polish (małe, duże, zwiadowca).

### Fixed

- **Dashboard routes remove button styling** — aligned with the button row
  layout.

## [1.14.0] — 2026-06-03

### Added
- **Fleet-save reminders can now be cancelled — but only at the last
  moment.** A 🛡 reminder becomes clickable only in the final **2 minutes**
  before each slot fires (before that it stays the passive auto badge). One
  click cancels just that nearest reminder; any later ones in the series stay.
  The exception: cancelling the **last reminder before landing** also drops
  every at/after-landing reminder — if you're in-game seeing it, the
  post-landing pings are pointless. The cancellation is local and
  self-expiring, and survives the fleet being re-detected on the next scan.

### Fixed
- **Your ntfy topic (and the account-status line) now show on load** in
  Reminders settings, ready to copy — they used to stay blank until you
  edited the token. The async status rows fired their first probe while the
  row was still detached from the page, which then suppressed the real
  paint once it was attached.

## [1.13.0] — 2026-06-02

### Added
- **Trader red glow clears from the Import/Export page.** Opening
  Import/Export and seeing "no more offers today" (the daily container is
  already taken) now clears the red glow for the rest of the day — you no
  longer have to take the container *through* OG-E in the same session for
  the reminder to settle.
- **Trader yellow glow follows the auction clock.** On the Auctioneer page
  between auctions, OG-E reads the "next auction in …" countdown and keeps
  the yellow glow quiet until that auction actually opens — a precise
  replacement for the old fixed ~30-minute guess. While an auction is live,
  the glow is left alone so it still nudges you to bid.

### Changed
- **Reminders settings — "Check now" moved to the master row.** The ntfy
  account-status re-check button now sits on the *Reminders — master switch*
  row (right-aligned, like *Sync now* in Multi-device sync); the status line
  below it is read-only.
- **Reminders settings — per-group gating.** Each reminder group's options
  now grey out when that group's own *enable* is off: the expedition-wave
  schedule follows *Expedition-wave reminders — enable*, the ad-hoc lead time
  follows *Ad-hoc reminders — enable*, and the fleet-save threshold / min
  flight time / schedule follow *Fleet-save reminders — enable*.

## [1.12.0] — 2026-06-02

### Added
- **All your settings now sync across devices.** Cloud sync used to carry
  only scan/colony data; it now also syncs your OG-E preferences through
  your private GitHub gist — **including the ntfy token** — so a second
  device picks up your configuration. Each setting merges independently
  (most-recently-changed wins per setting). Per-device exceptions that never
  sync: the two floating-button sizes and the GitHub token itself.
- **ntfy.sh account status** under the token field: today's usage vs your
  daily limit (`✓ 12 / 250 messages used`) with a **Check now** button, and
  explicit feedback for a wrong/rejected token (`✗ Not a valid token`,
  `✗ Token rejected by ntfy.sh`) instead of silent failure.
- **Your ntfy topic** is now shown in the Reminders settings too (was
  Dashboard-only) — the topic to subscribe to in the ntfy app on your phone,
  right where you enter the token.

### Changed
- **Expedition-wave reminder schedule is now free-form** (default
  `0m, 10m, 30m, 60m`), and **all reminder time fields share one
  minutes-first format** with an optional `s`/`m`/`h` suffix (a bare number
  is minutes). Lead time / min flight read `1m` / `10m`; fleet-save offsets
  read `-10m, 0m, 10m`.
- **Section master switches**: a section's top toggle now greys out the rest
  when off. Multi-device sync (`Sync across devices`) gates the token +
  status; Colonization gates its options. (Expeditions stays independent —
  badges and auto-redirect aren't tied to the floating button.)
- **Multi-device sync layout + feedback**: the **Sync now** button moved onto
  the master row (right-aligned); the status line gets its own full-width row
  with upload/download on one line, updates the **instant** a sync settles
  (a failed sync shows `⚠ HTTP 401: Bad credentials` right away instead of
  after a delay), and the GitHub error is condensed to one line instead of a
  multi-line JSON dump.
- **Reminders settings relabelled** to a consistent `Group — attribute`
  scheme; value input fields widened.
- **Max expeditions per planet** is now a 1–20 slider instead of a text box.
- **Colonization tidied**: the target-positions field documents its range
  syntax (`8,10-12,15`), the "prefer neighbouring galaxies" toggle moved
  above it, and its label was shortened so it no longer wraps.

### Note
- The wave schedule and fleet-save offsets **reset to their defaults** on
  this update (the old formats are incompatible with the new free-form one).
  Re-enter a custom series if you had one.
- Synced settings include your **ntfy token and — if set — the abandon
  password**, stored in your **private** GitHub gist. Private gists are not
  encrypted: anyone with your GitHub token could read them. The GitHub token
  itself is never synced.

## [1.11.1] — 2026-06-02

### Fixed

- **Fleet-save reminders now appear on the Dashboard.** The Reminders tab
  listed expedition waves and ad-hoc fleet reminders but silently omitted
  the auto-detected fleet-saves added in 1.11.0 — the preview had no
  fleet-save section at all, so a detected 🛡 save showed nowhere even
  though its pushes were queued.
- **The Dashboard no longer cancels its own fleet-save pushes.** The tab's
  orphan sweep (which deletes ntfy messages that belong to no live
  reminder) only recognised wave and ad-hoc messages as "ours", so it
  treated every queued fleet-save reminder as a stray and deleted it from
  ntfy — quietly undoing the feature whenever the Dashboard was open. It
  now claims all three reminder kinds.

### Changed

- The extension page is now named **dashboard** on disk (`dashboard.html` /
  `dashboard.js`), retiring the legacy `histogram` filename — it has been
  the multi-tab "OG-E Dashboard" for several releases, not just a
  histogram. Purely an internal/asset rename; the visible name, tabs, and
  data are unchanged, and your saved active-tab preference carries over.

## [1.11.0] — 2026-06-02

### Fixed

- Long fleet-saves now actually fire. A fleet-save detected while its
  landing was still **more than 3 days out** got its 🛡 badge but never a
  push: ntfy.sh refuses delays beyond 3 days, so every reminder slot was
  filtered out at detection — and because the producer skips the sync
  whenever the event list looks unchanged, nothing rescheduled it once the
  fleet finally crossed into the 3-day window (the row's id and arrival
  never change as time passes). The scan signature now tracks when a
  fleet-save's earliest slot enters ntfy's range, so it re-syncs and queues
  the pushes exactly once at that moment. This also closes the matching gap
  for a fleet recalled mid-flight whose return leg is retimed past — or back
  inside — the 3-day cap.

### Changed

- Reminder tooltips now spell out the exact clock times that were
  registered with ntfy, matching the expedition-wave tooltip:
  - **Fleet-save** hover now reads `Fleet-save reminders at: HH:MM, …` (the
    slots actually queued, inside the 3-day cap) followed by `Set
    automatically — can't be cancelled`. The mission, coordinates and ship
    count are dropped from the hover — you already see them in the row; they
    still ride along in the push itself. A save still beyond the cap shows
    the bare auto hint until its first slot comes into range.
  - **Ad-hoc** hover now reads `Reminder at HH:MM — click to cancel` instead
    of the time-less `Reminder armed`.
## [1.10.0] — 2026-06-01

### Changed
- Trader reminder reworked. The Auctioneer and Import/Export reminders are
  now separate glows, and each one clears only when you actually do the
  thing — place a bid / take the container — rather than just by opening
  the Trader menu.
  - Yellow (Auctioneer): glows during auction hours; placing a bid quiets
    it for about half an hour, then it reminds you about the next auction.
  - Red (Import/Export): glows from 14:00 until you take the daily
    container, then resets at midnight. It deliberately stays dark before
    14:00 so it never tempts you to spend your one daily import before the
    afternoon tasks that may need it.
- The glows now also light the matching tiles on the Trader overview
  screen, and the Trader menu button steps aside for OGame's own
  hover/selected styling instead of overriding it.

---

Older releases (≤ 1.9.3) live in [`docs/CHANGELOG-archive.md`](docs/CHANGELOG-archive.md).
