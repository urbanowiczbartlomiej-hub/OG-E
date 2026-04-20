// OG-E: client-side response handling for sendFleet — runs in MAIN world.
//
// This script does not make any HTTP requests. It hooks the game's sendFleet
// XHR (which the GAME itself issues when the user clicks "Wyślij flotę") for
// two independent purposes:
//
// 1. EXPEDITION (mission=15): rewrite the redirectUrl field in the response
//    payload so the browser navigates to the next planet that doesn't yet
//    have an expedition in flight — saving the user from manually switching
//    planets between sends. Pure client-side, no extra request. The user can
//    disable this in settings ("After sending expedition, open the next
//    planet" — default on).
//
// 2. COLONIZE (mission=7): passively observe the dispatch and forward the
//    arrival time (read from the already-rendered #durationOneWay DOM node,
//    no request) to the isolated world via the oge:colonizeSent event.
//    content.js writes it to oge_colonizationRegistry, which mobile.js
//    consults to enforce the user's oge_colMinGap setting on subsequent
//    colonization sends. ALWAYS active — independent of the expedition
//    toggle, because disabling it would silently break min-gap timing.
//
// Neither path issues new HTTP requests; both modify only client-side state.
(() => {
  if (!location.search.includes('component=fleetdispatch')) return;

  const STORAGE_KEY = 'oge_autoRedirectExpedition';
  const MISSION_EXPEDITION = '15';
  const MISSION_COLONIZE = '7';

  // ── Preference (only governs expedition redirect rewrite) ──

  const isExpeditionRedirectEnabled = () => {
    try { return localStorage.getItem(STORAGE_KEY) !== 'false'; }
    catch { return true; }
  };

  /**
   * Find the next planet in `#planetList` order (after the currently active
   * one) that doesn't have an active expedition. Used to compute the rewritten
   * `redirectUrl` so the user lands on the next available planet without
   * manual switching between expedition sends.
   *
   * The check `.ogi-exp-dots` looks for the badge content.js renders next
   * to planets with active expeditions — DOM-level signal, no network.
   *
   * @returns {string|null}  cp id of the target planet, or null if all planets
   *                         already have expeditions / cannot find current
   */
  const findNextPlanetWithoutExpedition = () => {
    const planets = [...document.querySelectorAll('#planetList .smallplanet')];
    if (planets.length < 2) return null;

    const currentIdx = planets.findIndex((el) => el.classList.contains('hightlightPlanet'));
    if (currentIdx === -1) return null;

    for (let i = 1; i < planets.length; i++) {
      const planet = planets[(currentIdx + i) % planets.length];
      if (!planet.querySelector('.ogi-exp-dots')) {
        const cpId = planet.id.replace('planet-', '');
        if (cpId) return cpId;
      }
    }

    return null; // all planets already have expeditions
  };

  const buildRedirectUrl = (cpId) =>
    location.href.split('?')[0] + '?page=ingame&component=fleetdispatch&cp=' + cpId;

  /**
   * Parse `#durationOneWay`'s textContent into seconds. The game renders this
   * element with the format `H:MM:SS` (3 parts) for sub-day flights or
   * `D:H:MM:SS` (4 parts) for longer ones — e.g. `01:50:48` = 6648s.
   *
   * Defensive: returns 0 if the element is null, the textContent has any
   * non-numeric chunks (NaN propagates), or the part-count doesn't match an
   * expected format. Caller treats 0 as "duration unknown" → no min-gap
   * registry entry.
   *
   * Must be called at TIME OF SEND — the game may overwrite the DOM after
   * receiving the sendFleet response.
   *
   * @param {Element|null} durEl  the `#durationOneWay` element (may be null)
   * @returns {number}  duration in seconds, or 0 if unparseable
   */
  const parseDurationSeconds = (durEl) => {
    if (!durEl) return 0;
    const parts = durEl.textContent.trim().split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 4) return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
    return 0;
  };

  // ── XHR hook ──

  const hookXHR = () => {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    const responseTextDescriptor = Object.getOwnPropertyDescriptor(
      XMLHttpRequest.prototype, 'responseText'
    );

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._oge_url = typeof url === 'string' ? url : String(url);
      return nativeOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body, ...rest) {
      if (this._oge_url?.includes('action=sendFleet') && body) {
        const mission = new URLSearchParams(String(body)).get('mission');

        // ─── EXPEDITION: rewrite redirectUrl to next planet without expedition ───
        // Active only when user has the toggle enabled.
        if (mission === MISSION_EXPEDITION && isExpeditionRedirectEnabled()) {
          let cached = null;

          Object.defineProperty(this, 'responseText', {
            configurable: true,
            get() {
              if (cached !== null) return cached;
              const raw = responseTextDescriptor.get.call(this);
              if (!raw) return raw;

              try {
                const resp = JSON.parse(raw);
                if (resp.success && resp.redirectUrl) {
                  const nextCp = findNextPlanetWithoutExpedition();
                  if (nextCp) {
                    resp.redirectUrl = buildRedirectUrl(nextCp);
                    cached = JSON.stringify(resp);
                    return cached;
                  }
                }
              } catch {}

              return raw;
            },
          });
        }

        // ─── COLONIZE: pre-register (sync, localStorage) + dispatch event ───
        // Independent of the expedition toggle — gates min-gap timing for
        // subsequent colonization sends. We do NOT rewrite the response; the
        // game's natural post-send navigation is preserved.
        //
        // Why pre-register into localStorage BEFORE nativeSend:
        //   On mobile, the game navigates (`location.href = redirectUrl`)
        //   synchronously after reading the XHR response, often before our
        //   async `chrome.storage.local.set` callback has a chance to run.
        //   Result: registry writes get lost, `findNextColonizeTarget` picks
        //   the same coords again, the user double-sends. Desktop's faster JS
        //   engine completes the async write before the nav and masks the bug.
        //
        //   Solution: localStorage is SYNCHRONOUS — the write is committed
        //   within this JS tick, guaranteed to survive the imminent nav.
        //   localStorage becomes the primary source of truth for in-flight
        //   coords; the `oge:colonizeSent` event still fires so content.js
        //   can mark `empty_sent` in oge_galaxyScans (eventual consistency —
        //   scans are large and stay in chrome.storage for Gist sync, but
        //   the registry in localStorage is already the blocking guard).
        //
        //   Trade-off: if nativeSend throws (very rare — most send failures
        //   arrive as error events, not sync throws), we'd leave a ghost
        //   entry that blocks min-gap until arrivalAt elapses. Auto-prune
        //   cleans it up on the next write. Acceptable in exchange for
        //   fixing the mobile race.
        if (mission === MISSION_COLONIZE) {
          // Capture flight duration AT TIME OF SEND — the form DOM still
          // reflects this dispatch's values. Reading later (e.g. in a load
          // handler) is unsafe because the game may rewrite the form.
          const sentAt = Date.now();
          const durSec = parseDurationSeconds(document.getElementById('durationOneWay'));
          const arrivalAt = durSec > 0 ? sentAt + durSec * 1000 : 0;

          const params = new URLSearchParams(location.search);
          const g = parseInt(params.get('galaxy'), 10);
          const s = parseInt(params.get('system'), 10);
          const p = parseInt(params.get('position'), 10);

          // Pre-register in localStorage (SYNC, race-free vs navigation)
          if (g && s && arrivalAt > 0) {
            try {
              const raw = localStorage.getItem('oge_colonizationRegistry') || '[]';
              const reg = JSON.parse(raw).filter(r => (r.arrivalAt || 0) > Date.now());
              const coords = g + ':' + s + ':' + (p || 0);
              const isDup = reg.some(r =>
                r.coords === coords && Math.abs((r.sentAt || 0) - sentAt) <= 2000
              );
              if (!isDup) {
                reg.push({ coords, sentAt, arrivalAt });
                localStorage.setItem('oge_colonizationRegistry', JSON.stringify(reg));
              }
            } catch {}
          }

          // Fire event AFTER response for content.js to update scans[pos]='empty_sent'.
          // { once: true } guards against duplicate dispatch if the XHR object ever gets reused.
          this.addEventListener('load', () => {
            try {
              const resp = JSON.parse(responseTextDescriptor.get.call(this));
              if (!resp || !resp.success) return;
              if (!g || !s) return;

              document.dispatchEvent(new CustomEvent('oge:colonizeSent', {
                detail: { galaxy: g, system: s, position: p || 0, sentAt, arrivalAt }
              }));
            } catch {}
          }, { once: true });
        }
      }

      return nativeSend.call(this, body, ...rest);
    };
  };

  // ── Boot ──

  const waitFor = (predicate, cb, timeout = 10_000, interval = 100) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (predicate()) { clearInterval(id); cb(); }
      else if (Date.now() - start > timeout) clearInterval(id);
    }, interval);
  };

  waitFor(() => window.fleetDispatcher, () => {
    hookXHR();
  });
})();
