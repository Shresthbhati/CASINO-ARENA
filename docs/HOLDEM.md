# Texas Hold'em: engine invariants, the opponent learner, and known limits

Everything here is virtual chips. Nothing in the learner or the policy can deal a
card, move a chip or change a payout. The sections below say what is guaranteed,
where it is enforced, and which test fails if it stops being true.

## 1. Engine invariants (`src/casino/games/holdem/engine.ts`)

| Invariant | How it is enforced | Test |
| --- | --- | --- |
| A seat with no chips at the deal **sits out**: no cards, no blind, never asked to act, reported `sittingOut` (and `folded`, so every consumer excludes it). | `startHand` resets every seat and sets `sittingOut = stack <= 0`. | `engine-regressions` A |
| A hand needs two funded seats; refusing touches nothing. | The funded-seat check runs *before* any state changes. | `engine-regressions` A |
| Heads-up rules apply to the seats **playing**, not the seats configured. | `postBlinds` counts non-sitting-out seats. | `engine-regressions` A |
| A betting round closes when nobody is *facing* a bet and nobody is *owed an option*. A check-down closes; the big blind keeps its option. | `advance()` (replaces "action returned to the last raiser", which never closed an unraised street). | `engine-regressions` B/E |
| A short all-in does not reopen raising for seats that already acted, but those seats still get to call or fold. | `canRaise` + `betSeen`. | `engine-regressions` E |
| A refused or zero-value commitment changes nothing. | `commit()` returns a boolean and **every** caller stops on `false`; `applyAction` mutates only after chips moved. | `engine-regressions` C |
| `phase` follows the street (`PRE_FLOP`, `FLOP`, `TURN`, `RIVER`, ...). | `closeStreet` writes it. | `engine-regressions` B |
| Bot actions are validated against `legalActions()`. A refused decision is retried (bounded), counted, and only then replaced by check-else-fold. | `runBots`; counters in `botDiagnostics()`. | `engine-regressions` D |
| Chips are conserved every hand. | `settleHand` asserts `sum(awarded) == sum(committed)` before any money moves. | every simulation test |

### Pot construction (`pots.ts`)

Folded chips stay in the pot and folded seats cannot win. Layers are built from
contribution levels; only non-folded seats that reached a level can win it. Odd
chips go to the first winner in seat order. An uncalled excess returns to the
seat that bet it.

A layer **nobody** could win used to be paid to every non-folded seat, including a
seat that had put nothing in. It is now flagged `unclaimed` and refunded to its
contributors, so no chip is lost, minted, or paid to a non-contributor. Legal play
cannot reach that shape any more (the legal-action search finds 0 across ~14,000
layers), and outside production `settleHand` **throws** with the full evidence if
it ever does (`assertPotIntegrity`).

## 2. The opponent learner (`opponent-model.ts`)

```
observed legal action -> sanitised features -> OpponentModel update
   -> confidence-weighted estimate -> personality-aware policy
   -> engine legal-action validation -> authoritative engine
```

It extends the existing `PokerProfile` / `PokerPlayerRead` channel rather than
adding a second AI stack, and reuses the repository's `arena/ml/bayesian.ts`.

**Features** (all Bernoulli frequencies, fixed set of 9, so storage cannot grow):
`vpip`, `pfr`, `foldToBet` (+ `.small/.medium/.large` by bet size relative to the
pot), `raiseVsBet`, `betWhenChecked`, `showdown`.

**Estimator.** Each feature is a Beta posterior starting at a population baseline
worth 4 pseudo-observations, so one action cannot create an extreme profile.

- *Bounded evidence:* one update adds at most weight 1; NaN/negative/infinite
  input is rejected and counted.
- *Recency:* before each update old evidence decays toward the prior (`DECAY =
  0.97`, half-life about 23 updates), so the estimate reverses when behaviour
  does and effective sample size is capped near 33.
- *Correlated evidence:* the j-th observation of a feature inside one hand carries
  weight `0.6^j`.
- *Confidence* = `nEff / (nEff + 8)` where `nEff` is evidence above the prior.

Measured (`npm run sim:learning`): an always-raising player reads 12% -> 30% -> 60%
-> 84% -> 88% after 0/1/5/25/50 hands (confidence 0% -> 11% -> 37% -> 69% -> 77%);
after 40 raising then 40 calling hands the estimate is 22%, where a plain running
average would still say 50%.

**Policy** (`policy.ts: opponentAdjust`). Personality supplies the baseline
thresholds. The read only nudges them: raise threshold within +/-0.10, call-down
within +/-0.12, sizing within +/-0.10, each scaled by that feature's confidence,
by the bot's own `adaptation` trait, and divided by the number of live opponents.
Bluff size is picked from the size the player actually folds to (needs
confidence >= 0.2). The Rock's raise threshold sits ~0.25 above the Gambler's, so
even the most favourable read cannot make them alike (tested).

