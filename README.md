# BLACKJACK · 21

A premium, single-player Blackjack table. One player, one dealer, one 52-card
deck, three actions. Built to feel like a product, not a classroom exercise.

> **Recreational client-side game.** This is not real-money gambling and is not
> designed to provide authoritative or casino-grade randomness. The shuffle uses
> a client-side PRNG in your browser.

---

## Features

- Correct Blackjack rules — natural blackjack pays **3:2**, dealer stands on all 17s
- Hit, Stand, Double, **Split** and late **Surrender** on the live Arena table
  (Insurance exists only in the legacy single-player engine — see *Rules scope*)
- **Basic-strategy advisor** — reads the real S17 chart, switchable off
- A state machine that makes illegal actions impossible
- **Natural blackjack is distinct from an ordinary 21** — a three-card 21 pays 1:1
- Integer-cent accounting; the bankroll can never go negative
- **Your session survives a page refresh** — bankroll, statistics and preferences
- Session statistics with a clearly-labelled win rate (pushes excluded) and net insurance
- **Mastery layer** (`src/casino/mastery.ts`) — XP and levels, three daily quests, a
  forgiving day streak and Bronze→Platinum tiers per room. It pays **XP only, never
  chips**, and XP per round is flat, so bigger bets do not level you faster
- Keyboard playable: `H` hit · `S` stand · `D` double · `P` split · `R` surrender ·
  `Enter` deal
- Reduced-motion support (OS setting **and** an in-app toggle)
- Fully responsive from 320px up
- **Zero binary assets** — cards are DOM, sounds are synthesised with WebAudio

## The strategy advisor

While it is your turn, the table suggests the mathematically correct play —
`Hit on 16 against a 10`, `Double 8 against a 5`, and so on.

- It is **advisory only**. Every legal action stays available, and you are never
  blocked from making a worse play than the chart suggests.
- It uses only the dealer's **visible** card. It never peeks at the hole card.
- Switch it off from the header to practise unaided. That preference is saved.
- It follows the **S17** chart (dealer stands on all 17s), which is exactly what
  this table plays.

Two details in `strategy.ts` are easy to get wrong and are worth knowing:

1. **A hard 8 never doubles.** It is the *soft* 13-16 hands that double against a
   5 or 6. This trips up almost everyone who memorises the chart from memory.
2. **The two kinds of double fall back differently.** Most double spots are
   "double, else hit", but the soft 18 cells are "double if allowed, else
   stand". Once you have hit, doubling is off the table and the advisor has to
   choose correctly between the two. The table therefore stores
   `DOUBLE_ELSE_STAND` as a distinct cell rather than collapsing both into one.

## Game rules

| Rule | Value |
| --- | --- |
| Deck | 52 cards, reshuffled when the shoe runs low |
| Players / Dealer | 1 / 1 |
| Starting bankroll | $1,000.00 |
| Blackjack | Ace + 10/J/Q/K, exactly two cards |
| Blackjack payout | 3:2 |
| Ordinary win | 1:1 |
| Push | Original wager returned |
| Dealer | Stands on 17 (hard and soft) |
| Player | Hit / Stand / Double / Split / Surrender |
| Insurance | **Not in the Arena table.** Fully implemented in the legacy single-player engine (`src/game/machine.ts`), which is no longer routed — see *Rules scope* below |
| Split | Equal-rank pairs, up to 4 hands, no aces or tens |
| Double after split | Not offered |
| Surrender | **Late surrender**, on the live Arena table. Original two cards only, never after a split, never against a dealer ace or ten, and never on a natural. Returns half the wager |

Double is available only on the first two cards, always deals exactly one card,
and always ends your turn. You cannot double after a hit, and you cannot
double twice.

**Split rules**, in full, so nothing here is accidental:

| Rule | Value |
| --- | --- |
| Which pairs | Any two cards of the same rank |
| Aces | Never split |
| Tens (10/J/Q/K) | Never split |
| Maximum hands | 4 |
| Double after split | Not offered — applies to *both* hands |
| Re-splitting | A hand of two again-matches may be split again, up to the cap |

