'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { TranslationKey } from '@homestay/shared';
import { useT } from '@/components/LocaleProvider';
import { cx } from '@/components/ui';

type IconName =
  'home' | 'calendar' | 'booking' | 'guest' | 'payment' | 'report' | 'property' | 'settings';

const NAV: ReadonlyArray<{ href: string; labelKey: TranslationKey; icon: IconName }> = [
  { href: '/dashboard', labelKey: 'nav.dashboard', icon: 'home' },
  { href: '/calendar', labelKey: 'nav.calendar', icon: 'calendar' },
  { href: '/bookings', labelKey: 'nav.bookings', icon: 'booking' },
  { href: '/guests', labelKey: 'nav.guests', icon: 'guest' },
  { href: '/payments', labelKey: 'nav.payments', icon: 'payment' },
  { href: '/reports', labelKey: 'nav.reports', icon: 'report' },
  { href: '/properties', labelKey: 'nav.properties', icon: 'property' },
  { href: '/settings', labelKey: 'nav.settings', icon: 'settings' },
];

const ICON_PATHS: Record<IconName, string> = {
  home: 'M3.5 10.5 12 3l8.5 7.5V21h-6v-6h-5v6h-6V10.5Z',
  calendar: 'M5 4.5h14a2 2 0 0 1 2 2V20H3V6.5a2 2 0 0 1 2-2Zm2-2v4m10-4v4M3 9h18',
  booking: 'M6 3.5h12V21l-6-3-6 3V3.5Zm3 5h6m-6 4h6',
  guest:
    'M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 18.5V20m6-10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-1a3 3 0 0 1 3 3v1',
  payment: 'M3 6.5h18v12H3v-12Zm0 4h18m-5 4h2',
  report: 'M5 20V10m7 10V4m7 16v-7',
  property: 'M4 21V8l8-5 8 5v13H4Zm5 0v-6h6v6M8 10h1m6 0h1',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5 1.5 1-2 3.5-1.7-.7a8 8 0 0 1-1.8 1l-.2 1.9h-4l-.2-1.9a8 8 0 0 1-1.8-1l-1.7.7-2-3.5 1.5-1a8 8 0 0 1 0-2l-1.5-1 2-3.5 1.7.7a8 8 0 0 1 1.8-1l.2-1.9h4l.2 1.9a8 8 0 0 1 1.8 1l1.7-.7 2 3.5-1.5 1a8 8 0 0 1 0 2Z',
};

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useT();

  return (
    <nav aria-label={t('nav.dashboard')} className="px-3 pb-3 md:px-4 md:py-5">
      <ul className="flex gap-1.5 overflow-x-auto md:flex-col md:overflow-visible">
        {NAV.map(({ href, labelKey, icon }) => {
          const active =
            pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition duration-200',
                  active
                    ? 'bg-brand-800 text-white shadow-sm shadow-brand-900/20'
                    : 'text-slate-600 hover:bg-brand-50 hover:text-brand-900',
                )}
              >
                <NavIcon name={icon} />
                {t(labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
