'use client';

import { useMemo, useState } from 'react';

function shortAddr(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 10) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

export function ContractAddressCopy({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  const display = useMemo(() => shortAddr(address), [address]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore; clipboard may be blocked.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="text-zinc-200 no-underline hover:underline underline-offset-4 hover:text-accent cursor-pointer"
      aria-label="Copy contract address"
      title={copied ? 'copied' : 'Click to copy'}
    >
      {copied ? `CA: ${display} copied` : `CA: ${display}`}
    </button>
  );
}
