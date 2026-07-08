// @vitest-environment happy-dom
// @ts-check

// lib/rawMessageBag — the shared reader for OGame's `<div class="rawMessageData"
// data-raw-*>` metadata blocks (used by targetsIngest + whosSpyingPanel). The
// contract: dataset → flat bag with the `raw` prefix stripped and the first
// post-prefix char lowercased, i.e. exactly the key shape the
// domain/espionageReport predicates expect. Attribute names are lowercase in
// real HTML (the parser lowercases them), so the bags carry lowercase keys.

import { describe, it, expect } from 'vitest';
import { bagFromElement } from '../../src/lib/rawMessageBag.js';

describe('bagFromElement', () => {
  it('strips the raw prefix and keeps values verbatim', () => {
    const el = document.createElement('div');
    el.setAttribute('data-raw-sourceplayerid', '116337');
    el.setAttribute('data-raw-coordinates', '4:471:15');
    el.setAttribute('data-raw-fleetvalue', '-');
    const bag = bagFromElement(el);
    expect(bag.sourceplayerid).toBe('116337');
    expect(bag.coordinates).toBe('4:471:15');
    expect(bag.fleetvalue).toBe('-');
  });

  it('leaves non-raw dataset keys untouched and returns {} for a bare element', () => {
    const el = document.createElement('div');
    el.setAttribute('data-msg-id', '121187641');
    const bag = bagFromElement(el);
    // `msgId` has no `raw` prefix — passed through under its dataset name.
    expect(bag.msgId).toBe('121187641');
    expect(bagFromElement(document.createElement('div'))).toEqual({});
  });
});
