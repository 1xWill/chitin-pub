'use client';

import { useState } from 'react';

export function CopyBlock({ text, language = 'text' }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    } catch {
      // Ignore; clipboard may be blocked.
    }
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">
        <span className="font-mono">{language}</span>
        <button
          type="button"
          onClick={onCopy}
          className="rounded px-2 py-1 text-zinc-400 hover:text-accent"
          aria-label="Copy"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="p-3 text-sm text-zinc-200 whitespace-pre-wrap break-words">
        <code>{text}</code>
      </pre>
    </div>
  );
}
