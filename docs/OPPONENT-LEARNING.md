# Hold'em opponent learning: diagnosis, design, acceptance criteria

Status: written **before** any parameter was tuned. Results are in the last section and in `docs/COMPLETION.md` (Part A, A11).

## 1. Corrections to the previous report (A7)

Two statements in `COMPLETION.md` A7 were wrong and are superseded:

1. "The estimate accumulates over the whole session with no forgetting." The model already decays: every update first pulls the
   posterior toward the prior by `DECAY = 0.97`, so each feature has an effective sample ceiling of 33 and a half-life of ~23 updates.
2. The sweep "measured whether the table learns the scripted seat". It did not. The bots only ever read the human through the adapter
   (`PokerProfile` -> `table.setOpponentEstimate`). `sim:adaptive` and `holdem-adaptive-sweep.ts` have no adapter, so
   `table.opponent` was `null` and **the adaptive bots had no read of the scripted seat**. The "learned" column read an in-session model
   (`seatModels[0]`) that no policy consumes for the human, and the adaptive-vs-legacy difference measured the EV policy, not adaptation.
   The second-half dip in the switch scenarios is also confounded with the opponent: the second-half opponent (a nit) is intrinsically
   less exploitable than the first (a caller), independent of any learner.

## 2. The data path (as built)

```
human action -> PokerProfile.record() -> OpponentModel.observeDecision(ObservedDecision)   per action, public facts only
hand ends    -> PokerProfile.observe() -> OpponentModel.observeHandEnd(); repository.save(snapshot)
             -> adapter.learnFromHand() -> table.setOpponentEstimate(profile.opponentEstimate())   once per hand
bot decision -> observation.opponent (human) / observation.opponents[seat] (bots, in-session seatModels, live)
             -> ev-policy: vpip (range), foldToBet / foldToBet.<size> (fold probability), raiseVsBet + betWhenChecked (aggression)
```

Attribution: one model per human (persisted, `casino.opponent.holdem.v1`) and one per seat index in the table (in-session). Nothing
is shared between seats. Inputs are `ObservedDecision` (street, action, call amount, pot, legal actions): no hole cards, no deck.

## 3. Baseline (frozen: `docs/learner-baseline.json`, `npm run sim:learner:response -- --learner=legacy`)

200 seeds, deterministic synthetic opponents that switch style after 150 hands. Hands to cover 50% / 80% of the true move:

| Features | t50 / t80 |
| --- | --- |
| frequent: `vpip`, `pfr`, `raiseVsBet`, overall `foldToBet` | 16 to 27 / 41 to 72 |
| sparse: `foldToBet.small/.medium/.large` | 37 to 65 / 99 to never; 0.04 to 0.16 off after 150 hands |
| sparse: `betWhenChecked`, `showdown` | 19 to 115 / 48 to never |

Stable accuracy 0.01 to 0.07 mean error, jitter 0.02 to 0.06. One contrary decision after 100 stable hands moves a mean by 0.026.
Confidence after 3 hands: 0.12 to 0.29.

**Diagnosis.** Forgetting is per *update*, so a feature that fires 0.3 times per hand forgets 3x slower in hand-time (cause 1: update
cadence). `ev-policy.ts` prefers the size bucket over the overall fold estimate when the bucket's confidence is >= 0.2, so the slowest
signal drives the decision (cause 2). Frequent features are not the problem: ~20 hands to half-way is already quick, and raising their
decay would only add noise.

## 4. Design (hybrid, per feature)

- **Long track**: unchanged (the legacy Beta posterior, `DECAY = 0.97`, prior 4 at the baseline). Long-term tendencies stay available when
  recent evidence is sparse, and a stable opponent is estimated exactly as before.
- **Short track**: bounded excess counts `(sa, sb)` decayed by a per-feature `shortDecay` (ceiling `1 / (1 - shortDecay)`), read as a Beta
  *centred on the long mean* with `shortPrior` pseudo-observations. One surprising action can move it by at most `1 / (shortPrior + 1)`
  of the gap.