After a split, each hand carries its own wager, score and result. The round
counts as **one hand** in the session tally, and the bankroll line shows the
true exposure — the sum across every hand — rather than the base bet.

### Rules scope: which engine is live

There are two Blackjack engines in this repository, and only one of them is
routed from `App.tsx`:

| Engine | Routed? | Insurance | Used by |
| --- | --- | --- | --- |
| `src/arena/games/blackjack/table.ts` | **yes** | not implemented | the Arena table, the six AI opponents, all simulations |
| `src/game/machine.ts` | no | fully implemented | the legacy single-player components, still unit-tested |

So the insurance described in the historical notes below — half the wager,
2:1 on a dealer natural, offered on an ace — is **real and tested**, but it
belongs to the engine you can no longer reach from the app. The Arena table you
actually play does not offer it, and does not pretend to.

If insurance is added to the Arena table, the ordering subtlety is the thing to
get right: the dealer's hole card must not be checked when the hand is dealt.
Insurance is offered on a dealer ace first, and only then does the dealer peek.
Checking earlier would make the bet unable to ever pay — a real and easy bug to
ship. `autoAdvance` and `afterInsuranceDecision` in `machine.ts` document the
correct sequence and are the reference to copy.

Surrender is late only. The player gets one window, on the original two cards,
and returns half the wager — rounded up against the player, so a 1-chip
surrender is a total loss rather than a refund. The dealer does not draw when
every hand at the table has surrendered.

Two conditions are worth stating because they are money, not taste:

- **Never against a dealer ace or ten.** The hand may already be a blackjack the
  player has not been shown. Surrendering there would refund half a bet on a hand
  that had already won outright.
- **Never on a natural or a split hand.** A blackjack cannot be given back, and
  a split hand is mid-way through a wager the player has already committed to
  twice.

Bots never surrender. `BJ_ACTIONS` carries the action but `BOT_BJ_ACTIONS` does
not, so the policy cannot name it — no basic-strategy chart covers it, and it is
never correct play.

## Architecture

The one rule the codebase is built around: **the game engine never imports
React.**

```
src/
├── arena/         multiplayer Arena engine, AI bot personalities, simulations
├── casino/        casino games suite (Hold'em, Omaha, Roulette, Baccarat, Craps, etc.)
├── game/          pure TypeScript legacy blackjack engine & basic-strategy tables
│   ├── types.ts       Card, Hand, Phase, GameState, actions
│   ├── rules.ts       tunable rule constants
│   ├── rng.ts         seeded mulberry32 PRNG
│   ├── deck.ts        create, shuffle (Fisher-Yates), draw
│   ├── hand.ts        scoring, soft aces, natural-blackjack detection
│   ├── settle.ts      round resolution, dealer play, payouts, insurance
│   ├── machine.ts     phase machine, action guards, reducer
│   ├── strategy.ts    S17 basic-strategy tables and advice
│   └── money.ts       integer-cent helpers
├── party/         real-time party mode server & room state machines
├── components/    React presentation, felt UI, and party controls
├── store/         zustand store + choreography timers
├── lib/           formatting, WebAudio sound synthesizer, session storage
└── styles/        design tokens (Tailwind 4 `@theme`) and motion
```

Five consequences worth knowing:

1. **The engine is fully unit-tested in plain Node.** 263 engine tests, no DOM.
2. **The UI cannot corrupt game logic.** The reducer returns the *same state
   object* when an action is illegal, so rapid clicking, a double-dispatched
   event, or a stale component can never produce an invalid round.
3. **The same `canX()` guards drive both the UI and the engine.** A button can
   never offer an action the reducer would reject.
4. **The RNG is injectable at both layers.** The store accepts a seeded
   generator, so UI tests are deterministic instead of depending on the luck
   of the shuffle.
5. **Saved data is untrusted.** Every value read back from `localStorage` is
   sanitised, and a corrupt or hand-edited save degrades to "no save" rather
   than throwing or injecting a negative bankroll.

### State machine

