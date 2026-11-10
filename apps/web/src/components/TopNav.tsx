'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'home' },
  { href: '/activities', label: 'activities' },
  { href: '/leaderboard', label: 'leaderboard' }
];

function cx(parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function TopNav() {
  const pathname = usePathname();

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-zinc-800 bg-black/80">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 font-bold tracking-wide text-zinc-100 hover:text-accent"
        >
          <span className="text-xs font-normal leading-none text-zinc-300">{'//'}</span>
          CHITIN.MONEY
        </Link>
        <nav className="flex flex-wrap items-center gap-2 text-sm">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cx([
                  'rounded px-2 py-1',
                  active ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-400 hover:text-accent'
                ])}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