- **Blend**: `z = |short - long| / sqrt(var_short + var_long)`; weight `w = maxShift * clamp((z - zLow) / (zHigh - zLow), 0, 1)`; estimate
  `= long + w * (short - long)`. Thin recent evidence has large variance, so it cannot pass the test: sparse data keeps the long estimate.
- **Confidence**: `(1 - w) * conf_long + w * conf_short`, so a genuine change *lowers* confidence until the new regime is established.
- **Shared change signal**: a size bucket with little evidence of its own inherits the overall `foldToBet` shift (`(1 - w_b) * shift_parent`).
- Mean stays strictly inside (0, 1); storage per feature is five bounded numbers; no histories.
- Persistence: schema 2 adds `sa`, `sb`; schema 1 files restore with a neutral short track; hostile values are clamped; the legacy learner
  remains available as `LEGACY_LEARNER` (the control) and writes schema 1.

## 5. Acceptance criteria (fixed before tuning)

Executable in `opponent-learning.test.ts` (synthetic, deterministic) and `holdem-learner-eval.ts` (full table, paired).

| # | Criterion | Threshold |
| --- | --- | --- |
| C1 | Responsiveness after a genuine switch | for every scored feature, median `t50` and `t80` of the new learner <= 0.7 x legacy, and the sparse features reach 80% within the 150-hand window |
| C2 | Stable accuracy | steady error <= 1.15 x legacy and jitter <= 1.25 x legacy, per feature |
| C3 | Isolated action | one contrary decision moves any mean by <= 0.08 absolute and <= 1.5 x legacy |
| C4 | Sparse evidence | confidence after 3 hands <= legacy + 0.05; a 1-hand contrary burst cannot move any mean more than 0.12 |
| C5 | Strategy, stable opponents | paired new-minus-legacy difference: the 95% interval's lower bound is above -150 bb/100 in every stable scenario (non-inferiority) |
| C6 | Strategy, after a switch | second-half paired difference point estimate >= 0 pooled over the switch scenarios |
| C7 | Integrity | 0 refused decisions, 0 engine fallbacks, chips conserved in every cell; the policy returns a legal action for every tested model state |
| C8 | Persistence | save/restore equivalence for both schemas; schema 1 files restore; hostile files cannot produce an estimate outside (0, 1); snapshot <= 2.5 kB |
| C9 | Cost | model update + estimate <= 2x legacy per decision |

Tuning uses the scenarios and seeds named "tune" in the evaluation; the criteria are judged on held-out ones ("validate").

## 6. Results

Run on 2026-10-12 to 2026-10-14. **Decision: NO-GO beyond opt-in testing.** `LEGACY_LEARNER` stays the default; `RECENCY_LEARNER` is reachable only through the optional `learner` setting (`HoldemAdapterOptions.learner`, `HoldemTableConfig.learner`, the `PokerProfile` constructor). `src/casino/factory.ts` and the party server never pass one.

### 6.1 Provenance

