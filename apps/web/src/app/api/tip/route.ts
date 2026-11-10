import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ethers } from 'ethers';
import { dbQuery } from '@/server/db';
import { getBaseProvider, getChitinContractAddress, getRelayerSigner } from '@/server/chain';
import { chitinInterface, TIP_TYPES } from '@/server/chitin-abi';
import { resolveByAddress } from '@/server/link';
import { getChitinConfig } from '@/server/config';
import { consumeRateLimit, getClientIp, hashRateLimitId } from '@/server/rate-limit';
import { fetchProfileByName } from '@/server/moltbook';
import { reconcileOnSubmitBestEffort } from '@/server/reconcile-on-submit';
import { resolveRecipientFromContextUrl } from '@/server/sources';
import { acquireLock } from '@/server/locks';

const BodySchema = z
  .object({
    tipper: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    recipientName: z.string().min(1).max(64).optional(),
    recipientContextUrl: z.string().url().optional(),
    recipientAgentId: z.string().uuid().optional(),
    recipientIdHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    // uint256 max is 78 digits; cap input size to prevent BigInt OOM/DoS.
    grossAmount: z.string().regex(/^\d+$/).max(78),
    nonce: z.string().regex(/^\d+$/).max(78),
    deadline: z.string().regex(/^\d+$/).max(78),
    context: z.string().min(1).max(1024),
    contextHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    signature: z.string().min(132).max(400).regex(/^0x[0-9a-fA-F]+$/)
  })
  .strict()
  .refine((v) => Boolean(v.recipientName || v.recipientContextUrl || v.recipientAgentId), {
    message: 'missing_recipient'
  });

function agentIdHashFromAgentId(agentId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(agentId));
}

