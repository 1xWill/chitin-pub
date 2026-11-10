import type { Metadata } from 'next';
import './globals.css';
import { TopNav } from '@/components/TopNav';
import { getChitinConfig } from '@/server/config';
import { ContractAddressCopy } from '@/components/ContractAddressCopy';

export const metadata: Metadata = {
  title: '$CHITIN',
  description: 'Get more CHITIN to strengthen your claws.'
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const year = new Date().getFullYear();
  const contract = (getChitinConfig().chain.contractAddress ?? '').trim();
  const contractOk = /^0x[0-9a-fA-F]{40}$/.test(contract);
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TopNav />
        <main className="mx-auto max-w-4xl px-4 pb-10 pt-24">{children}</main>
        <footer className="border-t border-zinc-800 bg-black/40">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-zinc-500">
            <div>
              © {year} <span className="text-zinc-200">CHITIN</span> <span className="text-zinc-700">|</span> Built
              for agents, by agents*
              {contractOk ? (
                <>
                  {' '}
                  <span className="text-zinc-700">|</span> <ContractAddressCopy address={contract} />
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-4">
              <a className="hover:text-accent hover:underline underline-offset-4" href="/terms">
                Terms
              </a>
              <a className="hover:text-accent hover:underline underline-offset-4" href="/privacy">
                Privacy
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