- Git: the repository has **no commits**; the whole tree is untracked, so there is no revision and no diff. File fingerprints are at the end of this section. `docs/learner-baseline.json` is untouched, and regenerating the legacy curves (`sim:learner:response --learner=legacy`) reproduces it exactly.
- Full-table runs: `npm run sim:learner:eval -- --scenarios=<0..11> --tables=40 --hands=120 --difficulty=85 --seedBase=700 --out=docs/eval-parts/d85-s<N>.json`, one process per scenario, 12 in parallel. The first batch of 12 (started 2026-10-12 11:49) died with its session and left empty logs; nothing was recoverable. **Run 1** (12/12, exit 0, 36-47 min each) is kept in `docs/eval-parts/run1/`. A defect in the harness's "hands to cover half" metric was then found and fixed (below), and **run 2** (12/12, exit 0, 28-42 min each) repeated everything with identical parameters. Every paired difference, estimate error, wobble and integrity number is identical between the two runs (compared programmatically), so the evaluation is deterministic. Run 2's merged output is `docs/eval-parts/merged-report.txt`; the tables below are generated from its JSON.
- Sample: 40 paired tables x 120 hands per scenario, 12 scenarios, 3 arms per table (none / legacy / recency, rotated over seats). 0 refused actions, 0 engine fallbacks, chips conserved in all 12 cells (about 323,000 decisions).
- Harness defect fixed (evaluation code only, learner untouched): a table can end early (fewer than two funded seats; 0 to 12 of 40 tables per scenario, the shortest at 24 hands). The cross-table mean of an estimate then became NaN from that hand on, so a learner that had not crossed half-way before the first table ended read `never`. Run 1 therefore reported `never` for almost every legacy feature. Run 2 averages over the tables still playing, requires at least half of them, and prints the early-end count. The performance numbers were never affected (they are per-table totals, normalised by hands played). **Why tables end early was not investigated** (probable cause: bots are never re-bought).
- Synthetic probe: `npm run sim:learner:response -- --learner=recency` (200 seeds, seedBase 1000, saved as `docs/learner-response-recency.json`; a rerun reproduces it exactly). The probe and the tuning share seeds 1000+; held-out validation seeds are 70000+ in `opponent-learning.test.ts`. No tuning was done in this continuation.

The synthetic probe answers "how fast does the estimate follow a known opponent"; the full-table runs answer "do the bots play better". They are reported separately, and neither implies the other.

### 6.2 Acceptance matrix

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| C1 | t50 and t80 <= 0.7 x legacy on every scored feature; sparse features reach 80% in 150 hands | **FAIL** | probe: 8 of 24 (switch, feature) cells pass, 16 fail; t50 alone passes 16 of 24 (6.3) |
| C2 | steady error <= 1.15 x, jitter <= 1.25 x legacy | **PASS** | probe: worst steady-error ratio 1.01, worst jitter ratio 1.18; test A |
| C3 | one contrary decision moves any mean <= 0.08 and <= 1.5 x legacy | **FAIL** (strict reading) | `opponent-learning.test.ts` D fails: `foldToBet.small`/`.large` move 0.0078 where legacy moves 0 (limit 0.005 in the test). The absolute bound passes (max 0.039). Cause in 6.4 |
| C4 | confidence after 3 hands <= legacy + 0.05; a 1-hand burst moves a mean <= 0.12 | **PASS** | tests E |
| C5 | stable scenarios: paired lower bound > -150 bb/100 | **FAIL** | stable caller -209 [-722, 304]; nit, tag and maniac pass |
| C6 | pooled second-half paired point estimate >= 0 over switch scenarios | **PASS (point estimate only)** | +143 bb/100, interval [-88, 374]; 5 of 8 scenarios positive; not significant |
| C7 | 0 refused, 0 fallbacks, chips conserved; a legal action for every tested model state | **PASS** | 12/12 cells; test I; with the early-end caveat above |
| C8 | persistence: save/restore equivalence, schema 1 restores, hostile files bounded, snapshot <= 2.5 kB | **PASS** | tests G, H, plus the adapter test for the default path |
| C9 | model update + estimate <= 2 x legacy per decision | **PASS** | `npm run sim:learner:cost`, pinned to two cores: 0.79x to 0.82x (about 1.93 vs 2.43 microseconds per decision), 6 runs, order alternated. Unpinned runs under heavy outside CPU load ranged 0.78x to 2.25x, so the figure is trustworthy only pinned. Why the new learner measures cheaper than the control is unexplained |

Three criteria fail (C1, C3, C5), so the learner is not ready. Total evaluation runtime (about 28-47 minutes per scenario for 40 tables x 3 arms) cannot be split per arm because the arms share each table; only the per-decision cost above is measured per learner.

### 6.3 Measured results

#### C1, synthetic response probe (200 seeds, 150 hands before / 150 after, `sim:learner:response`)

Rule: PASS needs t50 and t80 each <= 0.7 x legacy (legacy `never` and recency finite = PASS); sparse features must also reach 80% inside the 150-hand window. n/e = both `never`, cannot be evaluated, counted as FAIL for the sparse window.

