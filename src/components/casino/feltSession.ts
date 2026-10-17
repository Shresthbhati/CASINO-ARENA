/**
 * CASINO ARENA — the felt-facing session contract.
 *
 * Every table component used to declare `session: any`. That is not a small
 * inconvenience: `any` silences the compiler at exactly the boundary where the
 * frontend meets the authoritative engine — the boundary this whole architecture
 * exists to keep honest. It also meant a component could ask the session for a
 * method the engine does not have, and nothing would complain.
 *
 * This interface states the actual minimum a felt needs, and nothing more:
 *
 *     view()            the engine's own read model, cast per room
 *     currentWagers()   chips currently on the felt, per zone
 *     currentStake()    their total
 *     legalActions()    what the engine will accept right now
 *     gameId            which room this is
 *     canEnd()          whether the table is safe to close
 *
 * `canEnd()` is here because the cash-out control is a felt decision: it must be
 * disabled for the same reason the session would refuse, and the two must never
 * disagree. A felt that asked only `handInProgress()` would happily enable cash
 * out on a craps table still holding a riding contract.
 *
 * A `TableSession<TView>` satisfies this structurally for every `TView`, so the
 * call site needs no cast, and the felt still cannot invent state it was not
 * given.
 */
import type { GameId } from '@/types/arena';
import type { ExposureReport, PlacedWager } from '@/casino/engine';

export interface FeltSession {
  readonly gameId: GameId;
  /** The engine's read model. Narrowed to the room's own view type on use. */
  view(): unknown;
  currentWagers(): readonly PlacedWager[];
  currentStake(): number;
  legalActions(): readonly string[];
  /** False while the engine owns any chip that has not been settled. */
  canEnd(): boolean;
  /** The breakdown behind `canEnd()`, for the reason a felt shows. */
  exposure(): ExposureReport;
}