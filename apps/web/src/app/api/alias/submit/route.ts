import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getChitinConfig } from '@/server/config';
import { consumeRateLimit, getClientIp, hashRateLimitId } from '@/server/rate-limit';
import { submitMoltxAliasProof } from '@/server/alias';

const BodySchema = z
  .object({
    source: z.literal('moltx'),
    proofUrl: z.string().url()
  })
  .strict();

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());

    const cfg = getChitinConfig();
    const bucket = cfg.rateLimit.aliasSubmitPerIp ?? { windowSeconds: 86400, max: 10 };

    const ip = getClientIp(req);
    const ipId = hashRateLimitId(ip);
    const rl = await consumeRateLimit({
      key: `rl:alias_submit:ip:${ipId}`,
      windowSeconds: bucket.windowSeconds,
      max: bucket.max
    });

    if (!rl.ok) {
      const retryAfter = Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000));
      return NextResponse.json(
        { success: false, error: 'rate_limited', retryAfter, limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    if (body.source !== 'moltx') throw new Error('unsupported_source');

    const res = await submitMoltxAliasProof(body.proofUrl);
    return NextResponse.json({ success: true, data: res });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}

