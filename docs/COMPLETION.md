# Casino Arena: completion report

Everything below was run on this machine (Windows 11, Node 26.8.1, 13th-gen Intel i7-13620H, 16 threads, 15.6 GB,
headless Google Chrome driven over CDP). Nothing here was run on a physical phone, in Safari or Firefox, or with a
screen reader. Where something was not run, it says so.

**How to read this file.** Part A (below) is the **latest final-tree** result of the release-readiness continuation
(2026-10-12). Part B (sections 1 to 11) is the **previous session's** report, kept as historical evidence; where a later
result supersedes one of its statements, that is marked "superseded".

---

# Part A. Continuation sprint, 2026-10-12 (latest, final tree)

## A1. Final regression pipeline

| Check | Result |
| --- | --- |
| `tsc --noEmit` and `tsc -p tsconfig.arena.json` | both exit 0 |
| `eslint .` | exit 0, no findings |
| `npm run build` | passes; main chunk 470.75 kB (143.03 kB gzip), Party chunk 67.39 kB |
| `vitest run` (vitest **5.0.3**) | **90 files; 1,489 tests: 1,488 passed, 0 failed, 1 skipped, 0 timed out**; 230 s. The skip is `party-store` "readable by the owner only" (POSIX modes; **unverified on Windows, not a pass**) |
| `npm audit` / `npm audit --omit=dev` | **0 / 0 vulnerabilities** (was 4 dev-only findings) |
| Dynamic security scan (HawkScan) | **not run.** Blockers: `HAWK_API_KEY` is not set, there is no `stackhawk.yml`, and the Docker CLI exists (29.2.0) but its daemon is not reachable. Nothing is claimed about the result |

The previous total was 1,458 tests; the +31 are tests that existed but **never ran** (A5).

## A2. Hold'em action dock (the outstanding 1280 x 800 overlap): fixed and verified in a real browser

The "sticky to normal flow" change described in the brief was **not present** in this working tree, so it was reproduced first.
Measured with `node scripts/qa/dock-geometry.mjs --shots`, before: at 1280 x 800 the pinned dock covered **72 px of the felt and
53 of 161 px of the player's own seat**; also 85 px at 1366 x 768 and 1024 x 768, 133 px at 1280 x 720. Plain normal flow was
rejected: it pushes Fold / Call below the fold at 800 px.

Fix: the dock is pinned only on `tall` viewports (>= 960 px high, new `tall` variant in `tokens.css`) and otherwise stays in flow
and is scrolled into view when it is the player's turn (`HoldemFelt.tsx`). Final result, all 8 sizes
(1280x800, 1366x768, 1440x900, 1536x864, 1280x720, 1024x768, 1920x1080, 1024x600): **seat covered 0 px at scroll 0, every
action button fully on screen as played, PASS 8/8** (the script now fails on a regression and also measures "as played").
Screenshots: `screenshots/qa/dock-before-1280x800.png` (dock on the hole cards), `dock-final-played-1280x800.png`,
`dock-final-played-1024x600.png` (viewed). Regression tests: `holdem-presentation.test.tsx` (class is `lg:tall:sticky`, never
`lg:sticky`; the scroll-into-view fires only when the dock is below the fold). A CSS assertion is not the proof: the browser run is.

## A3. Responsive and accessibility, final tree

Run on the final tree: `audit.mjs` (19 screens x 9 viewports: 320, 375, 430, 768, 812 landscape, 1024, 1280, 1440, 1920),
`contrast-images.mjs`, `holdem-seats.mjs`, `party-states.mjs`, `flows.mjs`, `a11y.mjs`.

| Check | Result |
| --- | --- |
| Audit | **171/171 rows reached.** Horizontal overflow 0, off-screen 0, undersized touch targets 0, text under 11 px 0, **low contrast 0**, overlapping controls 0, clipped content 0, unlabeled controls 0, console errors 0, pages without exactly one `h1` 0 |
| Played-round flows, every game | **99/99** (11 games x 9 viewports, including **320 and 430**): no failure, no overflow, no console error |
| Hold'em seat layouts, 2 to 6 seats x 9 viewports | **45/45 clean**: no seat overlaps a seat, the pot, the street label or the community cards; actions on screen; last seat reachable above a pinned dock |
| Party states, 2/4/6 seats x 9 viewports | **99/99 states reached, 0 overflow, 0 overlaps, 0 off-screen, 0 undersized targets** |
| `a11y.mjs` | **15/15** (skip link, reading order, focus, 200% text, reduced motion, More sheet) |

