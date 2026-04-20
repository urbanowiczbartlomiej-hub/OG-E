// DOM helpers used throughout the v5 content script layer.
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
 * event fires even when the page's CSP forbids inline script URLs.
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
  if (href !== null && href.startsWith('javascript:')) {
    el.removeAttribute('href');
  }
  // Narrow to HTMLElement for the `.click()` call — the Element
  // interface itself does not declare click(), but any clickable node
  // (anchor, button, SVGAElement, ...) inherits it via HTMLElement or
  // a sibling interface that structurally matches HTMLElement. A cast
  // is the path of least ceremony here.
  /** @type {HTMLElement} */ (el).click();
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
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 *   `timeoutMs` defaults to 5000, `intervalMs` defaults to 100.
 * @returns {Promise<T | null>} Resolves with the first truthy predicate
 *   value, or `null` if `timeoutMs` elapses first.
 */
export const waitFor = (predicate, options) => {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const intervalMs = options?.intervalMs ?? 100;

  return new Promise(
    /** @param {(value: T | null) => void} resolve */
    (resolve) => {
      const started = Date.now();

      const tick = () => {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
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
