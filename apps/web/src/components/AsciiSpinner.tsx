'use client';

import { useEffect, useState } from 'react';

const FRAMES = ['|', '/', '-', '\\'] as const;

export function AsciiSpinner({ label = 'loading' }: { label?: string }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex items-center gap-2 font-mono text-sm text-zinc-400">
      <span aria-hidden className="inline-block w-3 text-zinc-500">
        {FRAMES[i]}
      </span>
      <span>{label}</span>
    </div>
  );
}