| switch | feature | t50 legacy>recency (ratio) | t80 legacy>recency (ratio) | C1 |
|---|---|---|---|---|
| passive > aggressive | pfr | 27 > 10 (0.37) | 72 > 58 (0.81) | FAIL |
| passive > aggressive | raiseVsBet | 22 > 11 (0.50) | 55 > 51 (0.93) | FAIL |
| passive > aggressive | betWhenChecked | 48 > 23 (0.48) | 132 > 118 (0.89) | FAIL |
| passive > aggressive | showdown | 19 > 15 (0.79) | 48 > 46 (0.96) | FAIL |
| aggressive > passive | pfr | 21 > 9 (0.43) | 53 > 17 (0.32) | PASS |
| aggressive > passive | raiseVsBet | 16 > 8 (0.50) | 41 > 34 (0.83) | FAIL |
| aggressive > passive | betWhenChecked | 46 > 20 (0.43) | 123 > 42 (0.34) | PASS |
| aggressive > passive | showdown | 34 > 28 (0.82) | 108 > 92 (0.85) | FAIL |
| aggressive > tight | vpip | 24 > 9 (0.38) | 61 > 36 (0.59) | PASS |
| aggressive > tight | pfr | 21 > 9 (0.43) | 53 > 29 (0.55) | PASS |
| aggressive > tight | foldToBet | 22 > 8 (0.36) | 57 > 33 (0.58) | PASS |
| aggressive > tight | foldToBet.small | 65 > 12 (0.18) | never > 125 (pass) | PASS |
| aggressive > tight | foldToBet.medium | 61 > 11 (0.18) | never > 119 (pass) | PASS |
| aggressive > tight | foldToBet.large | 56 > 10 (0.18) | never > 105 (pass) | PASS |
| aggressive > tight | raiseVsBet | 19 > 9 (0.47) | 50 > 37 (0.74) | FAIL |
| aggressive > tight | betWhenChecked | 115 > 74 (0.64) | never > never (n/e) | FAIL |
| aggressive > tight | showdown | 69 > 56 (0.81) | never > never (n/e) | FAIL |
| tight > loose | vpip | 27 > 17 (0.63) | 72 > 64 (0.89) | FAIL |
| tight > loose | pfr | 22 > 20 (0.91) | 55 > 51 (0.93) | FAIL |
| tight > loose | foldToBet | 18 > 12 (0.67) | 46 > 45 (0.98) | FAIL |
| tight > loose | foldToBet.small | 37 > 30 (0.81) | 99 > 95 (0.96) | FAIL |
| tight > loose | foldToBet.medium | 43 > 31 (0.72) | 129 > 123 (0.95) | FAIL |
| tight > loose | foldToBet.large | 47 > 34 (0.72) | 127 > 114 (0.90) | FAIL |
| tight > loose | showdown | 31 > 31 (1.00) | 94 > 93 (0.99) | FAIL |

C1 strict: 8 of 24 scored (switch, feature) cells pass; 16 fail. t50 alone passes in 16 of 24.

#### Full-table runs (12 scenarios, 40 paired tables, 120 hands, difficulty 85, seedBase 700; run 2, identical to run 1 on every paired number)

Paired differences are bb/100, mean [95% t-interval over 40 tables]. `ended` = tables that stopped before hand 120 (fewer than two funded seats) / fewest hands any table played.

