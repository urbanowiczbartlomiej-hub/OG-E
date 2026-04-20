// OG-E: passive XHR observer — runs in MAIN world.
//
// This script does not make any HTTP requests. It listens to XHR responses for
// two endpoints that the GAME itself calls (in reaction to user navigation):
//
//   1. fetchGalaxyContent — fired by the game every time the user opens a
//      galaxy system view. We parse the response (15 position records) and
//      forward the data to the isolated world via the oge:galaxyScanned
//      custom event. mobile.js / content.js store it locally so the user can
//      review their past observations in the histogram page.
//
//   2. checkTarget — fired by the game when the user (or a link they clicked)
//      loads fleetdispatch with target coords. The response tells us whether
//      colonization is currently possible there. We forward that via
//      oge:checkTargetResult. mobile.js uses it to update the local database
//      if a position we previously saw as empty is now occupied — then shows
//      the user a "Stale — click Send" label so they can choose the next
//      candidate from the database.
//
// Schema v2: the galaxyScanned event carries a positions map for ALL 15
// positions in the system (status + optional player metadata + flags).
// Target-position filtering happens later in mobile.js when the user is
// looking for a place to colonize — the local database holds the full picture
// of what the user has observed.
(() => {
  const COL_MISSION = 7;

  // ── XHR hook: intercept galaxy content responses ──

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._oge_url = typeof url === 'string' ? url : String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };

  // Helper: parse a URL-encoded form body into a plain object (used by checkTarget hook)
  const parseFormBody = (body) => {
    const out = {};
    if (typeof body !== 'string') return out;
    for (const pair of body.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    }
    return out;
  };

  XMLHttpRequest.prototype.send = function (body, ...rest) {
    if (this._oge_url?.includes('fetchGalaxyContent')) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          if (data?.system?.galaxyContent) analyzeGalaxyResponse(data);
        } catch {}
      });
    }

    // Hook checkTarget XHR: every time the user (or our setFleetTarget helper)
    // changes the galaxy/system/position fields on fleetdispatch, the game fires
    // this. The response tells us whether the colonize mission is available
    // there. mobile.js uses this to detect stale DB entries WITHOUT triggering
    // a page reload (the old approach was a bot-detection nightmare).
    if (this._oge_url?.includes('action=checkTarget')) {
      // Capture the body so we know which target was checked (galaxy/system/position)
      const requestBody = typeof body === 'string' ? body : '';
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          if (!data) return;
          const params = parseFormBody(requestBody);
          // Dispatch BOTH success and failure results — failure carries
          // `errorCodes` (e.g. [140016] for "reserved for planet move") which
          // mobile.js uses to distinguish reserved slots from generic stale.
          document.dispatchEvent(new CustomEvent('oge:checkTargetResult', {
            detail: {
              galaxy: parseInt(params.galaxy, 10),
              system: parseInt(params.system, 10),
              position: parseInt(params.position, 10),
              success: data.status === 'success',
              targetOk: !!data.targetOk,
              targetInhabited: !!data.targetInhabited,
              targetPlayerId: data.targetPlayerId || 0,
              targetPlayerName: data.targetPlayerName || '',
              orders: data.orders || {},
              errorCodes: (data.errors || []).map(e => e.error).filter(Boolean),
            },
          }));
        } catch {}
      });
    }

    return nativeSend.call(this, body, ...rest);
  };


  // ── Self detection ──
  // Try to find OUR player ID — used to mark `mine` positions.
  // window.playerId is set by OGame on game pages.
  const getOwnPlayerId = () => {
    try {
      if (typeof window.playerId !== 'undefined') return window.playerId;
    } catch {}
    return null;
  };

  /**
   * Detect whether our active planet currently has at least one colony ship.
   * The game's galaxyContent response includes per-position `availableMissions`
   * lists; mission 7 (colonize) link is "#" if no colony ship is available
   * from the current planet. We sample any empty position and check.
   *
   * Used by `oge:galaxyScanned` consumers (Send Col UI label, "No ship!" warning).
   *
   * @param {object[]} galaxyContent  raw `data.system.galaxyContent` from fetchGalaxyContent
   * @returns {boolean}  true if mission 7 has a real link in any candidate slot
   */
  const hasColonyShip = (galaxyContent) => {
    for (const pos of galaxyContent) {
      const isPlayerEmpty = pos.player && pos.player.playerId === 99999;
      const hasPlanets = pos.planets && pos.planets.length > 0;
      if (!isPlayerEmpty && hasPlanets) continue;
      const colMission = (pos.availableMissions || []).find(m => m.missionType === COL_MISSION);
      if (colMission) return colMission.link && colMission.link !== '#';
    }
    return false;
  };

  /**
   * Convert a single entry from the game's `galaxyContent` array into our
   * canonical Position shape. This is THE place where the game's per-flag
   * fields collapse into our 10-state status enum + independent flag set.
   *
   * Status priority (when there's a live planet with a player):
   *   mine → admin → banned → vacation → long_inactive → inactive → occupied
   *
   * No-live-planet branches:
   *   - Has destroyed planet remains      → 'abandoned'
   *   - Otherwise                         → 'empty'
   *
   * Flags (computed independently, attached only if any are true):
   *   hasAbandonedPlanet, hasMoon, hasDebris, inAlliance
   *
   * @param {object} entry        one element of `data.system.galaxyContent`
   * @param {number|null} ownPlayerId  our player ID (used to detect 'mine')
   * @returns {{status: string, player?: {id: number, name: string}, flags?: object}}
   * @see SCHEMAS.md#oge_galaxyscans (PositionStatus enum)
   */
  const classifyPosition = (entry, ownPlayerId) => {
    const out = { status: 'empty' };

    const planets = entry.planets || [];
    const player = entry.player || null;
    const livePlanets = planets.filter(p => !p.isDestroyed);

    // Flags (computed independently of status)
    const flags = {};
    if (planets.some(p => p.isDestroyed)) flags.hasAbandonedPlanet = true;
    if (planets.some(p => p.isMoon || p.luna)) flags.hasMoon = true;
    if (entry.debris || planets.some(p => p.debris)) flags.hasDebris = true;
    if (player && player.allyId) flags.inAlliance = true;
    if (Object.keys(flags).length) out.flags = flags;

    // Status: distinguish truly empty from "destroyed planet remains"
    if (livePlanets.length === 0) {
      out.status = flags.hasAbandonedPlanet ? 'abandoned' : 'empty';
      return out;
    }

    // Has live planet(s) — figure out who owns it
    if (player && ownPlayerId && player.playerId === ownPlayerId) {
      out.status = 'mine';
      return out;
    }

    if (player) {
      out.player = { id: player.playerId, name: player.playerName };
      if (player.isAdmin) out.status = 'admin';
      else if (player.isBanned) out.status = 'banned';
      else if (player.isOnVacation) out.status = 'vacation';
      else if (player.isLongInactive) out.status = 'long_inactive';
      else if (player.isInactive) out.status = 'inactive';
      else out.status = 'occupied';
    } else {
      // Live planet but no player object — unusual, treat as occupied
      out.status = 'occupied';
    }

    return out;
  };

  /**
   * Process the parsed `fetchGalaxyContent` JSON response: classify every
   * non-empty entry into our schema, fill the 1..15 positions map, and
   * dispatch a single `oge:galaxyScanned` event for downstream consumers
   * (mobile.js for UI, content.js for storage merge).
   *
   * @param {object} data  parsed game response (`{ system: { galaxy, system, galaxyContent, canColonize? }, ... }`)
   * @see SCHEMAS.md#ogegalaxyscanned
   */
  const analyzeGalaxyResponse = (data) => {
    const galaxy = data.system.galaxy;
    const system = data.system.system;
    const content = data.system.galaxyContent || [];
    const ownPlayerId = getOwnPlayerId();

    // `reservedPositions` is a top-level field in the system response
    // (NOT nested under galaxyContent entries). Keys are position ids as
    // strings; values carry { cooldown, user_id, isReserved }. Another
    // player paid DarkMatter to reserve the slot for a planet move — slot
    // looks empty in galaxyContent but colonize attempts will fail with
    // checkTarget error 140016 "Planeta została już zarezerwowana".
    const reservedRaw = data.system.reservedPositions || {};
    const reservedSet = new Set(
      Object.keys(reservedRaw)
        .filter(k => reservedRaw[k]?.isReserved)
        .map(k => parseInt(k, 10))
    );

    const positions = {};
    for (const entry of content) {
      const pos = entry.position;
      if (!pos || pos < 1 || pos > 15) continue;
      const classified = classifyPosition(entry, ownPlayerId);
      // Overlay 'reserved' on top of what would otherwise be 'empty'.
      // Non-empty slots can't be reserved for move in practice, but be
      // defensive anyway (classifyPosition wins for those).
      if (reservedSet.has(pos) && classified.status === 'empty') {
        classified.status = 'reserved';
      }
      positions[pos] = classified;
    }

    // canColonize tells the Send Col UI whether we have a colony ship right now.
    // It's a transient page-state field, not stored per-position.
    const canColonize = data.system.canColonize !== undefined
      ? data.system.canColonize
      : hasColonyShip(content);

    document.dispatchEvent(new CustomEvent('oge:galaxyScanned', {
      detail: {
        galaxy, system,
        scannedAt: Date.now(),
        positions,
        canColonize,
      },
    }));
  };
})();
