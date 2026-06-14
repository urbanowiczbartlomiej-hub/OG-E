// DOM helpers used throughout the content script layer.
//
// Three tiny primitives, each solving a distinct real-world wart:
//
//   • safeClick — activates a link/button while side-stepping CSP.
//     OGame (and many embedders) ship a strict `script-src` policy that
//     blocks `javascript:` URL navigations. A bare `el.click()` on an
//     `<a href="javascript:...">` therefore gets swallowed silently. We
//     strip the href first so the click still fires its listeners but
//     the browser has nothing forbidden to navigate to.
//
//   • waitFor — polls a predicate until it returns something truthy or a
//     timeout elapses. Used for DOM readiness handshakes where the game
//     injects nodes asynchronously and neither MutationObserver nor
//     `DOMContentLoaded` gives us a clean signal. Returns the predicate's
//     truthy value so the caller doesn't have to query twice.
//
//   • injectStyle — idempotently appends a `<style id="...">` element.
//     Features can call it on every page transition without leaking
//     duplicate rules, and it survives content-scripts running at
//     `document_start` (where `document.head` may not exist yet) by
//     falling back to `document.documentElement`.

/** @ts-check */

/**
 * Click an element, first stripping a `javascript:` href so the click
 * event fires even when the page's CSP forbids inline script URLs,
 * then restoring the original attribute so the element's CSS shape
 * survives unchanged.
 *
 * # Why restore the href
 *
 * AGR (and similar host scripts) style their menu items via attribute
 * selectors — typically `a[href]` or `a[href^="javascript:"]` carry
 * the background, padding, and active-state rules. Leaving the
 * attribute removed after a click silently strips the element of
 * every dependent CSS rule, which looks to the user like "the menu
 * lost its background and shifted left". `.click()` is synchronous —
 * the event dispatch and every sync listener finish before this
 * function returns — so writing the original href back immediately
 * after the call is safe: handlers that ran during dispatch did so
 * with the href absent (avoiding the CSP-blocked navigation), and
 * the DOM is back to its original shape by the time anyone else
 * reads it.
 *
 * We read the href through `getAttribute('href')` rather than `el.href`
 * because the property accessor returns a resolved URL string whose
 * representation of `javascript:` URLs varies between browsers; the raw
 * attribute is what we care about.
 *
 * @param {Element | null} el Target element. `null` is a no-op (callers
 *   frequently pass `document.querySelector(...)` results directly).
 * @returns {void}
 */
export const safeClick = (el) => {
  if (el === null) return;
  const href = el.getAttribute('href');
  const needsStrip = href !== null && href.startsWith('javascript:');
  if (needsStrip) {
    el.removeAttribute('href');
  }
  // Narrow to HTMLElement for the `.click()` call — the Element
  // interface itself does not declare click(), but any clickable node
  // (anchor, button, SVGAElement, ...) inherits it via HTMLElement or
  // a sibling interface that structurally matches HTMLElement. A cast
  // is the path of least ceremony here.
  /** @type {HTMLElement} */ (el).click();
  // Restore the original href so attribute-selector CSS keeps matching
  // the element. The strip-then-restore cycle is invisible to the
  // outside world because `.click()` is synchronous; only this
  // function's frame ever sees the element in its href-less state.
  if (needsStrip && href !== null) {
    el.setAttribute('href', href);
  }
};

/**
 * Poll `predicate` until it returns a truthy value or `timeoutMs` elapses.
 *
 * The first check runs synchronously before any timer is scheduled, so a
 * predicate that is already satisfied resolves on the next microtask
 * without waiting out an `intervalMs` slice.
 *
 * Implemented as a recursive `setTimeout` rather than `setInterval`: each
 * tick is a fresh timer, which is easier to reason about under fake
 * timers and naturally stops drifting if the predicate runs long.
 *
 * @template T
 * @param {() => T | null | undefined | false | 0 | ''} predicate
 *   Check invoked on each tick. Any truthy return value resolves the
 *   promise; falsy values (`null`, `undefined`, `false`, `0`, `''`)
 *   schedule another poll.
 * @param {{ timeoutMs?: number, intervalMs?: number, now?: () => number }} [options]
 *   `timeoutMs` defaults to 5000, `intervalMs` defaults to 100. `now`
 *   defaults to `Date.now` and exists so callers in pure environments
 *   can inject a deterministic clock — the only `Date` read in this
 *   module routes through it.
 * @returns {Promise<T | null>} Resolves with the first truthy predicate
 *   value, or `null` if `timeoutMs` elapses first.
 */
export const waitFor = (predicate, options) => {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const intervalMs = options?.intervalMs ?? 100;
  const now = options?.now ?? Date.now;

  return new Promise(
    /** @param {(value: T | null) => void} resolve */
    (resolve) => {
      const started = now();

      const tick = () => {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
        if (now() - started >= timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(tick, intervalMs);
      };

      // Synchronous first check — a predicate that is already truthy
      // must not have to wait a full intervalMs before resolving.
      const first = predicate();
      if (first) {
        resolve(first);
        return;
      }
      if (timeoutMs <= 0) {
        resolve(null);
        return;
      }
      setTimeout(tick, intervalMs);
    },
  );
};

/**
 * Append a `<style id="...">` element with the given CSS, unless an
 * element with that id already exists (in which case this is a no-op and
 * the existing textContent is preserved).
 *
 * The idempotence guarantee lets features re-run their setup on every
 * page transition without accumulating duplicate rules.
 *
 * At `document_start` — which is when our content scripts often run —
 * `document.head` may not yet be populated, so we fall back to
 * `document.documentElement` (which always exists once we have a
 * document at all).
 *
 * @param {string} id Unique id for the `<style>` node. Reuse across
 *   features must be avoided — treat it as a namespace key.
 * @param {string} css CSS text to write to the element's `textContent`.
 * @returns {void}
 */
export const injectStyle = (id, css) => {
  if (document.getElementById(id) !== null) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  const parent = document.head ?? document.documentElement;
  parent.appendChild(style);
};

/**
 * Parse a trusted, static SVG markup string into a live `<svg>` element via
 * `DOMParser`, so callers can append real namespaced nodes WITHOUT assigning
 * to `innerHTML`.
 *
 * # Why this exists
 *
 * Inline SVG needs the SVG namespace on every node; the ergonomic way to get
 * that from a markup string is `el.innerHTML = '<svg>…</svg>'`, but AMO's
 * add-on linter flags every `innerHTML` write as "Unsafe assignment" (it
 * can't statically prove the value is constant). Building each node by hand
 * with `createElementNS` is the alternative, but that's unworkable when the
 * markup is an open-ended blob of paths/circles.
 *
 * We parse via `DOMParser` as `text/html`: the HTML parser treats `<svg>` as
 * foreign content and builds the subtree in the SVG namespace, so the root
 * lands as `body.firstElementChild` — a real `SVGElement` ready to append,
 * with no `innerHTML` write anywhere. (`image/svg+xml` would be the obvious
 * type, but happy-dom — our test DOM — doesn't implement it, while both it
 * and every browser handle inline `<svg>` through the HTML path.)
 *
 * SECURITY: pass ONLY developer-authored, constant markup. This is a
 * namespace/lint convenience for our own inline SVG, NOT a sanitizer — no
 * caller routes user data through it.
 *
 * @param {string} markup  Static `<svg>…</svg>` source (single root element).
 * @returns {Element} The parsed root `<svg>` node, ready to append.
 */
export const parseSvg = (markup) => {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  return /** @type {Element} */ (doc.body.firstElementChild);
};
