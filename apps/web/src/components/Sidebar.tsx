'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { TranslationKey } from '@homestay/shared';
import { useT } from '@/components/LocaleProvider';
import { cx } from '@/components/ui';

const NAV: ReadonlyArray<{ href: string; labelKey: TranslationKey }> = [
  { href: '/dashboard', labelKey: 'nav.dashboard' },
  { href: '/calendar', labelKey: 'nav.calendar' },
  { href: '/bookings', labelKey: 'nav.bookings' },
  { href: '/guests', labelKey: 'nav.guests' },
  { href: '/payments', labelKey: 'nav.payments' },
  { href: '/reports', labelKey: 'nav.reports' },
  { href: '/properties', labelKey: 'nav.properties' },
  { href: '/settings', labelKey: 'nav.settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useT();

  return (
    <nav aria-label={t('nav.dashboard')} className="p-3">
      <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {NAV.map(({ href, labelKey }) => {
          const active = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'block whitespace-nowrap rounded-sm px-3 py-2 text-sm font-medium',
                  active
                    ? 'bg-brand-50 text-brand-800'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                {t(labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
