# Casino Arena: responsive layout, accessibility and installability

One codebase serves phones, tablets and desktops. There is no separate mobile app, no second engine and no
client-side settlement: every screen reads the same wallet, ledger and engines, and Party members on
different devices see the same server session.

## How the layout works

| Concern | Approach |
| --- | --- |
| Breakpoints | CSS first (Tailwind v4). Verified at 320, 375, 430, 768, 812 landscape, 1024, 1280, 1440 and 1920 px. |
| Navigation | One nav is rendered at a time. Desktop (>= 1024 px) shows the top bar; below that a bottom bar shows Floor, Party, Wallet, History and a **More** sheet (modal dialog: focus moves in, Escape closes, focus returns to the button). `useMediaQuery` is used only for this "two structures" case and defaults to desktop when `matchMedia` is missing (jsdom tests). |
| Touch vs mouse | Rules are keyed on `@media (pointer: coarse)`, not on width, so a narrow desktop window keeps compact controls and a large tablet keeps big ones. Touch targets are 44 px; fine-pointer controls are at least 24 px. |
| Tables | Felt and bet spots flow in the page; the chip rack and primary actions sit in a **dock** (`dock` utility, `--dock-bleed`). Below `lg` the dock is pinned to the screen bottom and content scrolls under it. From `lg` up it stays in the page flow and is scrolled into view on the player's turn, and it is pinned only on `tall` viewports (>= 960 px high), because a pinned dock on a shorter laptop covered the player's own seat (53 px at 1280 x 800, measured). In landscape phones (`short` variant) the dock becomes one row and Hold'em uses the compact seat strip instead of the seat ring. |
| Hold'em felt | From `sm` up the felt is 590 to 680 px tall (`clamp(590px, 100vh - 360px, 680px)`) so the top seat, the pot/board stack and the bottom seat do not overlap (they did below ~520 px). Between `sm` and `lg` bot panels are `w-36`, the board cards 56 px wide, and side seats are nudged outward. Verified for 2 to 6 seats at every viewport by `scripts/qa/holdem-seats.mjs`. |
| Live Party table | Sets an "immersive" signal so the bottom bar steps aside; chat, members, history and the AI panel are collapsible `Panel`s (a closed `details` on phones, an open section on desktop). |
| Safe areas | `env(safe-area-inset-*)` utilities on the nav, dock and page end. No `dvh` tricks, so browser chrome showing and hiding does not move the layout. |
| Motion | `prefers-reduced-motion` collapses animation and transition durations to zero. |
| Text scaling | Verified with the root font at 200%: no horizontal scroll at 1280 or 375 px. |
| Colour | Tokens in `src/styles/tokens.css`. Body text on the darker felt is `cream/70` (4.71:1) and muted text `#bfb6a3` (4.79:1), but those figures are against a flat felt colour. The felt centre is lighter (a radial gradient) and `cream/70`, `gold-bright/80` and `gold-soft` fall to 3.5 to 4.1:1 there, so captions that sit over it use solid `cream`/`gold-bright` or a dark backing. Alpha-tinted text is not safe on gradients: measure it from pixels with `scripts/qa/contrast-images.mjs`. `gold-dim` is for rules and fills only. |

## How it was verified

Everything below ran in real headless Chrome (a small CDP driver, `scripts/qa/cdp.mjs`, no Playwright), against
the dev server at `http://localhost:5173/` (use `localhost`, not `127.0.0.1`) or the production build.

| Script | What it checks | Run |
| --- | --- | --- |
| `scripts/qa/audit.mjs` | Every screen (lobby, buy-in, wallet, history, honours, profile, practice, party, all 11 games) at every viewport: horizontal overflow, elements off-screen, touch-target size, text under 11 px, text contrast against its real background, overlapping controls, clipping, unlabeled controls, one `h1`, console errors. Writes `screenshots/qa/audit.json`; `--shots` adds PNGs. | `node scripts/qa/audit.mjs [--only=375,1280] [--screens=lobby,blackjack] [--shots]` |
| `scripts/qa/flows.mjs` | A played round per game (and a two-player Party flow) with screenshots at each step. | `node scripts/qa/flows.mjs [--games=...] [--party=...] [--shots]` |
| `scripts/qa/a11y.mjs` | 15 behavioural checks: skip link is the first Tab stop and moves focus, destinations reached in reading order, visible focus on every stop, one `h1`, no horizontal scroll at 200% text, reduced motion, bottom bar items and size, More sheet modal behaviour, no console errors. | `node scripts/qa/a11y.mjs` |
| `scripts/qa/pwa.mjs` | The production build: manifest, installability errors as Chrome reports them, worker control, cache contents, offline reload, Party offline notice, API never served from cache. Run against `npx vite preview --port 4173 --strictPort --host localhost`. | `node scripts/qa/pwa.mjs` |
| `scripts/qa/make-icons.mjs` | Regenerates the PNG icons from `public/icons/icon.svg`. | `node scripts/qa/make-icons.mjs` |

Audit notes: the visually hidden skip link and native checkboxes/radios are measured through what the person
actually operates (the skip link when focused; a checkbox through its label). Contrast that cannot be computed
(text over images or gradients) is counted separately as `contrastUncertain`; it is not a pass.

Screenshots are saved under `screenshots/qa/` and were opened and looked at, not only measured.

## Installability (PWA)

Status: **installable web app**, verified in Chrome. **Not** a native Android, iOS, Windows or macOS app: no
store package exists and none was built or tested.

- `public/manifest.webmanifest`: standalone, `#121012`, 192 and 512 icons plus a maskable 512; `index.html` links it
  and the Apple touch icon. Chrome's `Page.getInstallabilityErrors` reports none.
- `public/sw.js` + `public/sw-rules.js`: the worker caches **only public, same-origin static files** (hashed
  `/assets/*`, icons, manifest, offline page, the page shell). It never handles `/api/` (Party commands, the event
  stream, history), non-GET requests, other origins, or anything carrying `authorization` or `x-party-token`, and it
  never stores a response marked `no-store` or `private`. The rules live in one file that the worker imports and the
  unit tests execute (`src/lib/swRules.test.ts`).
- Offline: the casino floor and the single-player tables run entirely in the page, so they open without a
  connection once the app has been loaded online (table screens are stored the first time they are opened). Party
  needs the server: offline, it shows "Party needs a connection" and nothing from a live table is ever stored.
- Updates: a new version waits. The page shows "A new version is ready" with an **Update now** button; the app never
  reloads itself mid-hand. The worker has no automatic `skipWaiting`.
- The service worker is registered in production builds only; the dev server unregisters any stale one.

## Known limits

- The update prompt has no browser test yet (it needs two published builds).
- Table screens not opened while online are not available offline.
- Real iOS Safari and real Android Chrome were not available: emulated touch and viewport sizes in desktop Chrome
  are not a substitute for a physical device.