| scenario | recency-legacy before | after change | whole session | legacy-none whole | recency-none whole | ended |
|---|---|---|---|---|---|---|
| stable caller | -209 [-722, 304] | n/a | -209 [-722, 304] | 149 [-354, 651] | -60 [-533, 413] | 0/40, min 120 |
| stable nit | 144 [41, 246] | n/a | 144 [41, 246] | -44 [-155, 67] | 99 [-38, 237] | 4/40, min 45 |
| stable tag | 292 [150, 433] | n/a | 292 [150, 433] | 24 [-61, 108] | 315 [172, 459] | 12/40, min 24 |
| stable maniac | 207 [-128, 542] | n/a | 207 [-128, 542] | -24 [-328, 281] | 183 [-194, 560] | 3/40, min 25 |
| caller>maniac @50% | -147 [-612, 318] | -74 [-1302, 1154] | -364 [-844, 116] | 425 [-45, 895] | 61 [-295, 416] | 3/40, min 63 |
| maniac>caller @50% | 230 [-79, 538] | 511 [-134, 1156] | 275 [-68, 618] | -88 [-425, 249] | 187 [-170, 544] | 4/40, min 25 |
| nit>maniac @50% | 147 [16, 279] | 186 [-202, 574] | 187 [-41, 414] | 53 [-122, 227] | 239 [30, 448] | 5/40, min 45 |
| maniac>nit @50% | 230 [-79, 538] | 237 [-154, 628] | 233 [-34, 501] | 4 [-218, 225] | 237 [-26, 500] | 2/40, min 25 |
| caller>maniac @25% | -16 [-428, 396] | -215 [-656, 226] | -162 [-549, 225] | 121 [-302, 545] | -41 [-390, 309] | 3/40, min 42 |
| caller>maniac @75% | -103 [-595, 390] | 463 [-527, 1453] | 39 [-507, 584] | 125 [-366, 615] | 163 [-334, 660] | 0/40, min 120 |
| maniac>nit @25% | 171 [-174, 516] | -140 [-335, 55] | -39 [-220, 142] | -6 [-216, 203] | -45 [-223, 133] | 7/40, min 25 |
| maniac>nit @75% | 138 [-185, 461] | 177 [-256, 611] | 152 [-133, 437] | -83 [-379, 213] | 69 [-243, 381] | 4/40, min 25 |

#### Hands after a style change until the mean estimate covers half of the move (full table, corrected metric)

| scenario | feature | legacy | recency | ratio | <=0.7x |
|---|---|---|---|---|---|
| caller>maniac @50% | pfr | 20 | 9 | 0.45 | yes |
| caller>maniac @50% | raiseVsBet | 19 | 8 | 0.42 | yes |
| caller>maniac @50% | betWhenChecked | 31 | 14 | 0.45 | yes |
| maniac>caller @50% | pfr | 18 | 9 | 0.50 | yes |
| maniac>caller @50% | raiseVsBet | 20 | 11 | 0.55 | yes |
| maniac>caller @50% | betWhenChecked | 11 | 7 | 0.64 | yes |
| nit>maniac @50% | vpip | 24 | 9 | 0.38 | yes |
| nit>maniac @50% | pfr | 23 | 10 | 0.43 | yes |
| nit>maniac @50% | foldToBet | 20 | 10 | 0.50 | yes |
| nit>maniac @50% | raiseVsBet | 29 | 11 | 0.38 | yes |
| nit>maniac @50% | betWhenChecked | 26 | 19 | 0.73 | NO |
| maniac>nit @50% | vpip | 21 | 11 | 0.52 | yes |
| maniac>nit @50% | pfr | 19 | 9 | 0.47 | yes |
| maniac>nit @50% | foldToBet | 18 | 7 | 0.39 | yes |
| maniac>nit @50% | raiseVsBet | 21 | 12 | 0.57 | yes |
| maniac>nit @50% | betWhenChecked | 27 | 21 | 0.78 | NO |
| caller>maniac @25% | pfr | 16 | 9 | 0.56 | yes |
| caller>maniac @25% | raiseVsBet | 16 | 9 | 0.56 | yes |
| caller>maniac @25% | betWhenChecked | 27 | 19 | 0.70 | NO |
| caller>maniac @75% | pfr | 21 | 7 | 0.33 | yes |
| caller>maniac @75% | raiseVsBet | 21 | 7 | 0.33 | yes |
| caller>maniac @75% | betWhenChecked | never | 17 | n/a | yes |
| maniac>nit @25% | vpip | 16 | 11 | 0.69 | yes |
| maniac>nit @25% | pfr | 14 | 9 | 0.64 | yes |
| maniac>nit @25% | foldToBet | 15 | 9 | 0.60 | yes |
| maniac>nit @25% | raiseVsBet | 15 | 11 | 0.73 | NO |
| maniac>nit @25% | betWhenChecked | 21 | 19 | 0.90 | NO |
| maniac>nit @75% | vpip | 23 | 12 | 0.52 | yes |
| maniac>nit @75% | pfr | 20 | 9 | 0.45 | yes |
| maniac>nit @75% | foldToBet | 21 | 11 | 0.52 | yes |
| maniac>nit @75% | raiseVsBet | 24 | 13 | 0.54 | yes |
| maniac>nit @75% | betWhenChecked | 28 | 16 | 0.57 | yes |

