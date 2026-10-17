export { formatCents, formatSignedCents, toCents, toDollars } from '@/game/money';

/** Percentage string for the win-rate stat, or an em dash when undefined. */
export function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

/** Compact count used in the stats bar. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
