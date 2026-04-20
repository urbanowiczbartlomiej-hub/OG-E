# OG-E: OGame Expedition Helper

Lightweight Chrome extension (Manifest V3) that streamlines expedition
management in OGame. No automation, no extra requests — just UI hints
and a smarter redirect after you send a fleet.

## Features

### Expedition badges
Green dots on the planet list mark planets with active (returning)
expeditions. Hover for a tooltip with the expedition count and total
ship count.

### Auto-redirect after expedition send
When enabled, sending an expedition automatically opens the fleet
dispatch page of the next planet that has no active expedition.
Toggle the feature with the checkbox in the fleet status bar.

The redirect works by rewriting the game's own redirectUrl in the
AJAX response — no additional requests are made.

## How it works (fair-play note)
- Does NOT modify outgoing game requests.
- Does NOT automate clicks or form filling.
- Only adjusts the client-side redirect URL that the game already
  returns after a successful fleet send.
- Equivalent to manually clicking the next planet and opening the
  fleet page.

## Installation
1. Download or clone this folder.
2. Open chrome://extensions.
3. Enable Developer mode.
4. Click "Load unpacked" and select the folder containing manifest.json.

## Files
  manifest.json       Extension config (MV3).
  content.js          Expedition badges — runs in isolated world.
  fleet-redirect.js   Auto-redirect — runs in page (MAIN) world.
  icons/icon.svg      Source icon (SVG).