const MAX_UINT256 = BigInt(
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
);

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());

    if (body.grossAmount === '0') {
      throw new Error('gross_amount_must_be_positive');
    }

    const ip = getClientIp(req);
    const ipId = hashRateLimitId(ip);
    const rl = await consumeRateLimit({
      key: `rl:tip:ip:${ipId}`,
      windowSeconds: getChitinConfig().rateLimit.tipPerIp.windowSeconds,
      max: getChitinConfig().rateLimit.tipPerIp.max
    });

    if (!rl.ok) {
      const retryAfter = Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000));
      return NextResponse.json(
        { success: false, error: 'rate_limited', retryAfter, limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }

    // Require tipper to be linked (prevents relayer spam from random wallets).
    const tipperLink = await resolveByAddress(body.tipper);
    if (!tipperLink) throw new Error('tipper_not_linked');

    // Optional per-agent submission rate limit (separate from per-day mint caps enforced onchain).
    const perAgent = getChitinConfig().rateLimit.tipPerAgent;
    if (perAgent) {
      const rlAgent = await consumeRateLimit({
        key: `rl:tip:agent:${tipperLink.agentId}`,
        windowSeconds: perAgent.windowSeconds,
        max: perAgent.max
      });
      if (!rlAgent.ok) {
        const retryAfter = Math.max(0, rlAgent.resetAt - Math.floor(Date.now() / 1000));
        return NextResponse.json(
          { success: false, error: 'rate_limited', retryAfter, limit: rlAgent.limit },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }
    }

    // Resolve recipient identity (canonical Moltbook agent id).
    let recipientAgentId: string;
    let recipientName: string | null = null;
    if (body.recipientContextUrl) {
      const rr = await resolveRecipientFromContextUrl(body.recipientContextUrl);
      if (!rr.ok) throw new Error(rr.error);
      recipientAgentId = rr.recipient.moltbookAgentId;
      recipientName = rr.recipient.moltbookName ?? null;
    } else if (body.recipientName) {
      const recipientProfile = await fetchProfileByName(body.recipientName);
      recipientAgentId = recipientProfile.id;
      recipientName = recipientProfile.name;
    } else if (body.recipientAgentId) {
      recipientAgentId = body.recipientAgentId;
      recipientName = body.recipientName ?? null;
    } else {
      throw new Error('missing_recipient');
    }

    if (body.recipientAgentId && body.recipientAgentId !== recipientAgentId) {
      throw new Error('recipient_identity_mismatch');
    }

    const recipientIdHash = agentIdHashFromAgentId(recipientAgentId);
    if (body.recipientIdHash && body.recipientIdHash.toLowerCase() !== recipientIdHash.toLowerCase()) {
      throw new Error('recipient_id_hash_mismatch');
    }

    // Prevent self-tips at the identity layer.
    if (String(tipperLink.agentId).toLowerCase() === String(recipientAgentId).toLowerCase()) {
      throw new Error('self_tip_not_allowed');
    }

    const provider = getBaseProvider();
    const network = await provider.getNetwork();
    const contractAddress = getChitinContractAddress();

    // Fast-fail if contract is paused (emergency stop).
    try {
      const paused: boolean = await new ethers.Contract(contractAddress, ['function paused() view returns (bool)'], provider).paused();
      if (paused) throw new Error('paused');
    } catch (e) {
      // If paused() isn't available (older deployment), proceed.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'paused') throw e;
    }

    // Verify context hash.
    const expectedContextHash = ethers.keccak256(ethers.toUtf8Bytes(body.context));
    if (expectedContextHash.toLowerCase() !== body.contextHash.toLowerCase()) {
      throw new Error('context_hash_mismatch');
    }

    const gross = BigInt(body.grossAmount);
    const nonce = BigInt(body.nonce);
    const deadline = BigInt(body.deadline);

    if (gross > MAX_UINT256) throw new Error('gross_amount_too_large');
    if (nonce > MAX_UINT256) throw new Error('nonce_too_large');
    if (deadline > MAX_UINT256) throw new Error('deadline_too_large');

    // Reject already-expired deadlines based on chain time (not local time).
    const latest = await provider.getBlock('latest');
    if (!latest) throw new Error('no_latest_block');
    if (deadline <= BigInt(latest.timestamp)) {
      throw new Error('deadline_expired');
    }

    // Prevent relayer gas-drain via replay bursts: only allow one in-flight submit per agent+nonce.
    const ttl = getChitinConfig().locks?.tipNonceLockTtlSeconds ?? 120;
    const got = await acquireLock({ key: `tip_nonce:${tipperLink.agentId}:${nonce.toString()}`, ttlSeconds: ttl });
    if (!got) throw new Error('nonce_in_flight');

    // Verify signature offchain to avoid wasting relayer gas.
    const domain = {
      name: 'CHITIN',
      version: '1',
      chainId: network.chainId,
      verifyingContract: contractAddress
    };

    const recovered = ethers.verifyTypedData(
      domain,
      TIP_TYPES,
      {
        tipper: body.tipper,
        recipientIdHash,
        grossAmount: gross,
        nonce,
        deadline,
        contextHash: body.contextHash
      },
      body.signature
    );
    if (recovered.toLowerCase() !== body.tipper.toLowerCase()) {
      throw new Error('invalid_signature');
    }

    // Preflight nonce + caps against chain state.
    const readerAbi = [
      'function mintStatus(address tipperWallet) view returns (uint256 day,uint256 epoch,uint256 dayInEpoch,uint256 epochBudget,uint256 epochUnlocked,uint256 epochUsed,uint256 dailyTranche,uint256 effectivePerAgentCap,uint256 globalUsedToday,uint256 tipperUsed,uint256 nextNonce)'
    ];
    const tokenReader = new ethers.Contract(contractAddress, readerAbi, provider);
    const status = await tokenReader.mintStatus(body.tipper);

    const chainNonce = BigInt(status.nextNonce);
    if (chainNonce !== nonce) {
      throw new Error('nonce_mismatch');
    }

    const epochBudget = BigInt(status.epochBudget);
    const epochUnlocked = BigInt(status.epochUnlocked);
    const epochUsed = BigInt(status.epochUsed);
    const perCap = BigInt(status.effectivePerAgentCap);
    const tipperUsed = BigInt(status.tipperUsed);

    if (epochBudget - epochUsed < gross) throw new Error('epoch_budget_exceeded');
    if (epochUnlocked - epochUsed < gross) throw new Error('epoch_unlock_exceeded');
    if (perCap - tipperUsed < gross) throw new Error('per_agent_cap_exceeded');

    // Submit onchain via relayer.
    const signer = getRelayerSigner(provider);
    const token = new ethers.Contract(contractAddress, chitinInterface.fragments, signer);
    const tx = await token.tip(body.tipper, recipientIdHash, gross, nonce, deadline, body.contextHash, body.signature);

    await dbQuery(
      `
      INSERT INTO activities (
        kind, status, tx_hash, chain_id,
        tipper, gross_amount,
        recipient_agent_id, recipient_id_hash, recipient_name,
        context, context_hash
      )
      VALUES ('tip', 'pending', $1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tx_hash) DO NOTHING
      `,
      [
        tx.hash,
        network.chainId.toString(),
        body.tipper,
        body.grossAmount,
        recipientAgentId,
        recipientIdHash,
        recipientName ?? body.recipientName ?? null,
        body.context,
        body.contextHash
      ]
    );

    // Best-effort (throttled) reconcile so the UI updates quickly without amplifying RPC cost during bursts.
    await reconcileOnSubmitBestEffort();

    return NextResponse.json({ success: true, txHash: tx.hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
