/**
 * CASINO ARENA — the shared blackjack action vocabulary.
 *
 * Lives in its own module because the action type is needed by four modules
 * that must not import each other: the policy that chooses an action, the
 * memory that records one, the engine that validates one, and the event
 * payload that publishes one. Keeping it here breaks what would otherwise be
 * a circular import between the AI and the game engine.
 */

export const BJ_ACTIONS = ['HIT', 'STAND', 'DOUBLE', 'SPLIT', 'SURRENDER'] as const;

/**
 * Actions a bot may choose.
 *
 * A strict subset of `BJ_ACTIONS`, and the separation is deliberate: no
 * basic-strategy chart covers surrender, and it is never correct play against a
 * dealer who has not shown a blackjack. Keeping it out of the bot list means the
 * policy cannot even *name* the action, so a bot can never surrender by accident
 * through a scoring path that happened to see it in `legalActions`.
 */
export const BOT_BJ_ACTIONS = ['HIT', 'STAND', 'DOUBLE', 'SPLIT'] as const;

export type BjAction = (typeof BJ_ACTIONS)[number];

/** True when `value` names a legal blackjack action. */
export function isBjAction(value: string): value is BjAction {
  return (BJ_ACTIONS as readonly string[]).includes(value);
}

/** True when `value` names an action a bot is permitted to take. */
export function isBotAction(value: string): value is BjAction {
  return (BOT_BJ_ACTIONS as readonly string[]).includes(value);
}
