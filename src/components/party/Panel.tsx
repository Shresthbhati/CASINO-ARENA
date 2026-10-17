/**
 * CASINO ARENA - a side panel that folds away on a phone.
 *
 * On a laptop the table's side panels (feed, members, chat) are always open beside the table. On a
 * phone, three open panels stack into a long scroll beneath the cards, so each becomes a disclosure:
 * one 44 px summary row that opens in place. The content is identical either way; only its presentation
 * changes, and with no `matchMedia` (tests) the laptop presentation is used.
 */
import React from 'react';
import { DESKTOP_QUERY, useMediaQuery } from '@/lib/useMediaQuery';

export const Panel: React.FC<{
  title: string;
  /** The accessible name of the region, when it should differ from the visible title. */
  label?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, label, defaultOpen = false, children }) => {
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  if (desktop) {
    return (
      <section aria-label={label ?? title}>
        <h3 className="mb-1 text-sm font-medium text-muted">{title}</h3>
        {children}
      </section>
    );
  }
  return (
    <details open={defaultOpen} className="border border-white/10 bg-black/20">
      <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-cream">{title}</summary>
      <div className="px-3 pb-3" role="region" aria-label={label ?? title}>
        {children}
      </div>
    </details>
  );
};
