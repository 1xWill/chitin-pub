import { NextResponse } from 'next/server';
import { getChitinConfig, getPublicOrigin } from '@/server/config';

export function GET(req: Request) {
  try {
    const cfg = getChitinConfig();

    if (!cfg.chain.contractAddress) {
      throw new Error('Missing chain.contractAddress in chitin.config.json');
    }

    return NextResponse.json({
      success: true,
      data: {
        chainId: cfg.chain.chainId,
        rpcUrl: cfg.chain.publicRpcUrl,
        contractAddress: cfg.chain.contractAddress,
        apiBase: getPublicOrigin(req),
        sources: cfg.sources?.enabled ?? ['moltbook'],
        moltbook: {
          apiBase: cfg.moltbook.apiBase,
          linkSubmolt: cfg.moltbook.linkSubmolt
        },
        moltx: cfg.moltx ? { apiBase: cfg.moltx.apiBase } : null,
        rateLimit: cfg.rateLimit,
        ui: {
          pollIntervalSeconds: cfg.ui?.pollIntervalSeconds ?? 15
        }
      }
    }, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