t50 <= 0.7 x legacy in 27 of 32 scored (scenario, feature) cells. (t80 is not reported by the full-table harness.)

#### Pooled paired differences (equal-weight mean of scenario means; interval assumes independent scenarios, which is optimistic because every scenario reuses seeds 700-739)

- stable scenarios, whole session, recency - legacy: 108 bb/100 [-46, 263]
- stable scenarios, whole session, recency - none: 134 bb/100 [-20, 289]
- stable scenarios, whole session, legacy - none: 26 bb/100 [-120, 172]
- switch scenarios, after the change, recency - legacy: 143 bb/100 [-88, 374]
- switch scenarios, after the change, recency - none: 233 bb/100 [55, 412]
- switch scenarios, after the change, legacy - none: 90 bb/100 [-132, 313]
- switch scenarios, before the change, recency - legacy: 81 bb/100 [-43, 206]
- switch scenarios, before the change, recency - none: 3 bb/100 [-138, 145]
- switch scenarios, before the change, legacy - none: -78 bb/100 [-216, 60]

#### Files
- sha256 5c4734268c6af69e src/casino/games/holdem/opponent-model.ts
- sha256 933612ad139b2a72 src/casino/games/holdem/ev-policy.ts
- sha256 0ab4b028ea923831 src/casino/games/holdem/profile.ts
- sha256 de3889e06939c0ec src/casino/games/holdem/engine.ts
- sha256 dfc66da2c7cd9ce3 scripts/holdem-learner-eval.ts
- sha256 7563e19516cbb097 scripts/learner-response.ts


### 6.4 Findings and disposition

**What the measurements support.**
- The recency estimate follows a style change much faster at the halfway point: in the full table, t50 <= 0.7 x legacy in 27 of 32 cells (the five misses are mostly the sparse `betWhenChecked`, ratios 0.70 to 0.90, plus one `raiseVsBet`). The estimate's error against the opponent's measured behaviour after a change is lower than legacy in all 8 switch scenarios (ratio 0.75 to 0.92), with equal error before the change and equal wobble when stable.
- That does **not** show better play. Pooled over the switch scenarios after the change, recency minus legacy is +143 bb/100 [-88, 374]. Recency versus no read is +233 [55, 412], but legacy versus no read is +90 [-132, 313], so the two learners cannot be told apart. Only two single cells exclude zero (stable nit +144 [41, 246] and stable tag +292 [150, 433]); with 12 scenarios and several segments each, a couple of such cells is expected by chance. The pre-change segment, where the learners barely differ, already shows differences up to +230 bb/100, which is the size of the noise. Intervals are typically +-300 to +-700 bb/100.
- No gameplay advantage over the legacy learner is supported by this evidence. 40 tables per cell cannot resolve effects of this size.

**C1 (adaptation).** The strict criterion fails mainly on t80 and on moderate switches (tight>loose: every feature, ratios 0.63 to 1.00; passive>aggressive: every feature). Large switches (aggressive>tight, aggressive>passive) pass in many cells. Hypotheses consistent with the code but **not tested**: (a) `shortPrior` pulls the short mean toward the long mean, which caps how far the blended estimate can travel and so mainly slows the last 20% of a move; (b) for a moderate move the divergence `z` rarely reaches `zHigh` 2.2, so the blend weight stays below 1 (`opponent-model.ts:459-461`); (c) `betWhenChecked` and `showdown` receive few events per hand. Two cells (aggressive>tight `betWhenChecked` and `showdown`) are `never` for both learners at t80, so the criterion cannot be evaluated there and they count as failures. No tuning round is justified until the specification says whether a 0.7x t80 gain is attainable for moderate switches at all; any change needs a fresh validation seed set.

