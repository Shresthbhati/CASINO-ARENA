# Party Mode

Private, invite-code multiplayer for Casino Arena.

**Supported games, exactly:** Texas Hold'em, roulette and blackjack (individually or as two teams).
No other game has Party Mode support, and the UI offers no other.

Party chips are a separate virtual stack that exists only inside the party. They never touch the
casino wallet or ledger, and nothing is bought, sold or cashed out.

## Run it

```bash
npm run party:server   # authoritative server on :8787 (PORT, HOST, PARTY_FILE override)
npm run dev            # Vite on :5173, proxies /api/party to :8787
```

Open the **Party** tab in two browser tabs: create a party in one (choose the game), join with the
code (or the `?party=CODE` link) in the other.

## Architecture

```
React screens ──► PartyClient ──HTTP──► createPartyHttpServer ──► PartyServer ──┬─► HoldemTable (existing engine)
 (src/components/party)  (client.ts)        (http.ts)            (server.ts)    ├─► RouletteRoom (roulette.ts)
                                                                      │         └─► BlackjackRoom (blackjack.ts) ─► arena BlackjackTable
                                                         persist ──► FileStore (store.ts) ──► .party-state.json
```

| Layer | Role |
| --- | --- |
| `PartyServer` | Pure, transport-free authority: parties, members, commands, timers, chat, moderation, history records, per-recipient views. Time, randomness and id generation are injected, so tests are deterministic. |
| `http.ts` | Node built-in `http`, no dependency. `POST /api/party/{create,join,command}`, `GET /api/party/history`, and `GET /api/party/events`, a Server-Sent Events stream of full, versioned snapshots plus a 5 s heartbeat. |
| `PartyClient` | Streaming `fetch` reader. Applies a snapshot only if its `version` is newer; reconnects by itself; treats a silent stream as dead (a proxy can keep a browser's stream open after the server behind it dies). |
| `store.ts` | Crash-safe file storage (see below). |
| `history.ts` | Builds, verifies and renders the exportable history (see below). |
| React | Renders the view and sends commands. It never decides legality or payouts: the move buttons are exactly `you.blackjack.legalActions` / `you.turn.legalActions`. |

### Public versus private

Every payload is a `PartyView` with a public region and a private `you` region built per recipient.

- **Hold'em:** the public table has no live card; opponents' cards appear only as a `holdsCards` flag
  and become `shown` only for seats that reached showdown. `you` holds your own hole cards and, on
  your turn, the legal actions and raise bounds.
- **Roulette:** your layout is private until you lock it; others see only whether you have locked and
  how much you have down. The winning pocket is drawn at the moment of the spin, so it cannot be in
  any payload beforehand. After the spin every bet and result is public.
- **Blackjack:** every player card is face up to every player (that is the game). The dealer's hole
  card and the shoe are never in any payload: the dealer shows one card and `hidden: true` until the
  dealer plays. `you.blackjack` carries only your own legal moves, your bet and (in team play) whether
  you are the captain.

### Authority and ordering

- Identity is `(code, memberId, secret token)`; tokens are stored only as SHA-256 hashes and compared
  in constant time. The token travels in the `x-party-token` header, never in a URL.
- Every mutating command carries a client id; a repeat is applied once and answered `duplicate`. The id
  is saved *together with* the change it caused, so this holds across a crash and restart.
- `version` rises on every change; `gameVersion` only on game-state changes. `act` (Hold'em) and
  `play` (blackjack) quote the `gameVersion` they saw and a stale one is refused (`STALE`).
- Chat 5 messages per 2 s, reactions 3 per 1 s, reports 3 with one refilling a minute (token buckets).
  Text is sanitised, length-capped and rendered as text nodes, never HTML.

## Blackjack

One dealer, one shoe and the arena's multi-seat `BlackjackTable` as the authoritative engine, shared
by 1 to 6 players. No bots. Bets are made in multiples of 5 (chips of 5, 25, 100, 500…), 5 to 5,000 in
total. Hit, stand, double down, split and surrender are offered only when the engine lists them.
There is **no insurance** (the engine does not implement it). Round flow: everyone sets a bet and
**locks**; the table deals when every present player has locked or the betting clock ends with at
least one bet down; players act in seat order; the dealer plays; the round settles; the next round
opens after a short pause (or at once when the leader presses *Next round*).

### Individual play (teams off)

Each player has their own stack and sets their own bet. Nobody wins or loses as a group; the session
ends when the leader ends it or nobody has the minimum bet left. Final standings are the stacks.

### Team play ("Team Blackjack")

The leader assigns players to team A or B (lobby only; *Balance teams* alternates by join order); the
game will not start unless both teams have a player.

| Question | Rule |
| --- | --- |
| Pooled or individual money? | **One shared bank per team.** The bank is the sum of its members' chips and is re-split equally among them between rounds (odd chips go to the earliest seats). Nothing is ever transferred between the two teams; only the dealer moves chips in or out. |
| Who bets? | The **captain** sets one bet for the whole team, placed on every present teammate. The captain is the team's first *present* member, so a team whose first member drops or leaves is never stuck. Other members still **lock** to signal they are ready. |
| Who plays? | Every present teammate plays **their own hand** with their own decisions. Actions are never shared. A teammate who is away or sitting out neither bets nor plays that round. |
| Individual accounting | Each hand's `staked`, `returned` and `net` are kept per player (`netTotal`) whatever the bank does, and appear in results and history. |
| Team score | Bank = sum of its members' chips, including chips on the table. Shown with its net against the starting bank. |
| Dealer effect | Both teams face the same dealer hand, so a dealer bust or blackjack affects both equally; results are per hand against that dealer. |
| Win condition | First team to **double its starting bank** wins. If both do in the same round, the larger bank wins. If the **round limit** (3 to 100, default 20) is reached, the larger bank wins; equal banks draw. A team whose bank cannot cover the minimum bet for every member is out and the other team wins. |
| After the win | The session ends (`ENDED`), standings list every player with their team and chips. |
| Disconnected / sat-out / left | Not waited for in betting; on their turn a disconnected player is stood for after the short disconnect clock (8 s, or the action clock if shorter). A player who leaves is stood for; their chips stay in the team bank, frozen, and are never dealt in again. |
| Timeouts | If the action clock runs out the table **stands**; it never bets, hits or doubles for a player. |
| Teammate visibility | Same as everyone's: all player cards are face up, the hole card is hidden from all. Teammates see no private information. The only shared resources are the bank and the bet. |

Known quirks of the variant: a team of one is allowed (the other side may be larger, so starting banks
differ; the doubling target scales with each team's own starting bank). If the captain is offline and
no other teammate is present, that team simply sits the round out.

### Persistence of blackjack

The room is saved as an ordered **journal of engine operations** (`open`, `refill`, `bet`, `clear`,
`deal`, `act`) plus the recorded shuffle tape, a roster and a fingerprint (round, phase, balances,
bets, turn, dealer card count). Restore replays the journal against a fresh engine fed the same tape
and refuses anything that does not reproduce the fingerprint. Round records (for history) are saved
alongside. Proven by `party-blackjack-server`: mid-betting, mid-round, after settlement and after a
decided team match, plus tampered saves.

## Durability: a live session survives a restart

Design: **persist-before-notify with deterministic replay.**

1. Every change calls `persist` synchronously *before* subscribers are told, so nothing a player has
   seen can be newer than what is on disk.
2. **Hold'em** state is rebuilt, never copied. The server saves the seat plan, an ordered **journal**
   of every engine operation (`deal`, `act`, `away`) and the random streams (see `tape.ts`):
   - `deal`: the shuffle. A **tape** of every cryptographic draw. The deck stays cryptographically
     random: the tape records draws, it does not seed them.
   - `kseat:<i>`: each seat's own stream (bot decisions): a **256-bit key**, 8 words. The stream is
     HMAC-SHA256(key, counter), so the whole stream is rebuilt from the key. (Files saved before this
     change hold those seats as full `seat:<i>` tapes; they still restore, exactly as before.)
   Restore recreates the engine, feeds it the streams and replays the journal through the engine's own
   legality checks. The result must equal the saved **fingerprint**, must not need more randomness
   than was recorded, and must conserve every chip. Any mismatch rejects that party with a reason.
3. **Roulette** has no hidden state to replay, so its room is saved and validated directly.
4. **Blackjack** is replayed from its journal and tape (see above).
5. Identity survives as token hashes. No plaintext credential is ever written.
6. `FileStore` writes `<file>.tmp`, fsyncs, then renames over `<file>`. Every file starts with the
   SHA-256 of its JSON, so a torn or edited file is detected. The previous snapshot is kept as
   `<file>.bak` **only if it passes its own check**: a damaged main file is set aside as
   `<file>.corrupt-<time>` and the last good backup is left alone, so one bad write can never replace
   the backup with itself. Load prefers the main file, falls back to the backup, and sets anything
   unreadable aside rather than overwriting it. A failed write (blocked temp path, full disk) throws
   and leaves the previous file intact; the server reports it (`onPersistError`) and keeps running.
7. **One owner:** `FileStore.lock()` claims `<file>.lock` with the owner's pid. A second server on the
   same file refuses to start (`… is in use by process N`); a claim left by a dead process is taken over.
8. **Idempotent:** restoring a party already live in the server skips it, so repeating a restore
   cannot duplicate chips, actions or payouts. Unsupported `format`, a corrupt or wrong-length key or
   tape, a journal the engine refuses, an edited fingerprint, a malformed token hash, an impossible
   config or a roulette layout staked beyond its stack are each rejected explicitly.
9. After a restart the version counter moves forward, turn clocks start fresh (players are not
   charged for downtime), and everyone is "offline" until they reconnect with their saved credentials.
   A team's captain is "the first present member", so after a restart it is whoever reconnects first.

A finished session keeps only its standings and history: no deck, journal or tapes.

### Long sessions: what grows, what it costs

Measured on this machine through the real server, every command persisted, the real CSPRNG tape path,
Hold'em with 3 humans who check or fold:

| Session | File size | Serialize per save | Restore |
| --- | --- | --- | --- |
| Hold'em, 2 bots, 50 hands, **before** | 2.15 MB | 6.6 ms | 0.7 to 1.4 s |
| Hold'em, 2 bots, 50 hands, **after** | 0.11 MB | 0.4 ms | 1.8 to 3.3 s * |
| Hold'em, 2 bots, 200 hands, before / after | 3.2 MB / 0.20 to 0.35 MB | 11 ms / 0.9 to 1.1 ms | 1.8 s / 2.1 to 5.5 s * |
| Hold'em, 2 bots, 1000 hands, **before** | 8.6 MB | 27 ms | 4.0 s |
| Hold'em, no bots, 200 hands | 0.28 MB | 0.9 ms | **14 ms** |
| Blackjack, 4 players, 1000 rounds | 1.7 MB (1.7 kB per round) | 5 ms | **22 ms** |

\* Restore time with bots is run-to-run noisy (repeats of the same size took 2.1 s to 5.5 s) and is
**not improved by this work**: it is the bots' decision computation being replayed. Without bots the
same 200 hands restore in 14 ms, so bots are essentially all of it.

What was done and why:

- **Cause of the growth:** about 95% of a Hold'em file was bot streams recorded draw by draw (equity
  sampling draws tens of thousands of words per few hands). Their individual draws are not secrets, so
  each seat now saves a key instead: the file is roughly 10 to 20 times smaller and a save 10 to 20
  times cheaper to serialize. Dealing is unchanged and is still a raw recorded CSPRNG tape.
- **Not done: journal truncation / checkpoint compaction.** Dropping the journal prefix requires
  restoring the engine from a mid-session checkpoint. The Hold'em engine has no restore-from-state
  entry point, and each bot also carries learned state (`strategic`) that is itself rebuilt by
  replaying its decisions. A "checkpoint" that restarted the table from current stacks would change
  the button position, hand numbering, blind history and the bots' learned behaviour, and would
  discard the record from which a settlement can be investigated. The brief allows truncation only
  "if replay correctness and chip conservation are preserved"; this design cannot yet show that, so
  none is done. Blackjack and roulette are cheap enough that nothing is needed.
- **History is never trimmed**: the per-hand records (about 1 kB per Hold'em hand, every hand of the
  session) are exactly what a dispute needs.
- Every save still rewrites the whole file once. At 1000 rounds of blackjack that is 1.7 MB; for
  Hold'em about 1 MB per 1000 hands of history. Sessions of tens of thousands of hands would need an
  append-only log (see Known limitations).

## Seat lifecycle (disconnects, absences, departures)

| State | How it arises | What it means |
| --- | --- | --- |
| Connected | has a live stream | acts normally |
| Disconnected | stream dropped | keeps the seat, chips and any bet already made. On their turn the table checks if that is free, otherwise folds (Hold'em) or stands (blackjack), after a short wait (8 s, or the turn clock if shorter). |
| Reconnecting | credentials presented again | gets the same seat, same hole cards, same stack; the first snapshot resyncs everything. No second seat is ever created. |
| Sitting out | chosen by the player, or automatic after the table had to act for them in **two hands in a row** | dealt out from the **next** hand: no cards, no blinds, chips untouched. A chosen sit-out stays until they sit back in. An automatic one ends the moment they reconnect. |
| Waiting | too few players present to deal, chips on both sides | the table waits; it never ends the session over a dropped connection. |
| Eliminated | stack reaches zero | watches; the session ends when fewer than two seats can still play (Hold'em) or nobody can make the smallest bet (roulette, individual blackjack). |
| Left | voluntary leave, leader removal, or **10 minutes disconnected** | frozen: the stack stays exactly as it was, is counted in the final standings, and is never dealt in again. Credentials stop working. |

Rules that follow:

- A bet already committed stays committed. Disconnecting never refunds a pot contribution or lets a
  player escape a valid commitment, and an all-in seat stays all-in and is settled correctly.
- Blinds are never charged to a seat that is sitting out or has left. A seat that merely missed its
  turns is not charged either; no "missed blinds" debt is kept (this is a friendly game).
- A departed player's chips are never transferred to anyone. They simply stop playing.
- Ending a session mid-hand voids that hand: its committed chips go back to their owners, the table
  shows as finished, and the standings add up to the chips dealt.
- A **disconnected leader** does not freeze anything: the table runs on its clocks. After 30 s offline
  leadership passes to a connected member; the returning leader is an ordinary member.
- Roulette and blackjack: a disconnected or sitting-out player is not waited for in betting; bets
  already down are played. An empty table never deals or spins.

## Roulette

One shared European wheel, 1 to 6 players, individual play (no teams, no bots: the lobby does not
offer them and the server refuses them). Payouts reuse the casino floor's own zone parser and
settlement helpers, so a party spin cannot pay differently. Minimum bet 5, maximum 5,000 per spot.
Players place and lock bets; the wheel spins when every present player has locked, or when the
betting clock ends (unlocked bets on the layout are played; nothing is played if the layout is
empty). A stake leaves a stack only at the spin, so a round cut short costs nothing. What players
lost is exactly what the house won (`houseWon()` is derived, never stored).

## History export

Every game records its history on the server, from the same engine events that settle the game. The
export is built from those records, never from anything a client sent, and it never changes game
state, balances or the saved file (tested).

`GET /api/party/history?code=…&memberId=…` with the `x-party-token` header, plus:

| Parameter | Values |
| --- | --- |
| `scope` | `session` (default) or `hand` (needs `hand=<whole number>`; a round, for roulette and blackjack) |
| `visibility` | `public` (default) or `diagnostic` |
| `format` | `json` (default) or `text` (a readable rendering of the same document) |

- **Public** exports contain what every player could see: the board, actions in order, bet sizes, pot
  contributions, cards shown at showdown, payouts and balances. Folded and unshown hole cards are
  absent.
- **Diagnostic** exports add every seat's hole cards. They are available to **seated players of an
  ended session** only (a live game can never leak a hand through it).
- Never in any export: tokens or token hashes, the random tapes and keys, the shoe or deck order, the
  journal, the saved file.
- An interrupted session exports as it stands (`status: "live"`, a hand still being played marked
  `in_progress`, a hand voided by the session ending marked `voided`); a restart reconstructs the same
  records.
- Blackjack `staked` and `returned` are derived from the hands that were played (bets and payouts),
  not from the engine's running ledger, so a bet changed or cleared before the deal does not inflate
  them.

Document, versioned (`format: "casino-arena.party-history"`, `version: 1`); a real one, trimmed:

```jsonc
{
  "format": "casino-arena.party-history", "version": 1,
  "scope": "hand", "visibility": "public", "status": "live",      // status: live | ended
  "session": { "game": "blackjack", "startedAt": 1791633600000, "endedAt": null,
    "config": { "startingChips": 1000, "smallBlind": 10, "bigBlind": 20, "teams": "off", "botSeats": 0,
                "turnSeconds": 30 /* , "rounds": 20 for team blackjack */ },     // blinds apply to Hold'em only
    "players": [ { "seat": 0, "name": "Ada", "isBot": false, "team": null }, … ] },
  "hands": [],                      // Hold'em: number, blinds, start/end stacks, ordered actions with street,
                                    //   amounts and pot, board, showdown, pots/payouts, status
  "rounds": [],                     // roulette: pocket, colour, every bet and result
  "blackjackRounds": [ {
      "round": 1, "at": 1791633600000,
      "actions": [ { "seat": 0, "action": "STAND" }, { "seat": 1, "action": "STAND" } ],  // in order played
      "dealer": { "cards": ["2C","2H","8C","6S"], "total": 18, "bust": false, "blackjack": false },
      "players": [
        { "seat": 0, "hands": [ { "cards": ["JS","KC"], "total": 20, "bet": 50, "result": "PLAYER_WIN", "payout": 100 } ],
          "staked": 50, "returned": 100, "net": 50, "stackAfter": 1050 },
        { "seat": 1, "hands": [ { "cards": ["7D","2S"], "total": 9, "bet": 50, "result": "DEALER_WIN", "payout": 0 } ],
          "staked": 50, "returned": 0, "net": -50, "stackAfter": 950 } ] } ],
  "final": null,                    // when ended: standings and totalChips
  "integrity": { "ok": true, "checked": ["format and version","hands","rounds","blackjack rounds","final standings"], "problems": [] },
  "digest": "<sha256 of this document without `digest`>"      // detects accidental edits; not a signature
}
```

`integrity` is computed by `verifyHistory` against the server's own records: hand order, action
sequence numbers and street order, chips conserved start to end of every Hold'em hand, a voided hand
returning every chip, roulette totals, and for blackjack that each player's hand bets add up to
`staked`, their payouts to `returned`, and `net = returned − staked`. A document that fails is still
returned, with `ok: false` and the problems listed. The UI (a *History and export* panel at every
table) lists sessions and rounds, offers JSON and text downloads for a hand or the whole session, and
shows the integrity result.

## Moderation baseline

- **Report** a member with a reason (1 to 200 characters, control characters stripped). Validated,
  rate limited, one open report per reporter per target, stored as `{id, at, reporter, target, reason,
  status}` and kept across restarts. Names only: no addresses, tokens or hashes.
- **Visibility:** the leader sees open reports about *other* members and can dismiss or mark them
  handled. Reporters see their own reports and their status. Nobody else sees anything.
- **When the leader is the reported player:** the leader never sees or resolves those reports. When
  at least half of the other members (and never fewer than two) have reported them, leadership
  passes to the earliest-joined connected member and the reports are marked `escalated`.
- Leader tools: mute, remove, transfer leadership. Everyone: block (hides a member's chat from you
  alone). All are permission-checked on the server (`party-security` asserts that every leader
  command is refused to an ordinary member).
- Chat and names are text, never HTML: markup is stored verbatim and rendered as text nodes; names
  containing `<` or `>` are refused.

## Security

Assets: the **saved state and its tapes** (they determine every live player's cards), member **tokens**,
and the **hidden cards** themselves.

| Boundary | Control | Verified by |
| --- | --- | --- |
| Identity | 192-bit random secret per member, SHA-256 at rest, constant-time compare, header only | `party-security` (query-string tokens refused, another member's token refused) |
| Membership | every command, stream and export re-authenticates; a member who left is refused | `party-security` |
| Leader powers | leader-only checks in the server; none in the client | `party-security`, `party-moderation` |
| Hidden state | per-recipient views; hole card, shoe, tapes and journal exist in no payload, export or error | `party-security`, `party-blackjack-server` (the hole card is found by replay and shown to be absent until the dealer plays), `party-history` |
| Input | JSON only; body ≤ 16 kB (413, connection closed after the answer); amounts validated before any work (a 1e12 wager used to spin the server for ~1.5 s, now refused instantly); prototype-pollution shaped input inert; the download name is built only from validated integers | `party-security` |
| Abuse | per-address token buckets: 10 party creations/min and 30 join attempts/min (this also slows invite-code guessing); at most 5 event streams per member (the oldest is closed); at most 2000 live parties; chat/reaction/report buckets; request timeouts (headers 15 s, request 30 s) | `party-security`, `party-leaks` |
| Errors and logs | bare `{ok:false, code, message}`; a handler failure is a 500 with no detail, passed to `onError` (message only); logs never contain tokens, cards or state | `party-security`; review of `console.*` in `src/party` and `scripts/party-server.ts` |
| Saved state at rest | `0600` file and backup on POSIX; one-owner lock; denied by the Vite dev server (see below) | `party-store`, `party-hosting` |
| Shipped bundle | no server code, state or secret in `dist/` | fresh build searched for `KeyedRandom`, `TapeRandom`, `createHmac`, `node:fs`, `node:crypto`, `tokenHash`, `.party-state`, `PartyServer`, `FileStore`: none |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities | run once; not a substitute for a scanner |

Findings fixed in this review: (1) **the Vite dev server served `/.party-state.json` and its `.bak`
over HTTP** (confirmed with a real request; the file contains the recorded shuffles). `vite.config.ts`
now denies `**/.party-state.json*` and `**/.party-data/**`, and `party-hosting` starts the real dev
server and proves canary files with those names are refused (the test fails with the rule removed).
(2) The `.bak` copy did not get the `0600` mode and could overwrite the last good backup with a
damaged main file. (3) Unbounded creation of parties, join attempts and streams. (4) `chipsFor` looped
on an enormous wager. (5) The raw `hand` query value reached the download filename. (6) An oversized
body reset the connection instead of answering 413.

Not covered, said plainly:

- **Windows does not honour `0600`.** The state file inherits its folder's ACL; on this machine
  `icacls` showed an additional principal with read access. The server prints a warning at startup.
  Keep `PARTY_FILE` in a private folder. (No ACL was changed by this work.)
- **Cloud sync.** This repository lives under OneDrive, so the default `.party-state.json` is being
  uploaded. The server warns when the path looks cloud-synced; set `PARTY_FILE` to an unsynced folder.
- **No TLS, no accounts.** The server binds `127.0.0.1` by default; put it behind a TLS-terminating
  proxy on the same origin as the app. The per-address limiter uses the socket address, so behind a
  proxy every client shares one bucket unless the proxy passes the real address through.
- **Authenticated scanning was not run.** The configured scanner (HawkScan) needs `HAWK_API_KEY`,
  which is not set in this environment, so **no DAST scan was performed and none passed.** What was
  run is the local suite above, a secrets pattern search (no matches), `npm audit` and direct probes
  of the dev server.
- The party server serves no files; the production host serves `dist/` only.

## Verifying it

```bash
npx vitest run src/party src/components/party
npx tsc --noEmit && npx tsc -p tsconfig.arena.json && npx eslint .
npm run build
```

Test files: `party-server` (core protocol), `party-durable` (restart recovery, corrupt snapshots,
FileStore, restart over HTTP), `party-store` (failing saves, backup rules, modes, locks),
`party-tape` (keyed streams, restart with bots on the real tape, legacy files, repeated restarts),
`party-process-restart` (kills the real server process with SIGKILL and restarts it),
`party-lifecycle`, `party-roulette`, `party-history`, `party-blackjack-room` (the room alone),
`party-blackjack-server` (the full command lifecycle, individual and team, restart, history and two
real HTTP clients), `party-moderation`, `party-http` (two real clients), `party-security`,
`party-hosting`, `party-leaks`, and `components/party/__tests__/{party-ui,blackjack-ui}`. Browser
verification is manual: two tabs, widths 320/375/430/768/1280/1440, 2/4/6-seat tables.

## Known limitations

- Three games. Hold'em has no late join once started; blackjack has no insurance.
- One server process and one file (enforced by a lock); no shared store or horizontal scaling.
- Every save rewrites the whole file; recovery replays the whole journal. With Hold'em bots, restore
  costs roughly 10 to 60 ms per hand played (seconds for a long session); without bots, or in
  blackjack, it is milliseconds. A true fix needs an engine checkpoint/restore API plus an append-only
  log; it is the next persistence task.
- Saved state holds the deck for live sessions: protect it like a secret (see Security).
- No account system: a member is a browser session's credentials; clearing session storage forfeits
  the seat after the 10-minute absence rule.
- Moderation is per party; there is no platform-level queue, appeal flow or persistent bans.
- Team blackjack: a team of one can face a team of several; the doubling target scales per team.
- Voice chat is not implemented. Plan: WebRTC peer-to-peer audio with the party server as signalling
  (offer, answer and ICE commands relayed only between members of the same party); the existing mute
  and block lists stay authoritative, push-to-talk by default, no recording, explicit microphone
  permission; add a TURN service or an SFU beyond six participants.

## Next priority

An engine checkpoint/restore API for Hold'em (with bots' learned state) so the journal can be compacted
safely and restarts are instant, then an append-only log in place of whole-file rewrites.