```
IDLE → BETTING → DEALING → INSURANCE → PLAYER_TURN → DEALER_REVEAL
     → DEALER_TURN → RESOLVING → ROUND_COMPLETE → BETTING …
```

`INSURANCE` is only entered on a dealer ace, and only when the player has not
already made a natural.

The engine is a pure reducer with no timers. The store drives
`DEALER_REVEAL → DEALER_TURN → RESOLVING` on timers purely so the table can
animate.

## Multiplayer (Party mode)

Private, invite-code rooms for Texas Hold'em, roulette and blackjack (solo or two teams). Full
details are in [`docs/PARTY.md`](docs/PARTY.md); the short version:

```bash
npm run party:server   # the authoritative game server, on :8787
npm run dev            # the web app on :5173, proxied to the server
```

1. Open **Party** in two browser tabs (or two devices on the same network).
2. Tab 1: pick a game, enter a name, **Create party**. It shows a six-character invite code and a link.
3. Tab 2: enter the code and a name, **Join party**.
4. Everyone except the leader taps **Ready**; the leader taps **Start game**. Add bot seats in the
   table settings if you want more opponents than humans.

Party chips are separate virtual stacks and never touch your casino wallet.

## AI difficulty

On the buy-in screen for Hold'em, Omaha and blackjack you can pick the AI's strength: **Adaptive**
(starts easy, follows your skill), **Climb** (the bots get tougher the more rounds you have played
in that room, from level 55 up to 95), or a fixed Casual, Standard, Hard or Elite. Difficulty
changes how well the AI plays. It never changes the cards, dice or payouts.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run typecheck:arena` | Typecheck the arena subset |
| `npm run sim:learning` | Hold'em opponent-learning evidence: learning curves, bot behaviour with and without a read, integrity counters |

## Testing

```bash
npm test
```

The suite is over a thousand tests across the whole casino (blackjack, Hold'em,
the wallet and every room); Hold'em's engine invariants, its adaptive opponent
model and the reload-recovery of abandoned sessions are documented in
[`docs/HOLDEM.md`](docs/HOLDEM.md). The original blackjack coverage — the deck, hand evaluation, ace handling, natural-blackjack
detection, round resolution, payouts, insurance, session persistence, the
basic-strategy chart, and the state machine — including the edge cases:
`A+A+A`, `A+A+9`, `A+6+10`, doubled hands reaching 21, a zero bankroll, doubling
with an exact bankroll, repeated rapid hits, insurance the bankroll cannot
cover, and a corrupt saved session.

The strategy tests are written against the published S17 chart rather than
against the implementation, so a transcription error in the tables fails the
build instead of silently shipping.

The shuffle takes an injectable RNG, so every shuffle-dependent test is
deterministic and reproducible by seed — including the UI tests, which seed the
store rather than relying on the luck of the deal.

## Accessibility

- Full keyboard operation; shortcuts never replace an on-screen control
- Visible focus ring on every interactive element
- `role="status"` live region announces hands, scores, the insurance offer and results
- **Hands are described, not decorative.** Each hand is exposed as a labelled
  image reading e.g. *"Your hand: King of spades, 2 of hearts. Total 12."* The
  hole card is never named while it is face down.
- Disabled buttons stay visible with their label, so availability is never
  communicated by absence
- Respects `prefers-reduced-motion` and an independent in-app toggle
- Zoom is not blocked

## Tech

Vite 7 · React 19 · TypeScript 5.9 · Tailwind CSS 4 · zustand 5 · Vitest 5

## Roadmap (V2)

- [ ] Insurance in the live Arena table (with proper dealer-peek ordering)
- [ ] Configurable table rules (multi-deck shoes, dealer hits soft 17, double after split)
- [ ] Lazy loading for individual casino game tables
- [ ] CSPRNG default shuffle source via Web Crypto API

## Note on OneDrive

This project lives inside a OneDrive-synced folder. `node_modules/` and
`dist/` are gitignored, but the install itself is still slow. For the fastest
`npm install`, set this folder to "Always keep on this device", or copy the
project to a local disk for development.

## Licence

Recreational use only.