**C3 (isolation).** Traced and confirmed: `blend()` (`opponent-model.ts:466-479`) gives each size bucket `(1 - own.w) x parent.shift`, so one contrary `raiseVsBet` observation, which updates `foldToBet` and `foldToBet.medium` only, also moves the untouched `.small` and `.large` buckets by 0.0078 through the parent. The 1.5 x legacy clause is degenerate when legacy moves a feature by exactly 0, so any pooling fails it. Both readings are defensible: it is a real, intended pooling effect that the written criterion forbids. The test and thresholds are unchanged and the test stays red. Recommendation (not applied): either (1) amend C3 with an explicit additive floor (for example 0.01) in a reviewed specification change, or (2) change the code so a bucket inherits the parent shift only once the parent weight `w` is non-zero, then re-run tests B and E on fresh seeds; option 2 costs some of the bucket speed-up that test B checks.

**C5.** The stable-caller failure is a wide interval around a negative point estimate (-209): the data neither show harm nor rule it out. It is a failure of the criterion as written, not proof of a regression.

**Production integration and privacy (confirmed from code and tests).**
- Default is legacy: `DEFAULT_LEARNER = LEGACY_LEARNER` (`opponent-model.ts:187`); `factory.ts:140-157` builds the adapter without `learner`; the party server (`src/party/server.ts`) never sets one. `adapter-learner.test.ts` plays real `HoldemAdapter` hands and asserts: the default writes schema 1 with no `sa`/`sb`; a configured recency learner is the one in use; the profile saw the human's real decisions (`rejectedUpdates` 0, a calling-station read); and the table holds exactly the estimate the profile published.
- The legacy path is unchanged when `recency` is null: `own()` returns the long-track estimate, the `sa`/`sb` update is skipped and the snapshot omits them (`opponent-model.ts:426-432, 452, 516`). In the full run 1,509 tests pass, including the saved-checkpoint and Hold'em suites.
- Nothing new is exposed: the estimate keeps its shape (`mean`, `confidence`, `samples`, `baseline`); `botAnalysis()` is empty while a hand is live (`engine.ts:1293`) and otherwise returns only the estimate and the last 6 learning events; `sa`/`sb` appear only in `snapshot()` (the `casino.opponent.holdem.v1` profile and table checkpoints), and only for a recency learner. Schema 1 restores into either learner and schema 2 restores into either; unknown schemas are discarded and hostile values clamped (tests G).
- Not audited: browser-side behaviour of the AI inspector panels beyond the types they receive. No analytics or logging of the estimate was found by grep.

**Test suite on the final tree** (`npx vitest run`, 1,518 tests, 92 files): 1,509 passed, 1 skipped, 8 failed in the one full run. One is C3. The other seven were timeouts or a reset socket under heavy outside CPU load (an unrelated `colmap` job and a stray `find /` held the machine near 90%): each passed when re-run alone or with a longer timeout from the command line (the repository's 20 s limit was not changed). The roulette lab has its own 60 s limit and needed 70-80 s under load, 56 s alone. A fully quiet re-run of the whole suite was not possible. Typecheck, lint and production build all exit 0.

### 6.5 Next actions

1. Decide C3 (specification amendment or the code change in 6.4) and whether C1's t80 clause is meant to apply to moderate switches.
2. Find why tables end early in the harness and, if bots should be re-bought, fix it and re-run; then raise the sample (several hundred tables per cell) with a pre-registered primary comparison instead of 12 scenarios x 3 segments before drawing any conclusion about play quality.
3. Re-run the whole suite on a quiet machine.
