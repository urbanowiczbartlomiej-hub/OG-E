// Entry — OG-E Dashboard page (extension origin).
//
// Single bootstrap call. Every piece of logic lives in
// features/dashboard/ so this entry stays shippable as its own bundle
// without dragging in any content-script code. See
// `features/dashboard/index.js` for the wire-up.

import { installDashboard } from './features/dashboard/index.js';

installDashboard();
