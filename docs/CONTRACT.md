# CASINO ARENA — Frontend Contract (v1)

**This is the document Anti-Gravity builds against.**

The backend owns every fact below. The frontend renders and animates what it
is told, never derives it. There is no code path in which the client picks a
card, resolves a hand, or decides a payout — so there is none in which it could
get one wrong.

Source of truth: `src/casino/engine.ts` (the engine contract),
`src/casino/session.ts` (the table lifecycle) and the per-room engines under
`src/casino/games/`. The legacy arena event stream in `src/arena/core/events.ts`
remains the blackjack AI surface.

---

## 0. Chip ownership, stated once

```
Every chip is in exactly one of three places, at every moment:

  1. wallet.balance()          the persistent cross-game balance
  2. a table bankroll          escrowed into a live session
  3. exposure.total            chips that have LEFT the wallet and are
                               owned by an unresolved engine state
```

and the invariant

```
wallet.balance() + tableBankroll + exposure.total  ==  all chips
```

holds at every step of every round in every room. `engine.exposure()` is the
only thing allowed to answer "how many chips are outstanding", and it must
**never** count an engine's internal mirror state — a blackjack split or double
commits chips inside the table that have not been debited from the wallet yet,
so those chips are still inside `tableBankroll` and counting them again would
make a double look like it minted money. `clear` is a separate, stricter flag:
`false` means the session must refuse to close.

`TableSession.end()` throws while `clear === false`. That is not a crash to
route around — it is the guarantee that a live hand cannot be cashed out.

---

## 0b. Casino War — the ruleset the engine implements

A tie does **not** end the hand. It commits the Ante and opens a decision.

```
ANTE  ──► deal ──► no tie ──► winner takes the Ante at 1:1
                 └► tie ────► the Ante is COMMITTED, player chooses:

   PUSH ──► Ante returned unchanged.        net   0
   WAR  ──► a second wager equal to the Ante is staked and a second deal
             is made. The ORIGINAL Ante is never at risk again:

               player wins the war deal ──► Ante PUSHES, War WINS 1:1
               dealer wins the war deal ──► Ante PUSHES, War LOSES
               second deal ties          ──► Ante PUSHES, War FORFEITS
```

| Scenario | Staked | Returned | Net |
| --- | --- | --- | --- |
| Ante 100, War 100, player takes the war | 200 | 300 | **+100** |
| Ante 100, War 100, dealer takes the war | 200 | 100 | **−100** |
| Ante 100, War 100, war deal ties | 200 | 100 | **−100** |
| Ante 100, player declines (PUSH) | 100 | 100 | **0** |
| Ante 100, no tie, player wins | 100 | 200 | +100 |

The player wins **the war wager and nothing else**. Paying the Ante at 1:1 on a
war win would return 400 on 200 staked — a double payment of a bet that pushed.

The `TIE` side bet is a **third, independent** wager: it pays 10:1 on a tie and
settles on the *opening* deal. The war never re-settles it.

---

## 0c. Sic Bo — the ruleset the engine implements

Macau standard payouts (`PAYOUTS` / `TOTAL_PAYOUTS` in `src/casino/games/sicbo.ts`).

| Zone | Pays | Rule |
| --- | --- | --- |
| `big` | 1:1 | sum 11–17 **and not a triple** |
| `small` | 1:1 | sum 4–10 **and not a triple** |
| `odd` / `even` | 1:1 | sum parity **and not a triple** |
| `double:n` | 10:1 | **exactly two** `n`s |
| `triple:n` | 150:1 | three `n`s |
| `anyTriple` | 30:1 | any triple |
| `single:n` | 1/2/3:1 | one, two or three `n`s |
| `combo:a-b` | 5:1 | at least one `a` and one `b` |
| `total:n` | per table | sum is `n` **and not a triple** |

Three rules the frontend must **not** re-derive — read them from the view:

1. **A triple kills Big and Small.** `view.big` / `view.small` already encode it.
   `6,6,6` (sum 18) is `triple: true, big: false, small: false`. Computing
   `sum >= 11` on the felt would light up a winner the engine refuses to pay.
