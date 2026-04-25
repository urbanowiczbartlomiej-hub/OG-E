// Entry — histogram page (extension origin).
//
// Single bootstrap call. Every piece of logic lives in
// features/histogram/ so this entry stays shippable as its own bundle
// without dragging in any content-script code. See
// `features/histogram/index.js` for the wire-up.

import { installHistogram } from './features/histogram/index.js';

installHistogram();