**Persistence.** `ProfileRepository` is the seam. The game uses `browserRepository`
(`localStorage` key `casino.opponent.holdem.v1`); tests and simulations use
`memoryRepository` (nothing is written). Snapshot:
`{ schema, hands, updates, rejected, keys: { <feature>: { a, b, n } } }` - a few
hundred bytes, aggregate counts only, no hands, names or identifiers. `restore()`
accepts only the current schema, clamps every number, ignores unknown keys, and
falls back to the baseline on anything else. The felt shows the read ("Bots' read
of you") and offers **Forget my profile**.

## 3. Fairness boundary

- `opponent-model.ts` imports only `./types` and `arena/ml/bayesian` (no RNG, cards,
  engine, pots, wallet, ledger or settlement) - asserted on the source text.
- The policy cannot reach money or the deck (import test) and returns an *action*.
- The deal stream's shuffle draws are identical whatever the bots have learned
  (`opponent-model.test.ts`), and identical across difficulty levels
  (`holdem-audit-engine.test.ts`).
- The learner's input is public actions only; hole cards are never an input.

## 4. Abandoned sessions (`wallet.ts: recoverAbandonedSessions`)

The wallet ledger is saved at every buy-in but a live table is not, so a reload used
to leave a `BUY_IN` with no return: the chips left the vault and sat in a table
that no longer existed. On load, any session with a buy-in and no return is
closed: an unresolved wager is **forfeited** (refunding it would let a closed tab
undo a losing hand) and the surviving table bankroll is returned. Both are
ordinary ledger postings, `verify()` still balances, and the call is idempotent.
Covered by `abandoned-sessions.test.ts`, including a real store reload.

## 5. The adaptive policy (`ev-policy.ts`, `equity.ts`, `strategic-state.ts`)

The game (via `HoldemAdapter`) seats `decideAdaptive`; a raw `HoldemTable` still
defaults to the cheap legacy `decide` so the large simulations stay fast.

```
observation -> equity vs estimated ranges -> per-seat opponent estimates
  -> strategic state -> EV of every legal candidate -> entropy over near-best
  -> engine validates and executes -> learning update (models, state)
```

- **Equity** (`equity.ts`): seeded importance-weighted Monte Carlo using the
  repository's evaluator. Range likelihoods read only the current public board.
  One pass yields equity vs the estimated range, vs a calling range and vs a heavy
  (large-bet) range. Cost is capped (`MAX_EQUITY_ITERATIONS`, about 14 ms/decision).
- **Contesting seats**: seats still to act join with the probability a player facing
  this price continues, so a six-handed pot is not priced as six certain showdowns.
- **Strategic state**: aggression, bluff credit, value bar, call margin, risk and
  exploit are tethered to the personality prior (bounded step and drift). Each has
  one tested effect. Results move only `drawdown`, which only lowers `risk`.
- **Opponent estimates**: every seat has an in-session model fed by public actions;
  the human also has the persisted profile. Exploitation scales with confidence.
- **Entropy** only chooses among options within a margin of the best EV.
- **Boundaries**: these files import no engine, pot, wallet or shoe code (tested).
  A bot's working derives from its hole cards, so it is withheld (`botAnalysis()`,
  `view().reasoning`) until the hand ends.

## 6. Hand review (`review.ts`, `HandReviewPanel.tsx`)

The engine records the player's own redacted observation at each decision
(`humanDecisions()`, empty while a hand is live). The review prices each decision
with the same EV code, separating known facts (pot, price, action) from estimates
(equity, option values). The verdict never uses the hand's result.

## 7. Verify

```
npm test                 # full suite
npm run typecheck        # app
npm run typecheck:arena  # arena subset
npm run lint
npm run build
npm run sim:learning     # learner curves, behaviour, integrity counters
npm run sim:adaptive     # personality style + adaptive-vs-legacy head to head
npm run lab              # opponent profiles, train vs held-out seeds, adaptation, cost
npm run sim:house        # measured return-to-player vs theory for games of chance
```

## 8. Known limitations

- **Equity is estimated against modelled ranges**, never real opponent cards, and
  carries sampling error (shown as +/-). Four-card (Omaha) hands use the legacy path.
- **Bots model each other only within a session.** The cross-session persisted
  profile covers the human only.
- **Adaptive vs legacy results** are measured against scripted opponents with 100bb
  stacks over short tables: indicative, high variance, and the legacy policy is a weak
  baseline (see `npm run lab`; read the standard errors).
- **The default `minRaiseTo` for an opening bet is `bigBlind + bigBlind`**
  (two big blinds); real rules allow a one-big-blind bet. Pre-existing, pinned by
  existing tests, not changed.
- **Only the human's chips cross the wallet.** Bot stacks are house float and
  never refill, so a bust bot stays out for the rest of the table.
- **No mid-hand resume.** A reload abandons a live hand (forfeit, see section 4).
- **Omaha is not implemented** (`COMING_SOON`). Only its evaluator exists.
- **Learned profiles are per device**, not per account; there is no sync.
