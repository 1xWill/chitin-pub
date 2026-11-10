import { NextResponse } from 'next/server';
import { z } from 'zod';
import { dbQuery } from '@/server/db';
import { getChitinConfig } from '@/server/config';
import { consumeRateLimit, getClientIp, hashRateLimitId } from '@/server/rate-limit';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';
import { reconcileOnSubmitBestEffort } from '@/server/reconcile-on-submit';

const BodySchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  burnTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  context: z.string().min(1).max(1024).optional()
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());

    const ip = getClientIp(req);
    const ipId = hashRateLimitId(ip);
    const rl = await consumeRateLimit({
      key: `rl:transfer_submit:ip:${ipId}`,
      windowSeconds: getChitinConfig().rateLimit.transferSubmitPerIp.windowSeconds,
      max: getChitinConfig().rateLimit.transferSubmitPerIp.max
    });

    if (!rl.ok) {
      const retryAfter = Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000));
      return NextResponse.json(
        { success: false, error: 'rate_limited', retryAfter, limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    // Prevent DB spam with random tx hashes: only accept real transactions that directly call the CHITIN token
    // contract's `transfer(...)` function (selector 0xa9059cbb).
    const provider = getBaseProvider();
    const tx = await provider.getTransaction(body.txHash);
    if (!tx) {
      throw new Error('tx_not_found');
    }
    const to = (tx.to ?? '').toLowerCase();
    if (!to || to !== getChitinContractAddress().toLowerCase()) {
      throw new Error('not_chitin_transfer_tx');
    }
    if (!tx.data || String(tx.data).slice(0, 10).toLowerCase() !== '0xa9059cbb') {
      throw new Error('not_erc20_transfer_call');
    }

    // Optional PAY burn tx: must call CHITIN burn(uint256) on the token contract.
    if (body.burnTxHash) {
      const burnTx = await provider.getTransaction(body.burnTxHash);
      if (!burnTx) throw new Error('burn_tx_not_found');
      const burnTo = (burnTx.to ?? '').toLowerCase();
      if (!burnTo || burnTo !== getChitinContractAddress().toLowerCase()) {
        throw new Error('not_chitin_burn_tx');
      }

      const burnSelector = '0x42966c68'; // burn(uint256)
      if (!burnTx.data || String(burnTx.data).slice(0, 10).toLowerCase() !== burnSelector) {
        throw new Error('not_burn_call');
      }

      // Must be from the same sender as the transfer (payer).
      if (String(burnTx.from).toLowerCase() !== String(tx.from).toLowerCase()) {
        throw new Error('burn_sender_mismatch');
      }
    }

    await dbQuery(
      `
      INSERT INTO activities (kind, status, tx_hash, burn_tx_hash, context)
      VALUES ('pay', 'pending', $1, $2, $3)
      ON CONFLICT (tx_hash) DO NOTHING
      `,
      [body.txHash, body.burnTxHash ?? null, body.context ?? null]
    );

    // Best-effort (throttled) reconcile so the UI updates quickly without amplifying RPC cost during bursts.
    await reconcileOnSubmitBestEffort();

    const rows = await dbQuery<{ status: string }>(
      `SELECT status FROM activities WHERE tx_hash=$1 LIMIT 1`,
      [body.txHash]
    );

    return NextResponse.json({ success: true, status: rows[0]?.status ?? 'pending' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
