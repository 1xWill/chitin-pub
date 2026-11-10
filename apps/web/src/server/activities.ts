import { dbQuery } from '@/server/db';
import type { ActivityView } from '@/lib/activity-types';
import { getDemoActivities, getDemoActivitiesCount, isDemoMode } from '@/server/demo-data';

export async function countActivitiesCapped(cap: number): Promise<number> {
  if (isDemoMode()) return getDemoActivitiesCount(cap);

  const rows = await dbQuery<{ cnt: number }>(
    `
    WITH capped AS (
      SELECT 1
      FROM activities
      ORDER BY created_at DESC
      LIMIT $1
    )
    SELECT COUNT(*)::int AS cnt
    FROM capped
    `,
    [cap]
  );
  return rows[0]?.cnt ?? 0;
}

export async function listActivities(params: { limit: number; offset?: number }): Promise<ActivityView[]> {
  if (isDemoMode()) return getDemoActivities(params);

  const limit = params.limit;
  const offset = params.offset ?? 0;
  const rows = await dbQuery<{
    kind: 'tip' | 'tip_mint' | 'tip_reserve' | 'pay' | 'claim';
    status: 'pending' | 'confirmed' | 'failed';
    tx_hash: string;
    burn_tx_hash: string | null;
    block_number: number | null;
    created_at: string;

    tipper: string | null;
    tipper_name: string | null;
    recipient: string | null;
    recipient_name: string | null;
    recipient_agent_id: string | null;
    recipient_name_by_id: string | null;
    recipient_name_snapshot: string | null;
    recipient_id_hash: string | null;
    claim_tx_hash: string | null;
    gross_amount: string | null;
    net_amount: string | null;
    treasury_amount: string | null;

    from_addr: string | null;
    from_name: string | null;
    to_addr: string | null;
    to_name: string | null;
    value: string | null;

    burn_amount: string | null;

    context: string | null;
  }>(
    `
    WITH addr_map AS (
      -- Use wallet history so older activities still resolve agent names after wallet rotation.
      SELECT DISTINCT lower(addr) AS addr, agent_id
      FROM (
        SELECT lower(w.address) AS addr, w.moltbook_agent_id AS agent_id
        FROM agent_wallets w
        UNION ALL
        SELECT lower(e.new_address) AS addr, e.moltbook_agent_id AS agent_id
        FROM agent_wallet_events e
        UNION ALL
        SELECT lower(e.old_address) AS addr, e.moltbook_agent_id AS agent_id
        FROM agent_wallet_events e
        WHERE e.old_address IS NOT NULL
      ) x
    )
    SELECT
      act.kind,
      act.status,
      act.tx_hash,
      act.burn_tx_hash,
      act.block_number,
      act.created_at,

      act.tipper,
      tipper_agent.moltbook_name AS tipper_name,
      act.recipient,
      recipient_agent.moltbook_name AS recipient_name,
      act.recipient_agent_id,
      recipient_by_id.moltbook_name AS recipient_name_by_id,
      act.recipient_name AS recipient_name_snapshot,
      act.recipient_id_hash,
      act.claim_tx_hash,
      act.gross_amount,
      act.net_amount,
      act.treasury_amount,

      act.from_addr,
      from_agent.moltbook_name AS from_name,
      act.to_addr,
      to_agent.moltbook_name AS to_name,
      act.value,

      act.burn_amount,

      act.context
    FROM activities act
    LEFT JOIN addr_map tipper_map ON tipper_map.addr=lower(act.tipper)
    LEFT JOIN agents tipper_agent ON tipper_agent.moltbook_agent_id=tipper_map.agent_id
    LEFT JOIN addr_map recipient_map ON recipient_map.addr=lower(act.recipient)
    LEFT JOIN agents recipient_agent ON recipient_agent.moltbook_agent_id=recipient_map.agent_id
    LEFT JOIN agents recipient_by_id ON recipient_by_id.moltbook_agent_id=act.recipient_agent_id

    LEFT JOIN addr_map from_map ON from_map.addr=lower(act.from_addr)
    LEFT JOIN agents from_agent ON from_agent.moltbook_agent_id=from_map.agent_id
    LEFT JOIN addr_map to_map ON to_map.addr=lower(act.to_addr)
    LEFT JOIN agents to_agent ON to_agent.moltbook_agent_id=to_map.agent_id

    ORDER BY act.created_at DESC
    LIMIT $1
    OFFSET $2
    `,
    [limit, offset]
  );

  // We hide failed rows to keep the feed clean. Claims are shown as their own rows for visibility:
  // the original reserved tip rows still flip from "pending claim" -> "claimed" when the claim is confirmed.
  const visible = rows.filter((r) => r.status !== 'failed');

  return visible.map((r) => {
    if (r.kind === 'tip') {
      return {
        kind: 'tip',
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        createdAt: r.created_at,
        tipper: r.tipper ?? '',
        tipperName: r.tipper_name,
        recipientAgentId: r.recipient_agent_id ?? '',
        recipientName: r.recipient_name_by_id ?? r.recipient_name_snapshot ?? null,
        recipientIdHash: r.recipient_id_hash ?? '',
        grossAmount: r.gross_amount ?? '0',
        context: r.context,
        status: r.status
      };
    }

    if (r.kind === 'claim') {
      return {
        kind: 'claim',
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        createdAt: r.created_at,
        recipient: r.recipient ?? '',
        recipientAgentId: r.recipient_agent_id ?? '',
        recipientName: r.recipient_name_by_id ?? r.recipient_name_snapshot ?? null,
        netAmount: r.net_amount ?? '0',
        status: r.status
      };
    }

    if (r.kind === 'tip_mint') {
      return {
        kind: 'tip_mint',
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        createdAt: r.created_at,
        tipper: r.tipper ?? '',
        tipperName: r.tipper_name,
        recipient: r.recipient ?? '',
        recipientName: r.recipient_name,
        grossAmount: r.gross_amount ?? '0',
        netAmount: r.net_amount,
        treasuryAmount: r.treasury_amount,
        context: r.context,
        status: r.status
      };
    }

    if (r.kind === 'tip_reserve') {
      return {
        kind: 'tip_reserve',
        txHash: r.tx_hash,
        blockNumber: r.block_number,
        createdAt: r.created_at,
        tipper: r.tipper ?? '',
        tipperName: r.tipper_name,
        recipientAgentId: r.recipient_agent_id ?? '',
        recipientName: r.recipient_name_by_id ?? r.recipient_name_snapshot ?? null,
        recipientIdHash: r.recipient_id_hash ?? '',
        grossAmount: r.gross_amount ?? '0',
        netAmount: r.net_amount,
        treasuryAmount: r.treasury_amount,
        claimed: Boolean(r.claim_tx_hash),
        claimTxHash: r.claim_tx_hash,
        context: r.context,
        status: r.status
      };
    }

    if (r.kind === 'pay') {
      const burnVerified = Boolean(r.burn_tx_hash && r.burn_amount);
      return {
        kind: 'pay',
        txHash: r.tx_hash,
        burnTxHash: r.burn_tx_hash,
        blockNumber: r.block_number,
        createdAt: r.created_at,
        from: r.from_addr ?? '',
        fromName: r.from_name,
        to: r.to_addr ?? '',
        toName: r.to_name,
        netAmount: r.value ?? '0',
        grossAmount: burnVerified ? r.gross_amount ?? null : null,
        burnAmount: burnVerified ? r.burn_amount ?? null : null,
        taxStatus: burnVerified ? 'paid' : 'unpaid',
        context: r.context,
        status: r.status
      };
    }

    throw new Error('unknown_activity_kind');
  });
}