**The earlier "low contrast 0" was wrong.** `audit.mjs` parsed colours with a regex on `rgb()`, so every colour in another
syntax (Tailwind v4's `color(srgb ...)` from `text-cream/70`) was silently skipped. With a canvas-based parser the same audit
found 62 instances of 8 elements. Superseded: section 4 of Part B.

**Defects found and fixed this sprint (all measured in a browser before and after):**

| Defect | Where | Evidence |
| --- | --- | --- |
| Dock covered the player's seat at laptop heights | `HoldemFelt.tsx`, `tokens.css` | A2 |
| Hold'em seats overlapped the pot, street label and board from 768 to 1440 px and in phone landscape (felt only ~470 px for ~520 px of content); 23 of 45 layouts flagged | `HoldemFelt.tsx` | felt 590 to 680 px, narrower bots and board below `lg`, compact seat strip in landscape: 0 of 45 |
| Wheel hub label "ARENA" at **1.33:1**: the class list had a gold gradient but no `bg-gradient-to-br`, so the hub rendered as a 50% black overlay with dark text | `WheelTable.tsx` | fixed; pixel-verified |
| Hold'em "Flop/Turn/River" slot labels 1.6:1, "Main Pot" 3.5:1, street label 3.8:1; blackjack rules ribbon 3.6, "Dealer" 4.08; wheel/roulette payout captions 4.19; empty dealer slot 4.08 | `HoldemFelt`, `BlackjackFelt`, `WheelTable`, `RouletteTable`, `TableHost` | alpha-tinted text on the lighter felt centre; now solid colours or a dark backing |
| "1K" chip label 3.9 to 4.3:1 | `PhysicalChip.tsx` | gradient one step darker |
| Seven Party table buttons (Pause/Resume, End session, Sit out, Leave party, Min, Max) 40 px on touch | `PartyTable.tsx` | `min-h-10` overrode the 44 px coarse-pointer rule; now `min-h-11` |
| Card-back "CA" monogram flagged by the contrast probe | `PlayingCard.tsx` | decorative: `aria-hidden` (the card already says "Face-down card") |

**The 831 text-over-image cases, classified** (`scripts/qa/contrast-images.mjs`: hides all text, screenshots the real
composited background, samples every pixel under each text box, computes the worst-case WCAG ratio; 4.5, or 3 for large text):

| Class | Count | Meaning |
| --- | --- | --- |
| verified | **688** | the worst sampled pixel meets the threshold |
| failed | **0** | (15 failed before the fixes above) |
| marginal | **0** | |
| unverified | **62** | 54 are the Wheel's rotated segment labels (an axis-aligned sample box is invalid for rotated text; checked **analytically** instead: white on the flat segment colours is 5.0 to 7.1:1) and 8 are Hold'em/wallet text never fully on screen and uncovered in any scroll step. Not counted as passes |
| exempt | **81** | decorative `aria-hidden` card-back monograms. Not counted as passes |

Reached at all 9 viewports; the buy-in screen contains none. Failed count is 0 at every viewport.

**Not done (honest):** no physical device, no Safari or Firefox, **no screen reader** (NVDA/VoiceOver), so contrast and the 15
behaviours are automated checks only. The seat overlap test counts any intersection over 16 px^2 of seat/pot/street/board boxes,
so a seat nudging a container's padding would count; clean means none do.

## A4. Dependency security

All four findings were **dev-tooling only** (production audit was and is 0):

| Package | Severity | Path | Fix |
| --- | --- | --- | --- |
| `source-map-js` 1.0.0-1.2.1 | high | via postcss, dev | `npm audit fix` (non-breaking): **1.2.2**. The earlier "no published fix" was wrong |
| `tinypool` <= 2.1.1 | critical | prototype-pollution gadget in worker options, via `vitest` | `vitest@5.0.3` |
| `@vitest/mocker` | moderate | path traversal in redirect mocks, via `vitest` | `vitest@5.0.3` |
| `vitest` 3.2.7 | critical | direct | `vitest@5.0.3` (semver major) |

The major upgrade was **trialled, not forced**: it initially broke 4 tests and, less visibly, all 8 `vite-node` npm scripts
(`sim:*`, `lab`, `party:server`), because `vite-node` was never a declared dependency, only a transitive of vitest 3. It is now an
explicit devDependency (`vite-node@3.2.4`, the version already in use). After that: the full suite is green (A1), `sim:adaptive`
is byte-identical to the previous report, `party-process-restart` passes, build and both type checks pass. Backups of the old
manifests were kept outside the repo (it has no commits to revert to).

## A5. A hidden defect the upgrade exposed: three test files had never been running

Vitest 5 refuses a `describe` inside a running test. That surfaced three files (`economy.test.ts`, `live-observation.test.ts`,
`three-card-poker.test.ts`) whose lines had been **relocated**: the tail of one test sat at the end of the file, so a whole block
of later tests (Phase 11/12 economy and conservation across every room, the PHASE 5/6 bot observation suites, TCP pair-plus and
reconcile) was nested inside one `it` and was silently never registered under vitest 3. Present since the files were written
(an Oct 9 snapshot is byte-identical). No text was invented: a verified pure line permutation (sorted non-blank lines compared)
restored them. Once running, 7 tests failed, each triaged (none hid a product defect, none lost an assertion):

| Test | Cause | Resolution |
| --- | --- | --- |
| buy-in "wallet only holds" | 10 M hits the max-buy-in check first | use an in-range buy-in the wallet can't cover |
| `clearAllBets().ok` on an empty felt | the product returns an idempotent `ok:true` (`end()` relies on it) | assert the real claim (no second refund) |
| craps cash-out | the session correctly refuses to leave with a contract riding | roll to `canEnd()` first |
| 2 blackjack volatile profiles | bets of 125/225/250 are not legal chips (`isWagerable`) | legal varying chips |
| TCP Pair Plus | V2 audit moved settlement to the deal | read the deal result |
| TCP cash-out | `summary.returned` is payouts, not the cash-out | `endingBankroll`, as `economy.test.ts` already does |

`party-tape` "a table with bots saves a key per seat" then failed once in the full run. **Cause found by measurement:** the deal is
the real CSPRNG and the bots shove, so in **8 of 400 twelve-hand runs (2%)** one stack takes every chip ("The Pro wins 4,000,000.
Only one player has chips left"), the session correctly ends and a finished session keeps no tapes by design. Fixed without
touching an assertion or a timeout: `liveBotTable(hands)` builds a fresh table until one is still live and throws if none is in 25
tries. Also fixed in the QA harness: every CDP command now has a 60 s deadline (a wedged renderer used to hang a run for 16 minutes).

## A6. PWA update stability

`pwa.mjs` **14/14**. `pwa-update-soak.mjs` (new): the real update lifecycle, fresh Chrome profile per run:

| Condition | Runs | Result |
| --- | --- | --- |
| idle machine | 20 | **20/20**, 15/15 checks each, 6.5 to 7.9 s |
| all 16 logical CPUs saturated by 16 busy loops | 20 | **20/20**, 9.8 to 12.5 s |

The two failures from the first run in the previous session **did not reproduce in 40 further runs, including under saturation, and
their cause is not found.** What was ruled out by reading the code: the worker deletes old caches before `clients.claim()`, so the
cache is gone before the page reloads; `track()` attaches its `statechange` listener synchronously inside `updatefound`; the page
only reloads from `applyUpdate()`. The only fragility identified is in the harness (fixed `sleep(2500)` / `sleep(800)` before asserting
reload and cache state, and a `page.run` that can race a reload), not in the app or worker. **No assertion, timeout or the
service worker was changed.** One edge not exercised: `track()` does not handle a worker already `installing` when it attaches
(a reload mid-install), which would only delay the banner until the next load.

## A7. Adaptive AI

`npm run sim:adaptive` re-run on the final tree: **654.5 +/- 177.0 bb/100 (3.7 standard errors), 2,433 decisions, 0 refused, 0
fallbacks**, two runs byte-identical (the Part B method and its limits stand; the passive-opponent absolute numbers are not a strength rating).

New `npm run sim:adaptive:sweep` (`scripts/holdem-adaptive-sweep.ts`, data in `docs/adaptive-sweep.json`): same paired method (both
policies at the same tables on the same cards, alternating seat parity), 12 tables x 100 hands per cell, fixed seeds, scripted seat
re-buying like a real player (an unbustable seat let the bots compound an endless pot, so that design was rejected).

| Axis | Covered |
| --- | --- |
| Opponent archetypes | calling station, tight-passive "nit", tight-aggressive, maniac |
| Style changes mid-session | caller > maniac, maniac > nit |
| Difficulty | 40, 70, 85, 100 |
| Uncertainty | paired per-table difference, standard error, 95% t interval |
| Integrity | **118,894 bot decisions, 0 refused, 0 engine fallbacks; chips conserved in 24/24 cells** |

Results: adaptive ahead with the 95% interval above zero in **23 of 24** cells; one interval spans zero (nit at difficulty 70); legacy
ahead in none. Mean paired difference by difficulty 671 / 733 / 684 / 820 bb/100 (40/70/85/100): difficulty barely moves the paired
advantage. Behavioural diversity (std of the personalities' learned VPIP in a table) is similar for both policies (0.12 to 0.18).

**Does the model learn from observations?** Yes, in stable play: the table's estimate of the scripted seat tracks what it did
(nit VPIP 19% actual / 25% learned, fold-to-bet 67/69; tag VPIP 43/46; maniac raise-vs-bet 56/59), shrunk toward the prior. **After
a style switch it lags:** maniac > nit second half, actual VPIP 20% / PFR 3% / raise-vs-bet 5% against learned 46% / 25% / 26% (the
estimate accumulates over the whole session with no forgetting). Consistent with that, the adaptive advantage in the second half of
the switch scenarios shrinks or reverses in 5 of 8 cells (caller > maniac: -756 at d40, +410 at d85; maniac > nit: about 0). **Per-half
intervals were not computed, so the second-half numbers are indicative only.** Not measured: play against humans, long-run learning
curves, any claim of absolute strength.

## A8. Party Mode (`scripts/qa/party-states.mjs`, new; own server on :8787 with a throwaway state file)

Per viewport, 2/4/6 seats; for the 4-seat table also: **paused** (banner on both players), **resumed**, a player's **network drop**
(what they see: "You are offline..."), **self-recovery** on reconnect, the leader seeing the player **leave**, the **Reconnecting to
your party** screen with the server down, and **restore after a server restart**: **same hand every time, 1.6 s on phones to 6.5 s
at 1440 px**. 99/99 states, 0 problems. Not done: a real multi-device network, and Chrome's offline emulation did not make the
server drop the stream within 25 s, so the leader-side "player gone" state is checked by closing the tab (reported, not hidden).

## A9. Recalculated completion (explicit weights; score = weight x fraction of listed acceptance items verified)

| Workstream | Weight | Previous | Now | What changed |
| --- | --- | --- | --- | --- |
| Game engine integrity | 20 | 15.0 | 16.0 | 31 previously dead tests now run and pass; Omaha not implemented and Teen Patti shallow still cost the rest |
| Adaptive AI | 10 | 9.6 | 9.8 | archetype, difficulty and switch sweep with intervals and integrity; per-half intervals and human opponents not measured |
| Party reliability and privacy | 12 | 11.0 | 11.5 | paused/offline/reconnect/restart states at 9 viewports; no real multi-device run |
| Persistence / checkpoint | 10 | 9.0 | 9.0 | unchanged (Party Hold'em only) |
| Security | 10 | 6.0 | 8.0 | dev audit 0; **no dynamic scan** |
| Responsive UI | 15 | 10.0 | 13.5 | dock, seats, contrast, 320/430 flows, Party states; no real devices, Safari, Firefox |
| Accessibility | 8 | 7.0 | 7.2 | contrast classified; **no screen reader** |
| PWA | 7 | 6.5 | 6.5 | 40/40 soak and 14/14; early failures unexplained |
| Progression / statistics | 4 | 2.0 | 2.0 | not audited |
| Performance | 4 | 2.0 | 2.0 | bundle sizes only |
| **Total** | **100** | **78.1** | **85.5** | a rubric, not a measure of effort |

## A11. Hold'em opponent learner: recency evaluation (2026-10-12 to 14)

**NO-GO beyond opt-in testing.** `LEGACY_LEARNER` remains the default; `RECENCY_LEARNER` is opt-in only. C1, C3 and C5 fail; C9 is now measured (0.8x legacy, pinned); C2, C4, C6 (point estimate), C7 and C8 pass. The recency estimate follows a style change about twice as fast at the halfway point, but no gameplay advantage over legacy is demonstrated (pooled +143 bb/100 [-88, 374] after a change). Full results, per-scenario tables, the run-1 harness defect and its fix, and next actions: `docs/OPPONENT-LEARNING.md` section 6. Commands: `npm run sim:learner:response`, `sim:learner:eval`, `sim:learner:cost`. New: `adapter-learner.test.ts` (3 tests), `scripts/learner-cost.ts`. Full suite: 1,509 passed, 8 failed in one run (C3 plus 7 load timeouts that pass alone); typecheck, lint and build exit 0.

## A10. Remaining, blocked or unverified

- **No dynamic security scan** (A1 lists the three blockers); to resume: set `HAWK_API_KEY`, start Docker, add `stackhawk.yml`, then `hawk scan`.
- No physical phone, no Safari/Firefox, no screen reader. The 62 unverified contrast cases (54 analytically checked wheel labels, 8 never fully on screen).
- The adaptive model does not forget: it lags a style change (A7). A recency-weighted estimate would be the fix; not attempted (a behaviour change to the learner, outside a release blocker).
- One skipped test (POSIX permissions) is unverified on Windows. The two early PWA failures are unexplained.
- Omaha not implemented; Teen Patti BETA; `docs/AUDIT.md` still describes the pre-refactor code.
- In phone landscape Hold'em uses the compact seat strip (the ring cannot fit a 300 px felt); at 1024 x 600 the far bot seat scrolls partly out of view because no layout fits a full table plus controls in 600 px.

Reproduce: `npm run dev`; `node scripts/qa/{dock-geometry,audit,contrast-images,holdem-seats,party-states,flows,a11y}.mjs`;
`npm run build && node node_modules/vite/bin/vite.js preview --port 4173 --strictPort --host localhost` then
`node scripts/qa/{pwa,pwa-update-soak}.mjs`; `npm run sim:adaptive` and `npm run sim:adaptive:sweep 12 100`.

---

# Part B. Previous session's report (historical; superseded where marked)

## 1. Final regression pipeline (previous session; superseded by A1)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc -p tsconfig.arena.json` | exit 0 |
| `npx eslint .` | exit 0, no findings |
| `npm run build` | passes. Main chunk 470.73 kB (143.03 kB gzip); Party chunk 67.39 kB (it was 456.92 kB / 66.73 kB before this work) |
| `npx vitest run` | **90 files passed. 1457 tests passed, 0 failed, 0 timed out, 1 skipped (1458).** 329.5 s |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (all) | 4 findings, all dev tooling: `vitest` (critical), `tinypool` (critical, prototype pollution via worker options), `@vitest/mocker` (moderate), `source-map-js` (high, no fix published). The fix is a breaking major (`vitest@5`); not applied. Exposure is limited to running untrusted test code. |

The one skipped test is `party-store` "the file and its backup are readable by the owner only", skipped on Windows because it
checks POSIX file modes. **A skipped test is not a pass**: it is unverified on this machine.

Timeouts, compared with the baseline. A first "final" run had 1 failure and a second had 1 different one; both were
timeouts or a real regression, not weakened assertions:
- `opponent-model` "fixed storage footprint": a real regression from my change (a `recent` list in the persisted profile pushed
  it over its 2,500-byte bound). Fixed in the code, not the test: `snapshot()` is unchanged and a checkpoint opts in with
  `snapshot(true)`.
- `house-edge` roulette lab: 21.4 s against the 20 s limit. Measured alone it takes 22.1 s, 23.3 s, 18.0 s and 20.4 s, so it sits
  on the limit regardless of my changes (none touch it). I gave that one test an explicit 60 s budget, with a comment; every
  assertion is unchanged. It was the only timeout change.
- A run made while I was also running browser audits showed four timeouts (the same lab, a Sic Bo lab and a Hold'em learning test
  at 22 to 92 s). That run is discarded as contended and is not part of the totals above.

## 2. Defects found and fixed this session (all with regression tests)

| # | Defect | Where | Evidence |
| --- | --- | --- | --- |
| 1 | **Single-player Hold'em never credited a win when the player's own action ended the hand.** The engine zeroes every commitment at completion, the adapter read 0 as the stake and posted an empty settlement. Seen live as "You wins 2020" with "Table stack 0". | `holdem/adapter.ts` | `holdem-settlement.test.ts` (12 cases, 4 failed before the fix); browser check below |
| 2 | `clearAllBets()` refunded chips a live hand still owned, minting the same amount on every call. | `casino/session.ts` | `adversarial.test.ts` (Hold'em, step 16) |
| 3 | Three Card Poker accepted new Ante/Pair Plus bets after the cards were dealt; the next action then wiped them unsettled (chips destroyed, bet placed with knowledge of the hand). | `games/tcp.ts` | `adversarial.test.ts` (three-card-poker, step 317) |
| 4 | A roulette `bet`/`unbet` command in a blackjack party was treated as an unlock request. | `party/server.ts` | `party-fuzz.test.ts` |
| 5 | Sic Bo "150:1" label at 4.34:1 contrast (needs 4.5); profile checkbox label under 44 px; two audit false positives (hidden skip link, native checkbox measured instead of its label). | `SicBoTable.tsx`, `ProfileView.tsx`, `audit.mjs` | re-audit below |

New suites: `adversarial.test.ts` (11 rooms x 400 seeded hostile/honest commands), `holdem-settlement.test.ts`,
`party-fuzz.test.ts` (3 games x 350 commands from 3 identities: hostile input, conservation, per-member privacy, restore parity),
`checkpoint.test.ts`, `party-checkpoint.test.ts`, `swRules.test.ts`.

## 3. Hold'em settlement in a real browser (`scripts/qa/holdem-settle.mjs`)

Played single-player Hold'em in Chrome, jamming all-in so the player's own action ended each hand.

| Hand | Announced | Bankroll before to after |
| --- | --- | --- |
| 1 | "You wins 1030." | 1,000 to **1,030** (before the fix this stayed at 0) |
| 2 | "You wins 1080." | 1,030 to **1,080** |
| 3 | opponent wins | 1,080 to 100 (the uncalled excess stays with the player) |

Then End Session: summary "Starting 1,000, ending 100, net -900, rounds 3, wagered 3,110, returned 2,110", wallet 9,100
(9,000 + 100). History shows the same row. Screenshots: `holdem-settle-own-action-1280.png`,
`holdem-settle-summary-1280.png`, `holdem-settle-history-1280.png` (viewed). Not tested: a hand ending by bots folding to the
player's bet, or the 6-seat table in the browser (covered by the engine tests only).

## 4. Responsive and accessibility audit (previous session; **superseded by A3**: its "low contrast 0" and "no layout findings" were measured with a parser that skipped modern colour syntax and without seat-overlap checks)

`node scripts/qa/audit.mjs --shots`: **171 rows** (19 screens x 9 viewports: 320, 375, 430, 768, 812 landscape, 1024, 1280,
1440, 1920). Every screen was reached. Horizontal overflow 0, off-screen elements 0, targets under minimum 0, low contrast 0,
overlapping controls 0, clipping 0, unlabeled controls 0, console errors 0, pages without exactly one `h1` 0, text under 11 px 0.
Limitation: 831 text elements sit over images or gradients and their contrast **cannot be computed**; they are unverified, not
passed. `a11y.mjs`: 15 of 15 behaviours pass (skip link, reading order, visible focus, 200% text, reduced motion, More sheet).
261 screenshots in `screenshots/qa/` (the ones named in this report were opened and looked at).

Not done: played-round flows were run at 375 for every game and at five widths for Blackjack, Hold'em and Roulette, not at 320
or 430 for every game; Party states (2/4/6 players, paused, reconnecting) are screenshot-verified at 375 only. One cosmetic
defect I saw and did not fix: at 1280 x 800 the Hold'em action dock overlaps the bottom edge of the player's seat panel.

## 5. PWA (previous session; see A6 for the 40-run soak)

Installable web app. Manifest parses with no errors, Chrome reports no installability errors, the worker controls the page, the
cache holds only public static files (shell, offline page, manifest, icons, hashed assets) and never an API URL, state or
token; offline reload serves the casino floor with an offline banner; Party says "Party needs a connection" and an API fetch
offline is a network error, not a cached answer. **Update lifecycle:** publishing a changed `sw.js` produced the "A new version is
ready" banner without reloading the page (an in-page marker survived), the old cache stayed in service, **Update now** activated
the new worker and reloaded once, the old cache was deleted, the banner cleared, saved wallet data was identical, and no private
data was cached. The very first run of the update script had two early failures (activation timing) that did not recur in the
next four runs; I did not find a cause. **No native Android, iOS, Windows or macOS package exists, and none was built.**

## 6. Hold'em checkpoint (`scripts/bench-checkpoint.ts`, raw data: `docs/bench-checkpoint-run1.json` is the full table below, `docs/bench-checkpoint.json` is the second pass)

Design: between hands the engine exports its state (stacks, button, hand count, unseen shoe, bot strategic state, per-seat
opponent models); the server keeps keyed bot-stream positions, drops the journal and deal tape that led there, and recovery
loads the checkpoint then replays only the later hands. Saved as format 3 only when a checkpoint exists (otherwise format 2, so a
rollback is possible); format 2 files restore as before. Every field is validated on load (seats, whole numbers, real and
non-duplicated cards, chips adding up), and a damaged checkpoint is refused. Only with the server's own recorded streams, every
25 hands, Party Hold'em only. The per-hand history is never trimmed.

**Equivalence proven:** restored tables match the original action by action for 2, 3 and 6 seats, final exported states are
identical (so bot learning and the shoe survive), chips are conserved, and all 18 benchmark rows plus the server tests report
`equal: true`, 0 failures. Environment above; 5 samples per cell; real CSPRNG; 2 human seats plus 0 or 2 bots.

| Bots | Hands | Mode | File | Export med / max (ms) | Restore med / max (ms) |
| --- | --- | --- | --- | --- | --- |
| 0 | 101 | replay | 207 kB | 48.9 / 183 | 846 / 1,624 |
| 0 | 101 | checkpoint | 205 kB | 45.0 / 69 | **37 / 49** |
| 0 | 201 | replay | 404 kB | 91.3 / 227 | 1,226 / 2,112 |
| 0 | 201 | checkpoint | 382 kB | 146.3 / 195 | **84 / 143** |
| 2 | 26 | replay | 72 kB | 1.1 / 3.3 | 8,164 / 8,742 |
| 2 | 26 | checkpoint | 97 kB | 1.95 / 4.4 | **2.1 / 2.1** |
| 2 | 51 | replay | 137 kB | 3.0 / 7.7 | 16,168 / 36,971 |
| 2 | 51 | checkpoint | 178 kB | 5.4 / 7.6 | **5.2 / 7.2** |
| 2 | 101 | replay | 226 kB | 4.6 / 5.6 | 12,948 / 16,954 |
| 2 | 101 | checkpoint | 253 kB | 8.1 / 9.4 | **6.8 / 7.1** |

A second pass (bots, 11 / 26 / 51 hands) agreed in order of magnitude: replay 5.0 / 8.0 / 12.4 s, checkpoint 2.5 s (no
checkpoint yet at 11 hands, so the same work) / 10.7 ms / 116.7 ms. Latency is noisy on this machine (replay with bots varies
by up to 3x between samples; the project sits under OneDrive on a laptop), so read the order of magnitude, not the digits.
The file is not smaller with a checkpoint (up to about 25% larger, because it stores the shoe and learned state); the gain is
recovery time. Tail latency is the "max" column over only 5 samples, not a percentile.

## 7. Security

Verified: the dev-server snapshot-exposure and absurd-wager protections still pass their suites; no member's payload contains
another member's token, hole cards, tapes or journal across 1,050 fuzzed party commands; hostile input never crossed into the
ledger (11 rooms). **Not done: any dynamic scan.** HawkScan needs `HAWK_API_KEY`, which is not present, so no scanner ran. The
four dev-dependency findings in section 1 are unresolved.

## 8. Workstream scores (explicit weights; score = weight x fraction of listed acceptance items verified)

| Workstream | Weight | Items verified | Score |
| --- | --- | --- | --- |
| Game engine integrity | 20 | rule suites per room, conservation, hostile-input fuzz, Hold'em settlement vs announced result = pass; Teen Patti (BETA) shallow = half; Omaha not implemented (coming soon) = no | 15.0 |
| Adaptive AI | 10 | learner with sample counts and confidence, preserved across checkpoint, personality/difficulty tests, no hidden-information access, head-to-head simulation re-run (section 11) = pass; the simulation uses one fixed opponent and one difficulty, so adaptation to changing opponents and a difficulty sweep are not measured = partial | 9.6 |
| Party reliability and privacy | 12 | fuzz, restore parity, per-member privacy, restart suites = pass; no real multi-device network run | 11.0 |
| Persistence / checkpoint | 10 | implemented, equivalence, hostile rejection, backward compatibility, benchmarks = pass; Party Hold'em only | 9.0 |
| Security | 10 | regression suites, prod audit clean = pass; dev-dependency findings and any DAST scan = no | 6.0 |
| Responsive UI | 15 | 171-row audit clean, screenshots reviewed = pass; 320/430 flows for every game, Party states beyond 375, 831 uncomputable contrast, real devices = no | 10.0 |
| Accessibility | 8 | 15/15 behaviours, audit clean; no screen-reader or real assistive-technology test | 7.0 |
| PWA | 7 | manifest, installability, offline, update lifecycle, no private caching = pass; real-device install not run | 6.5 |
| Progression / statistics from real data | 4 | existing suite passes; not audited this session | 2.0 |
| Performance | 4 | bundle sizes and checkpoint latency measured; no runtime profiling | 2.0 |
| **Total** | **100** | | **78.1** |

**Recalculated completion: about 78% (78.1).** This is a rubric, not a measure of effort; the missing 22 points are the items
marked "no" above.

## 9. Unresolved and blocked (previous session; superseded by A10: the dev-dependency findings, the dock overlap and the 320/430 and Party-state gaps are closed)

- Omaha is not implemented (listed as coming soon); Teen Patti is BETA.
- Dev-dependency vulnerabilities (vitest 3.x chain); `source-map-js` has no published fix.
- No dynamic security scan (missing `HAWK_API_KEY`).
- One test skipped on Windows (POSIX permissions); the Party store permission claim is unverified here.
- 831 text elements with uncomputable contrast; no physical-device, Safari, Firefox or screen-reader testing.
- Hold'em dock slightly overlaps the player's seat at 1280 x 800.
- Stale reference: `docs/AUDIT.md` is the pre-refactor audit and no longer describes the code.

## 10. Where to continue

1. Extend the adaptive simulation to a difficulty sweep and to an opponent whose style changes mid-session.
2. Run `flows.mjs` at 320 and 430 for every game and the Party states (paused, reconnecting, 2/4/6 players) at all widths.
3. Plan the `vitest@5` upgrade and re-run the full suite.
4. Provide `HAWK_API_KEY` (or another scanner) and run a dynamic scan; record the result either way.
5. Fix the Hold'em dock overlap; test on a real phone.

Reproduce: `npm run dev` and `npm run party:server`; `node scripts/qa/{audit,flows,a11y,holdem-settle}.mjs`;
`npm run build && npx vite preview --port 4173 --strictPort --host localhost` then `node scripts/qa/{pwa,pwa-update}.mjs`;
`npx vite-node scripts/bench-checkpoint.ts 10,25,50,100,200 5`.

## 11. Adaptive AI: `npm run sim:adaptive` re-run (previous session; reproduced exactly in A7, extended by the sweep)

Command: `vite-node scripts/holdem-adaptive.ts [tables] [handsPerTable]`, run three times on the final tree.

**Method (read before interpreting).** Six seats: five bots with the six personalities rotated by table, plus a fixed passive
player in seat 0 (checks when free, calls otherwise). The legacy policy and the adaptive (EV-based, opponent-learning) policy sit
at the **same tables, on the same cards**, alternating seat parity so each gets every personality and seat class equally often.
Results are bb/100 per seat, **paired by table**, with the standard error across tables. Seeds are fixed. Difficulty is fixed
at 85, so this is **not** a difficulty comparison.

| Run | Tables x hands | Legacy bb/100 | Adaptive bb/100 | Paired difference | Standard errors | Decisions | Refused | Engine fallbacks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 12 x 80 | -281.6 +/- 82.7 | 373.0 +/- 99.3 | **654.5 +/- 177.0** | 3.7 | 2,433 | 0 | 0 |
| 2 | 12 x 80 (repeat) | identical to run 1 | | | | | | |
| 3 | 40 x 150 | -463.9 +/- 100.5 | 691.2 +/- 138.1 | **1,155.1 +/- 232.9** | 5.0 | 7,808 | 0 | 0 |

- **Reproducible:** runs 1 and 2 are byte-identical apart from wall time.
- **Integrity:** 10,241 bot decisions across the two sizes, 0 refused by the engine, 0 engine fallbacks.
- **Adaptation changes behaviour in the intended direction.** Observed from the bots' own public actions, the legacy policy is
  rigid (for example the pro raises before the flop 3 to 4% of the time and the beginner 3 to 4%); the adaptive policy moves each
  personality toward a reasoned mix (pro 27%, gambler 34%, rock 13%, mathematician 12%, beginner 34%) while keeping the loose
  and tight characters distinct (VPIP gambler 72% vs mathematician 44% in run 1; 76% vs 59% for chaos vs mathematician in run 3).
- **What the numbers do not show.** The absolute bb/100 figures are large because the passive opponent never folds; they are
  not a strength rating and should not be quoted as one. Only the paired policy difference is meaningful. The 5.0 standard
  errors in the larger run say the difference is unlikely to be chance among these tables; the two runs are different sample sizes,
  not independent replications of the same size. The simulation does **not** test: difficulty levels, an opponent that changes style
  mid-session, a human-like opponent, or long-run learning curves. The tests in `opponent-model.test.ts` and
  `adaptive-table.test.ts` cover the learner's confidence and per-seat learning; they passed in the final full run.
