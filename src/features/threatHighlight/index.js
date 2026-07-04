// @ts-check
//
// Under-attack highlight — a deliberately LOUD, full-screen banner inside the
// OPEN OGame tab the instant OGame flags an inbound attack. Off by default;
// opt-in from the Display settings section, with a "Preview" button so the
// player can see what it looks like before committing.
//
// # Strictly an in-tab rendering — NOT an "threat highlight"
//
// This feature only makes the attack info OGame ALREADY shows (the top-bar
// flag) impossible to miss for a player who is looking at the open tab. It is
// deliberately scoped to stay on the fair-play side of the line:
//   - NO off-tab signal — it does not touch the browser tab title or favicon,
//     and it sends NO push / notification of any kind. It cannot reach a player
//     who is away from this tab, so it never tells anyone about an attack they
//     wouldn't already see at the keyboard.
//   - NOT wired to ntfy / the Alarm clock in any way.
//   - default OFF (opt-in), so nobody gets it unasked;
//   - the full-screen layer is `pointer-events:none`, so it NEVER blocks the
//     clicks you need to defend yourself;
//   - it is dismissible, and a dismissal only sticks until the attack changes.
//
// `features/eventMenuHighlight.js` once painted a similar full-screen banner for
// ordinary event-ticker items and it was REMOVED in v1.3.6 for being disruptive
// during normal play. The difference: that fired on every expedition return;
// THIS fires only on a genuine incoming attack — rare and genuinely critical.
//
// # Detection (two signals)
//
//   A. PRIMARY — the top-bar flag `#attack_alert`. OGame drops its `noAttack`
//      class the moment an attack is inbound (see pure.isUnderAttack). It can
//      flip WITHOUT a page reload, so we watch it with a MutationObserver on
//      its `class` attribute (instant) plus a slow `setInterval` fallback that
//      re-resolves + re-binds the node after OGame's AJAX navigations.
//   B. ENRICHMENT — the event list (`#eventContent`). On every
//      `oge:eventBoxLoaded` we parse the hostile attack legs for the banner's
//      count / soonest-ETA / target coords. The flag alone (A) is enough to
//      raise the alarm; (B) just fills in the details.
//
// Layering: feature layer — reads game DOM + settings, mounts its own UI.
// `#attack_alert` / `noAttack` are read by THIS feature only, so they stay
// local here rather than in `lib/gameDom.js` (single-feature-selector rule).

import { injectStyle } from '../../lib/dom.js';
import { clock } from '../../lib/clock.js';
import { GAME } from '../../lib/gameDom.js';
import { denseCoords } from '../../domain/bodies.js';
import { settingsStore } from '../../state/settings.js';
import { EVENT_BOX_LOADED_EVENT, THREAT_HIGHLIGHT_TEST_EVENT } from '../../lib/ogeEvents.js';
import {
  isUnderAttack,
  summarizeAttacks,
  attackFingerprint,
  formatEta,
} from './pure.js';

const STYLE_ID = 'oge-threat-highlight-style';
const OVERLAY_ID = 'oge-threat-overlay';
const BANNER_ID = 'oge-threat-banner';

/** OGame top-bar attack flag. Single-feature selector — kept local. */
const ATTACK_ALERT_ID = 'attack_alert';

/** How long a "Preview" runs before auto-clearing (ms). */
const PREVIEW_MS = 10000;

/** Slow fallback re-check; the MutationObserver is the fast path. */
const POLL_MS = 25000;

const CSS = `
@keyframes oge-threat-vig {
  0%, 100% { opacity: .35; }
  50% { opacity: 1; }
}
@keyframes oge-threat-ban {
  0%, 100% { background: #c20f0f; }
  50% { background: #6e0404; }
}
#${OVERLAY_ID} {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  pointer-events: none;
  border: 7px solid #ff1f1f;
  box-shadow: inset 0 0 70px 16px rgba(255, 20, 20, .7);
  animation: oge-threat-vig 1.2s ease-in-out infinite;
}
#${BANNER_ID} {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 2147483601;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  color: #fff5f5;
  font: bold 14px Verdana, Arial, sans-serif;
  letter-spacing: .3px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .55);
  animation: oge-threat-ban 1.2s ease-in-out infinite;
}
#${BANNER_ID} .oge-threat-x {
  flex: 0 0 auto;
  margin-left: auto;
  background: rgba(0, 0, 0, .25);
  border: 1px solid rgba(255, 255, 255, .55);
  color: #fff;
  border-radius: 4px;
  font: bold 13px Verdana, sans-serif;
  line-height: 1;
  padding: 3px 9px;
  cursor: pointer;
}
@media (prefers-reduced-motion: reduce) {
  #${OVERLAY_ID} { animation: none; opacity: 1; }
  #${BANNER_ID} { animation: none; }
}
`;