2. **A Double is exactly two.** `6,6,6` is *not* a winning `double:6` — it pays
   its own triple zones, which are strictly better. Use `view.doubles`.
3. **A triple loses every total bet**, including the one it happens to sum to.

---

## 1. The one rule that shapes everything

```
ENGINE decides  →  EVENT carries the decision  →  UI animates it
```

The UI receives **already-decided values**. A roulette number, a dice roll and
a hole card are all chosen by the engine *before* any animation starts. An
animation finishing tells you nothing, because nothing was pending.

Corollary: **never read a value off the DOM, a timer, or a calculation to
decide an outcome.** If you need the dealer to "decide" something after a
delay, that value belongs in an event.

---

## 2. Wiring up

```ts
import { ArenaSession, defaultSeats } from '@/arena/session';
import { createRandomProvider } from '@/arena/core/rng';
import { EventStream } from '@/arena/core/events';

// `secure` in production. `seeded` makes a session reproducible for a bug report.
const events = new EventStream();
const session = new ArenaSession(createRandomProvider('secure'), events, {
  seats: defaultSeats(),   // you + all six archetypes
  difficulty: 70,          // 70-90 adaptive; 95 elite, opt-in
});

events.subscribe((event) => {
  // Switch on `event.type` and update your store. This is the only channel.
});
```

### The round loop

```

---

## 3. Events

Every event has `{ seq, at, round, type, payload }`. `seq` is monotonic — use it
to drop out-of-order updates and to resume a session from a log.

| Event | When | What to do |
| --- | --- | --- |
| `GAME_STARTED` | session opens | build the table, seats, avatars |
| `ROUND_STARTED` | new round | clear the felt |
| `BETTING_OPEN` | betting phase | enable chip buttons |
| `BET_PLACED` | a seat bets | slide that seat's chips in |
| `BETTING_CLOSED` | deal begins | lock the chips |
| `CARD_DEALT` | a card lands | fly it from the deck to the seat |
| `TURN_STARTED` | seat owes an action | focus the seat |
| `BOT_THINKING` | bot is deciding | show the delay, then the action |
| `BOT_ACTION` | bot acted | update the hand |
| `PLAYER_ACTION` | human acted | update the hand |
| `DEALER_ACTION` | dealer drew/revealed | animate the dealer |
| `CARD_REVEALED` | hole card turned | **flip** — the value arrives here |
| `ROUND_RESOLVED` | round decided | show the banner |
| `PAYOUT` | chips returned | return the stack to the seat |
| `BOT_EMOTION` | bot reacted | drive the avatar |
| `BOT_LINE` | bot spoke | speech bubble |
| `BEHAVIOR_UPDATED` | player model changed | update the analytics panel |
| `DIFFICULTY_UPDATED` | difficulty moved | update the badge |

### Cards

```ts
interface PublishedCard {
  id: string; rank: 'A'|'2'|…|'K'; suit: 'S'|'H'|'D'|'C';
  faceUp: boolean;   // false = render a back. The value is still there — ignore it.
  seatId: string;    // or 'dealer'
  order: number;     // stable, per-round. Use for React keys.
}
```

> **Never render a `faceUp: false` card's face.** The engine publishes the hole
> card so your card component has something to hold, but rendering it early is
> a spoiler. Its value only becomes public at `CARD_REVEALED`.

### Chip stacks

Chips arrive **already decomposed**. You never compute a stack.

```ts
[{ denomination: 100, index: 0, zone: 'bet:player' },
 { denomination: 25,  index: 1, zone: 'bet:player' }]
