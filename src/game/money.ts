/**
 * Money helpers.
 *
 * Every monetary value in the engine is an integer number of cents. Floating
 * point dollars are never used, so `0.1 + 0.2` problems cannot occur and
 * assertions in tests are exact.
 */

/** $25.00 -> 2500 */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** 2500 -> 25 */
export function toDollars(cents: number): number {
  return cents / 100;
}

const USD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format cents as "$1,234.50" (no sign for positive values). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${USD.format(Math.abs(cents) / 100)}`;
}

/** Format cents with an explicit leading "+" for gains, used by the result panel. */
export function formatSignedCents(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/** Clamp a bankroll to a legal value; guards against a corrupted state leaking negative money. */
export function clampBankroll(cents: number): number {
  return Math.max(0, Math.trunc(cents));
}
