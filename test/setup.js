// @ts-check

// Hermetic tests — no real network, ever.
//
// happy-dom (and Node) ship a real `fetch` that opens real sockets. Any
// un-mocked code path — or, worse, a LEAKED timer from an undisposed feature
// install — that calls `fetch` then either reaches a live server or, in the
// sandbox, floods the logs with `ECONNRESET` "socket hang up" noise (it did:
// ~174 lines per full run, from a timer firing across files). So default
// `fetch` to a guard that fails FAST, with no socket.
//
// Tests that genuinely exercise fetch stub it themselves — `vi.stubGlobal(
// 'fetch', …)` or `globalThis.fetch = …` in their own `beforeEach` / test
// body. Those run AFTER this hook (setup files register their hooks first), so
// they take precedence; this is only the default for everything that doesn't.

import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  globalThis.fetch = vi.fn(() =>
    Promise.reject(
      new Error('fetch is disabled in tests — stub it in the test if this path needs a response'),
    ),
  );
});

// Same problem, different transport: happy-dom's XMLHttpRequest.send() opens a
// REAL socket. The bridge suite only needs the xhrObserver prototype patch to
// run and a SYNTHETIC `load` (see test/helpers/fakeXhr.js) — never a real
// request — yet every send() was firing one (~134 ECONNRESET "socket hang up"
// lines per run). Make send() inert so no socket opens.
//
// This runs at setup-file load, i.e. BEFORE the test file calls observeXHR —
// which captures `XMLHttpRequest.prototype.send` once as its "native" send and
// calls through to it. Replacing it here means that captured native is the
// no-op, so the observer's wrapper still fires; only the network is gone. The
// env is fresh per file, so we set it once at top level (not per-test, which
// would clobber the wrapper the observer installs). Node-environment files have
// no XMLHttpRequest — hence the guard.
if (typeof XMLHttpRequest !== 'undefined') {
  XMLHttpRequest.prototype.send = function inertSend() {};
}
