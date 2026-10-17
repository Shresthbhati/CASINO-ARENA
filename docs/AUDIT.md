# CASINO ARENA — Repository Audit (pre-refactor historical snapshot)

> [!NOTE]
> **Historical Archive Only.** This document reflects the pre-refactor state of the repository before the platform refactor, unified casino wallet, deterministic game engines, and full test suite were implemented.
> For the authoritative current system state, see [`docs/COMPLETION.md`](file:///c:/Users/shres/OneDrive/Desktop/codes/blackjack/docs/COMPLETION.md) and [`docs/NEXT-IMPLEMENTATION.md`](file:///c:/Users/shres/OneDrive/Desktop/codes/blackjack/docs/NEXT-IMPLEMENTATION.md).

Recorded before any code was changed. Every claim below was verified by reading
the file named, not inferred from a component's name.

## 1. Two parallel stacks, only one of them wired

| Stack | Files | Wired to UI? |
| --- | --- | --- |
| **Legacy single-player** | `src/game/*` (`machine.ts`, `settle.ts`, `strategy.ts`, `deck.ts`, `hand.ts`, `money.ts`, `rules.ts`), `src/store/gameStore.ts`, `src/components/{Table,Header,BettingPanel,...}.tsx` | **No.** `App.tsx` never renders these components. Only `ArenaHeader` reads `gameStore` — and only to print a *cents* bankroll that no game writes to. |
| **Arena** | `src/arena/**`, `src/store/arenaStore.ts`, `src/store/arenaTableStore.ts`, `src/components/arena/**` | Yes. |

The legacy `gameStore` bankroll shown in the arena header ("Vault $X.XX") is
**not** the balance any game plays with. It is a dead read of an engine that
nothing routes to. That is the single most misleading thing in the app.

## 2. Infrastructure that genuinely exists

- `src/arena/core/rng.ts` — injectable `RandomProvider` (secure/seeded/simulation),
  Fisher–Yates `shuffle`, per-seat derived streams. **Real.**
- `src/arena/core/events.ts` — `EventStream` with monotonic `seq`, retained log,
  subscribers, typed payload map. **Real.**
- `src/arena/core/chips.ts` — integer-only denominations, `composeStack` greedy
  decomposition, `ChipLedger`. **Real**, but the denomination set is local to the
  arena and duplicated again in `ChipStack.tsx`.
- `src/arena/core/contracts.ts` — `GameModule`, `GameSession`, `GameRegistry`.
  **Real but unused**: nothing registers a module, so `GameRegistry.list()`
  returns empty and no code path calls `createSession`.
- `src/arena/games/blackjack/table.ts` (1059 lines) — `BlackjackTable`: real
  shoe, round-robin deal, hole card held in state, 7-phase machine, bots that
  size their own wagers, per-seat `ChipLedger`, `settle()` via `resolveRound` /
  `payoutFor`. **This is the only authoritative game engine in the repo.**
- `src/arena/session.ts` — `ArenaSession` orchestrator (behaviour model,
  difficulty, decision recorder).
- `src/arena/ai/**`, `src/arena/ml/**`, `src/arena/simulation/**` — real AI/ML
  and real fairness/AI labs, all seeded and tested.

## 3. Per-game audit

"Engine?" means an authoritative module that owns the rules; a component with
`useState` does not qualify.

| Game | Engine | RNG | State machine | Bets authoritative | Payouts | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Blackjack | `BlackjackTable` | seeded `RandomProvider` | 7 phases | table-local `ChipLedger`, **not** connected to any wallet | `resolveRound`/`payoutFor` | **PLAYABLE engine, no casino integration** |
| Texas Hold'em | none | none | none | none | none | **PROTOTYPE** |
| Omaha | none | none | none | none | none | **PROTOTYPE** |
| Roulette | none | `Math.random()` inside the component | none | none (a local `Record<string,number>`) | **none at all** | **PROTOTYPE** |
| Baccarat | none | none | none | none | none | **PROTOTYPE** |
| Sic Bo | none | `Math.floor(Math.random()*6)+1` in component | none | none | none | **PROTOTYPE** |
| Craps | none | same component as Sic Bo | none (no point, no 7-out) | none | none | **PROTOTYPE** |
| Teen Patti | none | none | none | none | none | **PROTOTYPE** |
| Three Card Poker | none | none | none | none | none | **PROTOTYPE** |
| Casino War | none | none | none | none | none | **PROTOTYPE** |
| High Card | none | none | none | none | none | **PROTOTYPE** |
| Wheel | none | `Math.random()` for rotation only | none | none | none | **PROTOTYPE, actively misleading** |


### Specific fake-gameplay evidence

- `PokerArenaTable.tsx:18-44` — hole cards and the full board are **literals**
  (`A♠ K♥`, `Q♠ J♥ 10♣ 2♦ 7♥`). `advanceStreet()` walks a `useState` string.
  Fold produces `"You folded. Victor Vance scoops the pot."`; the river produces
  `"You win with an Ace-High Broadway Straight!"`. Pot is `useState(350)`.
- `BaccaratArenaTable.tsx:51-58` — the hands are the literals `9♥ 8♦` and
  `K♠ 6♣`. `calculatePoints` is real, but it only scores a constant.
- `SpecialGamesArenaTable.tsx:47-64` — `A♠ K♥ Q♦` vs `J♣ 10♠ 9♥`, and
  `K♥` vs `10♠`. The announcement is a fixed string.
- `SpecialGamesArenaTable.tsx:31-40` — the wheel rotates a random number of
  degrees and then **always** announces `10X MULTIPLIER`. The result and the
  animation are unrelated.
- `RouletteArenaTable.tsx:41-53` — `Math.floor(Math.random()*37)` is computed in
  the component; no bet on the layout is ever evaluated, so no wager can win or
  lose anything.
- `DiceGamesArenaTable.tsx:61-83` — dice are rolled in the component and the
  announcement is `Sum N — BIG!`; the `bets` record is accumulated and then
  never read again.

### Fake data presented as the player's own history

- `arenaStore.ts:80-140` — `INITIAL_SESSIONS`: four fabricated completed
  sessions ("sess-101"…"sess-104") with invented bankrolls, deltas and
  durations. Rendered by `SessionHistoryView` as the player's audit ledger.
- `arenaStore.ts:206-217` — `playerAnalytics` is a hardcoded personality
  ("Disciplined Value Tactician", `handsAnalyzed: 142`) that no gameplay ever
  wrote.
- `arenaData.ts:243-327` — `INITIAL_ACHIEVEMENTS`: three achievements ship
  pre-unlocked (`first-bj`, `streak-5`, `full-table`) with fabricated
  `unlockedAt` timestamps, and the locked ones carry fabricated progress
  (`14 / 20`, `2 / 3`, `28400 / 50000`).
- `arenaData.ts:3-105` — every bot carries a hardcoded `bankroll`,
  `sessionDelta`, `recentActions` and `lastReasoning`. These are presented by
  `AIInspectorDrawer` / `BotAvatar` as the bot's live state.

A brand-new player therefore starts with a win history, a personality, four
sessions and three trophies.

## 4. Platform pieces that do not exist

1. **No casino wallet.** No cross-game persistent balance. `arenaTableStore`
   starts every blackjack seat at a hardcoded `10_000` (`defaultSeats`), and the
   seat's chips die with the session.
2. **No transaction ledger.** `applyLedgerEntry` is the only accounting, and it
   keeps four running totals per seat with no itemised history.
3. **No buy-in.** The number the player selects has nowhere to come from.
4. **No player-count selection.** `defaultSeats()` always builds exactly
   `player + 6 bots`; there is no code path that builds a different seat list
   from a user choice.
5. **No session lifecycle or summary.** There is no way to end a session, and no
   computation of starting/ending bankroll, net, rounds, duration.
6. **No game registry wiring.** `GameRegistry` exists, nothing registers.
7. **Chip denominations disagree in three places**: `arena/core/chips.ts`
   (`5…5000`), `components/arena/Chip.tsx` (`5…5000` as a TS union) and
   `components/arena/ChipStack.tsx` (its own `[5000…5]` list plus its own greedy
   decomposer).

## 5. What is worth keeping

The blackjack engine, the AI/ML layer, the RNG, the event stream, the fairness
and AI labs, and the chip decomposition maths are all real and tested. The
refactor must not weaken the fairness architecture: `startRound()` fixes the
entire shoe before any bot is consulted, and that ordering has to survive.