/**
 * Idempotency sentinel — `{ dispose }` while installed, `null` otherwise.
 *
 * @type {{ dispose: () => void } | null}
 */
let installed = null;

/**
 * Install the threat highlight. Idempotent — a second call returns the existing
 * dispose fn. Top-frame only at the call site (`content.js`).
 *
 * @returns {() => void} dispose
 */
export const installThreatHighlight = () => {
  if (installed) return installed.dispose;

  injectStyle(STYLE_ID, CSS);

  /** @type {HTMLDivElement | null} */ let overlay = null;
  /** @type {HTMLDivElement | null} */ let banner = null;
  /** @type {HTMLSpanElement | null} */ let bannerText = null;

  let visible = false; // any alarm (real OR preview) is currently on screen
  let previewActive = false;
  let previewTimer = 0;
  let tick = 0; // 1s interval: refresh the in-banner ETA countdown

  // Fingerprint the user dismissed; '' = not muted. While muted with an
  // unchanged fingerprint we stay quiet; a new/earlier wave changes it and
  // re-fires the alarm.
  let mutedFingerprint = '';

  /** @type {import('./pure.js').AttackSummary} */
  let lastSummary = { count: 0, soonestArrivalAt: 0, targets: [] };

  /** @type {MutationObserver | null} */ let mo = null;

  // ── event-list enrichment (signal B) ─────────────────────────────────────
  const parseEventList = () => {
    const rows = Array.from(document.querySelectorAll(GAME.EVENT_FLEET_ROWS));
    const legs = rows.map((row) => {
      const dest = denseCoords(row.querySelector(GAME.COORDS_DEST)?.textContent);
      return {
        missionType: row.getAttribute('data-mission-type') || '',
        isReturn: row.getAttribute('data-return-flight') === 'true',
        isHostile: Boolean(row.querySelector(GAME.ROW_HOSTILE)),
        arrivalAt: parseInt(row.getAttribute('data-arrival-time') || '', 10),
        target: dest ? `[${dest}]` : '',
      };
    });
    lastSummary = summarizeAttacks(legs);
  };

  // ── banner text ──────────────────────────────────────────────────────────
  const paintBanner = () => {
    if (!bannerText) return;
    if (previewActive) {
      bannerText.textContent =
        'UNDER ATTACK — preview (test). This is what a real attack looks like.';
      return;
    }
    const { count, soonestArrivalAt, targets } = lastSummary;
    /** @type {string[]} */
    const parts = [];
    if (count > 0) parts.push(`${count} hostile fleet${count > 1 ? 's' : ''}`);
    if (soonestArrivalAt > 0) {
      parts.push(`soonest ${formatEta(soonestArrivalAt - Math.floor(Date.now() / 1000))}`);
    }
    if (targets.length) parts.push(targets.slice(0, 3).join(' '));
    bannerText.textContent = parts.length ? `UNDER ATTACK — ${parts.join(' · ')}` : 'UNDER ATTACK';
  };

  // ── show / hide the visual + page chrome ─────────────────────────────────
  const show = () => {
    buildEls();
    if (!visible) {
      visible = true;
      if (overlay) overlay.style.display = 'block';
      if (banner) banner.style.display = 'flex';
      if (!tick) tick = window.setInterval(onTick, 1000);
    }
    paintBanner();
  };

  const hide = () => {
    if (!visible) return;
    visible = false;
    if (overlay) overlay.style.display = 'none';
    if (banner) banner.style.display = 'none';
    if (tick) {
      clearInterval(tick);
      tick = 0;
    }
  };

  // 1s tick — live-refresh the in-banner ETA countdown. Deliberately does NOT
  // touch the tab title or favicon: this highlight is in-tab only.
  const onTick = () => {
    if (document.hidden) return; // no repaint while the tab is hidden
    paintBanner();
  };

  // ── user actions on the banner ───────────────────────────────────────────
  const onDismiss = () => {
    if (previewActive) {
      endPreview();
      return;
    }
    // Mute THIS attack until it changes or ends; re-fires when the
    // fingerprint moves (new wave / earlier arrival).
    mutedFingerprint = attackFingerprint(lastSummary);
    hide();
  };

  const onBannerClick = () => {
    if (previewActive) {
      endPreview();
      return;
    }
    // Jump to a page where the attack is actionable. The overview shows the
    // attack too; the relative URL works on any OGame server.
    window.location.assign(`${window.location.pathname}?page=ingame&component=overview`);
  };

  const buildEls = () => {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;

    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'alert');
    banner.addEventListener('click', onBannerClick);

    const icon = document.createElement('span');
    icon.textContent = '🚨';
    icon.style.cssText = 'flex:0 0 auto;font-size:18px;';

    bannerText = document.createElement('span');
    bannerText.style.cssText = 'flex:1 1 auto;';

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'oge-threat-x';
    x.textContent = '✕';
    x.title = 'Dismiss (re-appears if the attack changes)';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      onDismiss();
    });

    banner.appendChild(icon);
    banner.appendChild(bannerText);
    banner.appendChild(x);

    document.body.appendChild(overlay);
    document.body.appendChild(banner);
  };

  // ── preview (test) ───────────────────────────────────────────────────────
  const runPreview = () => {
    if (visible && !previewActive) return; // a real alarm is up — don't disturb it
    previewActive = true;
    show();
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = window.setTimeout(endPreview, PREVIEW_MS);
  };

  const endPreview = () => {
    if (!previewActive) return;
    previewActive = false;
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = 0;
    }
    // Fall back to reality: if an attack is genuinely ongoing, checkAttack
    // keeps the alarm up (now with real data); otherwise it hides cleanly.
    checkAttack();
    // checkAttack() returns early (feature off) BEFORE it would hide a
    // stray preview banner, so mirror the settings-subscriber path above
    // (lines 366-369) and force-hide here when the toggle is off.
    if (!settingsStore.get().threatHighlight) hide();
  };

  // ── core decision ────────────────────────────────────────────────────────
  const checkAttack = () => {
    // Presence gate: never read the game's attack flag / event list while the
    // player is away (the ToolDev toleration condition). The visibility-paused
    // poll snaps and re-checks on return.
    if (document.hidden) return;
    const el = document.getElementById(ATTACK_ALERT_ID);
    const under = isUnderAttack(el ? el.className : null);

    if (!under) {
      mutedFingerprint = ''; // attack cleared — forget any dismissal
      if (visible && !previewActive) hide();
      return;
    }
    if (!settingsStore.get().threatHighlight) return; // feature off — ignore real attacks

    parseEventList();
    const fp = attackFingerprint(lastSummary);
    if (mutedFingerprint && fp === mutedFingerprint) {
      if (visible && !previewActive) hide();
      return;
    }
    mutedFingerprint = ''; // new / escalated — un-mute
    if (!previewActive) show();
  };

  // ── wiring ───────────────────────────────────────────────────────────────
  const bindAlertObserver = () => {
    const el = document.getElementById(ATTACK_ALERT_ID);
    if (!el) return;
    if (mo) mo.disconnect();
    mo = new MutationObserver(() => checkAttack());
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  };

  // Slow safety re-check on the shared visibility-aware clock: it PAUSES while
  // the tab is hidden (zero background polling of the attack flag) and fires
  // once on return — re-binding the observer and re-checking. POLL_MS rounds up
  // to the clock's base grid.
  const unsubPoll = clock.subscribe(() => {
    bindAlertObserver(); // re-bind if OGame replaced the node on an AJAX nav
    checkAttack();
  }, { everyMs: POLL_MS });

  const onEventBox = () => checkAttack();
  const onTest = () => runPreview();

  document.addEventListener(EVENT_BOX_LOADED_EVENT, onEventBox);
  document.addEventListener(THREAT_HIGHLIGHT_TEST_EVENT, onTest);

  // While hidden, stop observing the attack flag altogether (the clock already
  // paused the poll); the snap-on-return re-binds it via the poll subscriber.
  const onVisibility = () => {
    if (document.hidden && mo) { mo.disconnect(); mo = null; }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const unsubSettings = settingsStore.subscribe(() => {
    if (previewActive) return;
    if (!settingsStore.get().threatHighlight) {
      mutedFingerprint = '';
      if (visible) hide();
      return;
    }
    checkAttack();
  });

  // Bind + first check only if the player is actually here; if the tab loads
  // hidden, the clock's snap-on-return binds + checks when they arrive.
  if (!document.hidden) {
    bindAlertObserver();
    checkAttack();
  }

  const dispose = () => {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    unsubPoll();
    document.removeEventListener('visibilitychange', onVisibility);
    if (tick) {
      clearInterval(tick);
      tick = 0;
    }
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = 0;
    }
    unsubSettings();
    document.removeEventListener(EVENT_BOX_LOADED_EVENT, onEventBox);
    document.removeEventListener(THREAT_HIGHLIGHT_TEST_EVENT, onTest);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    overlay = banner = bannerText = null;
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    visible = false;
    previewActive = false;
    installed = null;
  };

  installed = { dispose };
  return dispose;
};

/**
 * Test-only reset for the module-scope install handle.
 *
 * @returns {void}
 */
export const _resetThreatHighlightForTest = () => {
  if (installed) installed.dispose();
  installed = null;
};
