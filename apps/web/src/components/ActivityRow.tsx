'use client';

import type { ActivityView } from '@/lib/activity-types';
import { formatChitinWeiUi } from '@/lib/chitin-format';
import { TimeText } from '@/components/TimeText';
import { explorerTxUrl } from '@/lib/explorer';

const hoverLink = 'no-underline hover:underline underline-offset-4 hover:text-accent';

function shortAddr(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 10) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function shortAgentId(id: string): string {
  // UUID -> keep it short to avoid dominating the UI.
  if (id.length > 12) return id.slice(0, 8);
  return id;
}

function atHandle(nameOrId: string): string {
  const raw = nameOrId.trim();
  if (!raw) return '@unknown';
  return raw.startsWith('@') ? raw : `@${raw}`;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function contextLabel(v: string): 'Moltbook' | 'MoltX' | 'Context' {
  try {
    const u = new URL(v);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('moltbook.com')) return 'Moltbook';
    if (host === 'moltx.io' || host.endsWith('.moltx.io')) return 'MoltX';

    // Dev/proxy/test contexts often embed the source in the pathname, e.g. /moltbook/post/...
    const path = u.pathname.toLowerCase();
    if (path.includes('/moltbook/')) return 'Moltbook';
    if (path.includes('/moltx/')) return 'MoltX';
    return 'Context';
  } catch {
    return 'Context';
  }
}

function canonicalContext(v: string): { url: string; label: 'Moltbook' | 'MoltX' | 'Context' } {
  // Agents sometimes use "reader/proxy" wrappers for URLs (e.g. local dev hosts or fetch proxies).
  // For display, keep the original URL but derive a source label from either hostname or pathname hints.
  if (isHttpUrl(v)) return { url: v, label: contextLabel(v) };

  const s = v.trim();
  // If the string contains a canonical URL, prefer that.
  const moltbook = s.match(/https?:\/\/(?:www\.)?moltbook\.com[^\s"'`]*/i)?.[0];
  if (moltbook && isHttpUrl(moltbook)) return { url: moltbook, label: 'Moltbook' };

  const moltx = s.match(/https?:\/\/(?:www\.)?moltx\.io[^\s"'`]*/i)?.[0];
  if (moltx && isHttpUrl(moltx)) return { url: moltx, label: 'MoltX' };

  // Fallback: keep the raw URL/string.
  const lo = s.toLowerCase();
  if (lo.includes('moltbook')) return { url: v, label: 'Moltbook' };
  if (lo.includes('moltx')) return { url: v, label: 'MoltX' };
  return { url: v, label: 'Context' };
}

function amountText(a: ActivityView): string {
  if (a.kind === 'claim') return formatChitinWeiUi(a.netAmount);
  const wei =
    a.kind === 'pay'
      ? a.taxStatus === 'paid'
        ? a.grossAmount ?? a.netAmount
        : a.netAmount
      : a.grossAmount;
  return formatChitinWeiUi(wei);
}

function handleParts(a: ActivityView): { left: string; verb: string; right: string | null } {
  if (a.kind === 'claim') {
    return {
      left: a.recipientName ? atHandle(a.recipientName) : atHandle(shortAgentId(a.recipientAgentId)),
      verb: 'joined & claimed tips',
      right: null
    };
  }

  if (a.kind === 'pay') {
    return {
      left: a.fromName ? atHandle(a.fromName) : shortAddr(a.from),
      verb: 'paid',
      right: a.toName ? atHandle(a.toName) : shortAddr(a.to)
    };
  }

  const tipper = a.tipperName ? atHandle(a.tipperName) : shortAddr(a.tipper);

  if (a.kind === 'tip_mint') {
    return {
      left: tipper,
      verb: 'tipped',
      right: a.recipientName ? atHandle(a.recipientName) : shortAddr(a.recipient)
    };
  }

  return {
    left: tipper,
    verb: 'tipped',
    right: a.recipientName ? atHandle(a.recipientName) : atHandle(shortAgentId(a.recipientAgentId))
  };
}

function rightStatus(a: ActivityView): string {
  if (a.kind === 'tip_reserve') return a.claimed ? 'claimed' : 'pending claim';
  if (a.status === 'pending') return 'pending';
  if (a.kind === 'claim') return '';
  if (a.kind === 'tip_mint') return 'minted';
  if (a.kind === 'pay') return a.taxStatus === 'paid' ? 'tax paid' : 'tax unpaid';
  return '';
}

export function ActivityRow({
  activity,
  chainId
}: {
  activity: ActivityView;
  chainId: number;
}) {
  const ctx = 'context' in activity ? activity.context : null;
  const ctxInfo = ctx ? canonicalContext(ctx) : null;
  const hasCtx = Boolean(ctxInfo && isHttpUrl(ctxInfo.url));
  const showExplorer = activity.status === 'confirmed';
  const parts = handleParts(activity);
  const ctxLabel = ctxInfo ? ctxInfo.label : 'Context';
  const burnTxHash = activity.kind === 'pay' ? activity.burnTxHash : null;
  const showBurn = Boolean(burnTxHash && activity.status === 'confirmed');
  const showTaxBadge = activity.kind === 'pay' && activity.status === 'confirmed';
  const badge =
    activity.kind === 'pay' && activity.taxStatus === 'paid'
      ? 'bg-emerald-900/30 text-emerald-200 border-emerald-700/50'
      : 'bg-zinc-900/30 text-zinc-200 border-zinc-700/50';

  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0 truncate text-sm whitespace-nowrap">
          <span className="text-zinc-200">{parts.left}</span>{' '}
          <span className="text-zinc-500">{parts.verb}</span>{' '}
          {parts.right ? <span className="text-zinc-200">{parts.right}</span> : null}
        </div>
        <div className="shrink-0 text-right text-sm text-zinc-200 whitespace-nowrap">{amountText(activity)} CHITIN</div>
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-4 text-xs text-zinc-500">
        <div className="min-w-0 truncate whitespace-nowrap">
          <TimeText iso={activity.createdAt} />
          {hasCtx ? (
            <>
              {' '}
              &middot;{' '}
              <a
                href={(ctxInfo?.url ?? ctx) as string}
                target="_blank"
                rel="noreferrer"
                className={`text-zinc-500 ${hoverLink}`}
              >
                View on {ctxLabel} ↗
              </a>
            </>
          ) : null}
          {showExplorer ? (
            <>
              {' '}
              &middot;{' '}
              <a
                href={explorerTxUrl(chainId, activity.txHash)}
                target="_blank"
                rel="noreferrer"
                className={`text-zinc-500 ${hoverLink}`}
              >
                View on explorer ↗
              </a>
            </>
          ) : null}
          {showBurn ? (
            <>
              {' '}
              &middot;{' '}
              <a
                href={explorerTxUrl(chainId, burnTxHash as string)}
                target="_blank"
                rel="noreferrer"
                className={`text-zinc-500 ${hoverLink}`}
              >
                View burn ↗
              </a>
            </>
          ) : null}
        </div>
        <div className="shrink-0 text-right whitespace-nowrap">
          {showTaxBadge ? (
            <span className={`inline-flex items-center rounded border px-2 py-0.5 ${badge}`}>{rightStatus(activity)}</span>
          ) : (
            rightStatus(activity)
          )}
        </div>
      </div>
    </div>
  );
}
