// @ts-check
//
// Shared low-level fake-XHR round-trip for the bridge test suite.
//
// Every bridge test drives the `xhrObserver` prototype patch the same way:
// `open` + `send` trip the patch's send-phase path, then we force
// `responseText` / `status` / `readyState=4` and dispatch a synthetic
// `load` event so the load-phase observers fire against a response we fully
// control. happy-dom's XHR never reaches the network — setting the response
// fields and firing `load` by hand is what stands in for a real arrival.
//
// This is the SUPERSET of the per-file helpers that used to be copy-pasted
// across `test/bridges/*` (each redefined its own with subtly different
// signatures — GET vs POST default, with/without `status`, etc.). Domain
// specific shaping (JSON.stringify, invalid-JSON sentinels, fixed URL
// constants) stays in thin per-file wrappers that delegate here; only the
// prototype round-trip itself lives in this one place.
//
// Returns the xhr after `load` has fired (and one microtask has been
// yielded) so callers can assert on side effects registered by
// `{ once: true }` load-phase observers.

/**
 * Drive one XHR round-trip through the patched prototype.
 *
 * @param {string} url
 * @param {{ method?: string, body?: unknown, responseText?: string, status?: number }} [options]
 *   `method` defaults to `'GET'` — pass `'POST'` explicitly for the POST
 *   endpoints. `body` is passed verbatim to `xhr.send(body)` (happy-dom
 *   accepts anything, so non-string values exercise defensive branches).
 * @returns {Promise<XMLHttpRequest>}
 */
export const fakeXHR = async (
  url,
  { method = 'GET', body = null, responseText = '', status = 200 } = {},
) => {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url);
  // @ts-expect-error happy-dom's XHR accepts any body value.
  xhr.send(body);
  Object.defineProperty(xhr, 'responseText', { value: responseText, configurable: true });
  Object.defineProperty(xhr, 'status', { value: status, configurable: true });
  Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
  xhr.dispatchEvent(new Event('load'));
  // Yield a microtask so any `{ once: true }` load handlers registered by
  // the observer fire before the caller asserts.
  await Promise.resolve();
  return xhr;
};
