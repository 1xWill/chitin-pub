import { NextResponse } from 'next/server';
import { z } from 'zod';
import { submitLinkByNonce, submitLinkByPostId } from '@/server/link';
import { getChitinConfig } from '@/server/config';
import { consumeRateLimit, getClientIp, hashRateLimitId } from '@/server/rate-limit';
import { claimIfAny } from '@/server/claim';

const BodySchema = z
  .object({
    postId: z.string().uuid().optional(),
    linkNonce: z.string().regex(/^0x[0-9a-fA-F]{8,128}$/).optional()
  })
  .refine((v) => v.postId || v.linkNonce, { message: 'Provide postId or linkNonce' });

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());

    const ip = getClientIp(req);
    const ipId = hashRateLimitId(ip);
    const rl = await consumeRateLimit({
      key: `rl:link_submit:ip:${ipId}`,
      windowSeconds: getChitinConfig().rateLimit.linkSubmitPerIp.windowSeconds,
      max: getChitinConfig().rateLimit.linkSubmitPerIp.max
    });

    if (!rl.ok) {
      const retryAfter = Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000));
      return NextResponse.json(
        { success: false, error: 'rate_limited', retryAfter, limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    const res = body.postId
      ? await submitLinkByPostId(body.postId)
      : await submitLinkByNonce(body.linkNonce as string);

    let claim: Awaited<ReturnType<typeof claimIfAny>> | null = null;
    try {
      claim = await claimIfAny({ agentId: res.agentId, recipientAddress: res.address });
    } catch {
      // Claim is best-effort. If the claimer is misconfigured or the chain is unavailable, linking still succeeds.
      claim = null;
    }

    return NextResponse.json({ success: true, agentId: res.agentId, address: res.address, claim });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
