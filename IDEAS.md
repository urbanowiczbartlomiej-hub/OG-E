# IDEAS.md — backlog of future enhancements

Captured ideas for later, not yet designed/built. Unlike the transient
plan docs (`*-AUDIT.md`, `REFACTOR.md`) this is a long-lived backlog: an
entry stays until it ships (then it moves to `CHANGELOG.md` and is deleted
here) or is explicitly dropped. Each entry records the *intent* and the
concrete game-DOM hooks, so a future session can pick it up cold.

Owner: solo dev (see CLAUDE.md). Ideas are in the user's own words,
grounded against the current code at capture time.

---

## 1. Manual "landed FS" marking from the fleet1 screen

**Goal.** Let me mark, on the fleet1 dispatch screen, that the fleet I'm
looking at IS a fleet-save sitting landed on the planet/moon — so it gets
the exposed-FS badge at the body AND the bare-fleet guardian starts
watching it.

**Why it's needed (two gaps the auto-detection can't see):**
- It restores a watch that was cancelled — e.g. a guardian long-press
  ("hold") dismiss, or a re-FS that later got undone — letting me put the
  body back under guard manually.
- A freshly **bought/produced** fleet that has *never flown* is never seen
  in the in-flight event list, so the producer's FS auto-detection
  (`state/fleetSaveSet.js` `readLandedFs` / `writeLandedFs`, gist
  `landedFleetSave`) never flags it. It still sits exposed on the planet
  and needs the same red/exposed marker + guardian coverage.

**Shape (rough).** A manual gesture on the fleet1 screen → write a
`landedFleetSave`-equivalent entry (`bodyKey = g:s:p:type`) so the existing
consumers light up:
- planet badge → exposed-FS marker (`features/badges`, marker category
  `fs`), and
- guardian → arms its watch + ntfy (`features/reminders/guardian.js`,
  `producer.js`).

**Open questions / reconciliation:**
- The auto path is single-writer (the producer owns `landedFleetSave`).
  A manual mark must NOT violate that invariant — feed it through the
  producer / a sanctioned store, not a second writer (see the deleted-
  duplicate lesson in the guardian's history).
- TTL: auto landed-FS self-expires at 120 min. A *manual* mark probably
  wants to persist until I re-FS / disarm, not auto-clear — same TTL
  question already flagged for the guardian.
- See related: planet badges (FS marker), bare-fleet guardian, fleetsave
  reminder.

## 2. Make the FS marker louder — pulse, not just colour

**Goal.** The exposed/landed FS marker shouldn't only be a coloured "FS"
tag — it could **pulse** to draw the eye, because a landed FS is the
dangerous state.

**Note on colour.** I think of it as **red** "FS" letters for the
landed/exposed state. Current convention in `features/badges` is: yellow
"FS" = in motion (saving), **orange** "FS" = landed & exposed. Reconcile:
either escalate landed to red, or keep orange and add the pulse. Decide at
design time — don't silently diverge from the badge palette.

**Shape.** CSS pulse animation on the FS badge element (OG-E's own injected
class — not a game-DOM contract, lives next to the badge code). Cheap, pure
DOM, zero ntfy.

## 3. Expedition button — detect AGR expeditions routine is OFF

**Goal.** When `#ago_routine_7` is absent on the fleet1 screen, an
expedition can't be sent. Instead of silently failing, paint an **error
label on the button**: tell me to enable Expeditions in AGR's fleet
settings.

**Grounding (current code).** `features/sendExpedition/index.js` drives
AGR's `#ago_routine_7` (Phase 2: `runPhase2` waits for
`#ago_routine_7 .ago_routine_check`). When the routine never appears it
currently just resets to the idle `BUTTON_TEXT` and unlocks — no diagnosis.
The idea is to distinguish "AGR expeditions routine disabled" (routine
element truly absent) from a transient timeout, and show the specific
"enable Expeditions in AGR" hint in that case.

## 4. Bare-fleet button — actually perform the FS send (AGR routine 6)

**Goal.** Extend the bare-fleet guardian button beyond "navigate to the
body": let it **send the fleet save** the same way the expedition button
sends an expedition. Navigate to the body + fleet1, click AGR's fleet-save
routine `#ago_routine_6` (AGR assigns mission/fleet, transitions to
fleet2), then dispatch.

**Plus a guard.** Detect when `#ago_routine_6` is absent → AGR fleet-save
is not enabled → show the analogous "enable Fleet Save in AGR" error,
mirroring idea #3.

**Grounding.** Pattern already exists for expeditions in
`features/sendExpedition/index.js` (`#ago_routine_7`, two-tap
prepare→dispatch). The guardian button today only navigates
(`features/reminders/guardian.js`, tap = go to body). This makes it
actionable: one place to re-secure the bare fleet.

## 5. Daily Run micro — zero resources + force 100 % speed on fleet2

**Goal.** When the Daily Run **micro** fleet reaches fleet2, before
dispatch: zero the three loaded resources and select 100 % speed. A micro
probe must carry nothing and fly full speed.

**Concrete hooks (from the live fleet2 / AGR `flightDetails` DOM):**
- Resources → set to 0: inputs `#ago_metal`, `#ago_crystal`,
  `#ago_deuterium` (also `#ago_food` if present). Equivalent to AGR's
  "none" reset (`#noneresources`, `ago-data {"action":"setNone"}`).
- Speed → 100 %: click the speed link
  `#speedLinks div[data-value="10"]` (`ago-data {"speed":10}`) so it gets
  the `selected` class.

**Grounding.** Micro send flows through the shared courier
(`features/shared/fleetCourier.js` / `bridges/fleetExecutor.js`,
`features/dailyRun`). Today resources are handled via native
`#allresources` for the *collect* mode; micro needs the opposite — an
explicit zero-out + 100 % speed step. Confirm whether to drive the AGR
`#ago_*` inputs or native equivalents at design time (AGR present in my
setup; native equivalents exist for resources via `#noneresources`).