```

- `index` is bottom-up: `0` is the base of the pile.
- `zone` is the target area, for your chip-physics target position.
- Deterministic — the same amount always yields the same pile, so a re-render
  never reshuffles chips under the player.

---

## 4. State snapshot

`session.snapshot()` returns a `TableState`: `phase`, `round`, `seats[]`,
`dealer`, `dealerHidden`, `difficulty`, `results[]`, and `turn` (the seat
awaiting action, or `null`).

**Phases:** `BETTING → DEALING → PLAYER_ACTION → DEALER_REVEAL → DEALER_TURN →
ROUND_COMPLETE`

Drive your affordances off `phase` plus `turn`:
- `phase === 'PLAYER_ACTION' && turn === 'player'` → enable the action buttons
- otherwise → disable them, but **keep them visible** (see §7)

Ask for legal actions rather than guessing:

```ts
table.availableActions('player') // ['HIT', 'STAND', 'DOUBLE']
```

The same list gates the bots. If it isn't in that array the engine rejects it —

---

## 5. The fairness guarantee (what you can rely on)

Difficulty changes **how bots think**, never **what cards are dealt**.

This is not a promise, it is a test:

```
npm run sim:fairness
```

```
difficulty 70: chi-square 18.97 (df 12, n 429487)
difficulty 70 vs 90: chi-square 0.02 (df 12)
chart-player win rate by difficulty: 47.34%, 47.42%, 47.33%
Verdict: FAIR
```

Practically:
- A player's win rate does **not** trend upward as difficulty rises.
- Emotions are presentation only and never correlate with a result arriving.
- Never scale an animation's content by a "difficulty" multiplier.

---

## 6. Bots

Six archetypes ship by default.

| id | Name | Character |
| --- | --- | --- |
| `pro` | The Pro | chart-accurate, restrained, low variance |
| `gambler` | The Gambler | big bets, loud reactions |
| `rock` | The Rock | flat bet, flat expression, most predictable |
| `chaos` | The Chaos | highest entropy, least predictable |
| `mathematician` | The Mathematician | lowest-variance bets |
| `beginner` | The Beginner | learns, high adaptation, low confidence |

### Emotion

`BOT_EMOTION` gives `{ emotion, intensity }`, where intensity is **already**
scaled by the bot's expressiveness — a Pro's internal change and a Gambler's
are different numbers. **Use `intensity` directly as your animation amplitude.**
Do not re-scale by personality; that would double-count.

Emotions: `neutral · focused · excited · confident · surprised · frustrated ·
disappointed · relieved · amused · nervous · curious · celebratory`

> These are **fictional avatar states for a game character**. They are not, and
> must not be presented as, inferences about a real person's emotions. The
> platform never assigns an emotional state to a *player*.

Emotion has momentum and decays — a bot that loses repeatedly drifts toward
`frustrated` and eases back. Don't snap it to neutral yourself.

### Dialogue

`BOT_LINE` arrives only when the bot chooses to speak. Silence is a legitimate
reaction and the cooldown is deliberate — don't fill the gaps.

---

## 7. Accessibility (non-negotiable)

The existing table already meets WCAG AA; keep it that way.

- **Disabled buttons stay visible** with their label. Never communicate
  availability by absence.
- A `role="status"` live region announces hands, scores, insurance and results.
- Every hand is exposed as a **labelled image**, e.g. *"Your hand: King of
  spades, 2 of hearts. Total 12."* The hole card is never named while face
  down.
- Respect `prefers-reduced-motion` **and** the in-app toggle. Every animation
  needs a reduced-motion path reaching the same end state.
- Zoom must not be blocked.

---

## 8. What the backend deliberately does **not** do

- It does not animate. Timing is yours; the *order* of events is the contract.
- It does not know about physics. Cards and chips carry enough data
  (`denomination`, `index`, `zone`, `order`, `faceUp`) for any motion system.
- It does not call an LLM for reactions. Lines come from a weighted pool, so
  the same event gives a different but character-consistent reaction.

---

## 9. Adding a second game

The engine contract is `src/arena/core/contracts.ts`. A new game implements
`GameModule` and registers itself; the lobby and both labs pick it up with no
further wiring. The shared vocabulary — RNG, chips, events, difficulty,
behaviour model, personality — is game-agnostic by design and should not be
forked per game.

so the UI can never offer an illegal move.

session.beginHumanDecision()   // starts the decision timer
table.beginBetting()           // open the betting phase
session.placeBet('player', 100)
session.startRound()           // deal; bots act until a human is needed
session.act('player', 'HIT')   // repeat until the round completes
```

Read `session.snapshot()` after each `act`. When `phase === 'ROUND_COMPLETE'`
the round is over and the behaviour model has been updated.
