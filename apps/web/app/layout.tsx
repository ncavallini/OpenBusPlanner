import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenBus Planner — multi-operator bus journeys across Europe',
  description: 'Find long-distance bus connections across independent operators, with honest data coverage.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#187049' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-surface focus:p-2">
          Skip to content
        </a>
        <header className="border-b border-line bg-surface">
          <nav className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3" aria-label="Main">
            <Link href="/" className="flex items-center gap-2 font-semibold text-brand-700">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-sm text-white">
                OB
              </span>
              OpenBus Planner
            </Link>
            <Link href="/sources" className="text-sm text-muted hover:text-ink">
              Data sources
            </Link>
            <Link href="/operators" className="text-sm text-muted hover:text-ink">
              Operators
            </Link>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="mx-auto max-w-7xl px-4 py-8 text-xs text-muted">
          OpenBus Planner is a discovery and referral tool: it does not sell tickets. Timetables come from the sources listed on the{' '}
          <Link className="underline" href="/sources">
            data sources
          </Link>{' '}
          page, under their respective licences. Map data © OpenStreetMap contributors. ·{' '}
          <Link className="underline" href="/privacy">
            Privacy
          </Link>
        </footer>
      </body>
    </html>
  );
}
