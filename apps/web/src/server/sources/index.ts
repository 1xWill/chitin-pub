import { getChitinConfig } from '@/server/config';
import { moltbookSource } from '@/server/sources/moltbook';
import { moltxSource } from '@/server/sources/moltx';
import { ContextSourcePlugin, ResolveContextResult, SourceId } from '@/server/sources/types';

function allSources(): ContextSourcePlugin[] {
  return [moltbookSource, moltxSource];
}

function enabledIds(): SourceId[] {
  const cfg = getChitinConfig();
  const ids = cfg.sources?.enabled ?? ['moltbook'];
  return ids;
}

export function getEnabledSources(): ContextSourcePlugin[] {
  const enabled = new Set(enabledIds());
  return allSources().filter((s) => enabled.has(s.id));
}

export async function resolveRecipientFromContextUrl(contextUrl: string): Promise<ResolveContextResult> {
  let url: URL;
  try {
    url = new URL(contextUrl);
  } catch {
    return { ok: false, error: 'invalid_context_url' };
  }

  const src = getEnabledSources().find((s) => s.match(url));
  if (!src) return { ok: false, error: 'unsupported_context_source' };
  return await src.resolveRecipient(url);
}

