# REFACTOR — share the send-feature orchestration

> Transient plan doc (lifecycle per `CLAUDE.md`: delete once done — git keeps
> the history). Not started yet.

## Goal

The three "send" features each install a floating-action-button module that
drives a fleet through OGame's dispatch flow:

- `src/features/sendExpedition/`
- `src/features/sendColony/`
- `src/features/sendLifeform/`

Their orchestrators (`index.js`, with a `domHelpers.js` and a pure `pure.js`
each) carry **near-identical** sequences for the parts that are *not*
feature-specific: mounting/positioning the FAB, the post-dispatch courier
result-handling around the game's `sendFleet` XHR, and the planet-list
navigation that walks to the next eligible planet. The feature-specific bit
(what gets sent, which slot, which target) is small; the surrounding mechanics
are copied.

Pull the shared mechanics into one place so each feature keeps only its own
decision logic.

## Where the duplication lives

Run a clone check to get exact spans (the bodies drift, so don't trust line
numbers in this doc):

```bash
npx jscpd src/features --min-lines 8 --min-tokens 60 --reporters console
```

Known overlapping areas:

- **Courier result-handling** — the block that reacts to the `sendFleet`
  result event and advances state is shared between `sendColony/index.js`,
  `sendExpedition/index.js`, and `sendLifeform/index.js`.
- **FAB lifecycle / drag mount** — the mount + drag-position wiring. Note the
  button/FAB primitives already live in `src/features/shared/`
  (`button.js`, `buttonChrome.js`, `draggableButton.js`, `unifiedFab*.js`) —
  that is the right home for anything hoisted here.
- **Planet-list walk** — `sendExpedition/domHelpers.js` and
  `dailyRun/domHelpers.js` share a "find the next eligible planet, wrapping
  around the active one" skeleton (differs only in the predicate). A
  `findNextPlanetInList(predicate)` helper would cover both.

## Hard constraint (do not break)

The architecture forbids one feature from importing another (enforced by
ESLint import zones — `npm run lint` will fail on a violation). So shared code
**must** land in:

- `src/features/shared/` — for DOM/orchestration helpers, or
- `src/lib/` — for dependency-free primitives, or
- `src/domain/` — for pure logic only (no DOM, no timers, no `chrome.*`).

Each feature then *delegates* to the shared helper. Do **not** reach across
features.

## Approach

1. Run the clone check; confirm each candidate is genuinely isomorphic before
   extracting (don't unify blocks that only look alike).
2. Extract the shared courier/FAB orchestration into `src/features/shared/`,
   parameterised by the per-feature differences (mission type, target picker,
   labels). Keep the pure decision logic in each feature's `pure.js`.
3. Have all three features delegate to the shared helper; delete the copies.
4. Keep selectors centralised: anything read by two or more features goes in
   `src/lib/gameDom.js` (single source of truth for the fragile game-DOM
   contract).

## Leave alone

`parseCurrentGalaxyView` is duplicated between `sendColony/domHelpers.js` and
`sendLifeform/domHelpers.js` **on purpose** — see the note at the top of
`sendLifeform/domHelpers.js`. The real contract is the selectors (already in
`gameDom.js`), not the function. Don't hoist it unless you decide to revisit
that call.

## Verification

These are core user paths, so build-and-verify in the browser before trusting
it:

```bash
npm run build      # then load dist/ as a temporary add-on against a live game
```

Manually exercise **all three** flows in-game: send expedition, send colony
(incl. the Scan subtext), and send lifeform — confirm the FAB mounts, drags,
dispatches, and the post-send result handling advances correctly.

`npm run lint` + `npm run typecheck` must exit 0. The unit suite is reconciled
to green at release time (see `CLAUDE.md`).

## Done when

- No feature-to-feature import; shared mechanics live under `features/shared/`.
- The three send orchestrators contain only their own decision logic.
- `npm run lint` + `npm run typecheck` clean; the three flows verified in-game.
- A clone re-check shows the shared blocks gone.
