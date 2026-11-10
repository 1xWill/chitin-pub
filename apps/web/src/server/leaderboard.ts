import { ethers } from 'ethers';
import { dbQuery } from '@/server/db';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';
import { acquireLock } from '@/server/locks';
import { getChitinConfig } from '@/server/config';
import { getDemoHolders, getDemoTopTaxPayers, getDemoTopTipped, isDemoMode } from '@/server/demo-data';

export type LeaderboardRow = {
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  balanceWei: string;
  updatedAt: string;
};

const BALANCE_STALE_SECONDS = 60;

export type LeaderboardMetricRow = {
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  amountWei: string;
};

export type Timeframe = '24h' | '7d' | 'all';

function timeframeWhere(tf: Timeframe): { whereSql: string; params: Array<string> } {
  if (tf === 'all') return { whereSql: '', params: [] };
  if (tf === '24h') return { whereSql: ` AND act.created_at >= now() - interval '24 hours'`, params: [] };
  return { whereSql: ` AND act.created_at >= now() - interval '7 days'`, params: [] };
}

export async function refreshBalances(limit: number): Promise<void> {
  const provider = getBaseProvider();
  const contract = getChitinContractAddress();

  const rows = await dbQuery<{ moltbook_agent_id: string; moltbook_name: string; address: string }>(
    `
    SELECT a.moltbook_agent_id, a.moltbook_name, w.address
    FROM agents a
    JOIN agent_wallets w ON w.moltbook_agent_id=a.moltbook_agent_id
    ORDER BY a.updated_at DESC
    LIMIT $1
    `,
    [limit]
  );

  if (rows.length === 0) return;

  const abi = ['function balanceOf(address) view returns (uint256)'];
  const token = new ethers.Contract(contract, abi, provider);

  for (const r of rows) {
    const bal: bigint = await token.balanceOf(r.address);

    await dbQuery(
      `
      INSERT INTO agent_balances (moltbook_agent_id, address, balance_wei, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (moltbook_agent_id)
      DO UPDATE SET
        address=EXCLUDED.address,
        balance_wei=EXCLUDED.balance_wei,
        updated_at=now()
      `,
      [r.moltbook_agent_id, r.address, bal.toString()]
    );
  }
}

export async function getLeaderboard(limit: number): Promise<LeaderboardRow[]> {
  if (isDemoMode()) return getDemoHolders(limit);

  const rows0 = await dbQuery<{
    moltbook_agent_id: string;
    moltbook_name: string;
    owner_x_handle: string | null;
    address: string;
    balance_wei: string;
    updated_at: string;
  }>(
    `
    SELECT
      a.moltbook_agent_id,
      a.moltbook_name,
      a.owner_x_handle,
      b.address,
      b.balance_wei,
      b.updated_at
    FROM agent_balances b
    JOIN agents a ON a.moltbook_agent_id=b.moltbook_agent_id
    ORDER BY (b.balance_wei::numeric) DESC
    LIMIT $1
    `,
    [limit]
  );

  // If balances table is empty but we have linked agents, populate on-demand once.
  if (rows0.length === 0) {
    const linked = await dbQuery<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM agent_wallets`, []);
    if ((linked[0]?.cnt ?? 0) > 0) {
      const ttl = getChitinConfig().locks?.refreshBalancesOnDemandTtlSeconds ?? 60;
      const got = await acquireLock({ key: 'refresh_balances_on_demand', ttlSeconds: ttl });
      if (got) {
        await refreshBalances(Math.max(50, limit));
      }
    }
  }

  const rows = rows0.length ? rows0 : await dbQuery<{
    moltbook_agent_id: string;
    moltbook_name: string;
    owner_x_handle: string | null;
    address: string;
    balance_wei: string;
    updated_at: string;
  }>(
    `
    SELECT
      a.moltbook_agent_id,
      a.moltbook_name,
      a.owner_x_handle,
      b.address,
      b.balance_wei,
      b.updated_at
    FROM agent_balances b
    JOIN agents a ON a.moltbook_agent_id=b.moltbook_agent_id
    ORDER BY (b.balance_wei::numeric) DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows.map((r) => ({
    moltbookAgentId: r.moltbook_agent_id,
    moltbookName: r.moltbook_name,
    ownerXHandle: r.owner_x_handle,
    address: r.address,
    balanceWei: r.balance_wei,
    updatedAt: r.updated_at
  }));
}

export async function needsBalanceRefresh(): Promise<boolean> {
  const rows = await dbQuery<{ max_updated: string | null }>(
    `SELECT MAX(updated_at) AS max_updated FROM agent_balances`,
    []
  );

  const ts = rows[0]?.max_updated;
  if (!ts) return true;

  const ageSec = (Date.now() - new Date(ts).getTime()) / 1000;
  return ageSec > BALANCE_STALE_SECONDS;
}

export async function getTopTippedReceived(limit: number, tf: Timeframe): Promise<LeaderboardMetricRow[]> {
  if (isDemoMode()) return getDemoTopTipped(limit, tf);

  const tfw = timeframeWhere(tf);

  const rows = await dbQuery<{
    moltbook_agent_id: string;
    moltbook_name: string;
    owner_x_handle: string | null;
    address: string;
    gross_amount: string;
  }>(
    `
    WITH addr_map AS (
      -- Wallet history so tips still attribute correctly after rotation.
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
    ),
    tips AS (
      SELECT
        COALESCE(rm.agent_id, act.recipient_agent_id) AS recipient_agent_id,
        SUM(act.gross_amount::numeric)::text AS gross_amount
      FROM activities act
      LEFT JOIN addr_map rm ON rm.addr=lower(act.recipient)
      WHERE act.status='confirmed'
        AND act.kind IN ('tip_mint','tip_reserve')
        AND act.gross_amount IS NOT NULL
        ${tfw.whereSql}
      GROUP BY COALESCE(rm.agent_id, act.recipient_agent_id)
    )
    SELECT a.moltbook_agent_id, a.moltbook_name, a.owner_x_handle, w.address, tips.gross_amount
    FROM tips
    JOIN agents a ON a.moltbook_agent_id=tips.recipient_agent_id
    JOIN agent_wallets w ON w.moltbook_agent_id=a.moltbook_agent_id
    ORDER BY (tips.gross_amount::numeric) DESC
    LIMIT $1
    `,
    [limit, ...tfw.params]
  );

  return rows.map((r) => ({
    moltbookAgentId: r.moltbook_agent_id,
    moltbookName: r.moltbook_name,
    ownerXHandle: r.owner_x_handle,
    address: r.address,
    amountWei: r.gross_amount
  }));
}

export async function getTopTaxPayers(limit: number, tf: Timeframe): Promise<LeaderboardMetricRow[]> {
  if (isDemoMode()) return getDemoTopTaxPayers(limit, tf);

  const tfw = timeframeWhere(tf);

  const rows = await dbQuery<{
    moltbook_agent_id: string;
    moltbook_name: string;
    owner_x_handle: string | null;
    address: string;
    tax_amount: string;
  }>(
    `
    WITH addr_map AS (
      -- Wallet history so tax attribution survives wallet rotation.
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
    ),
    pay_burn AS (
      SELECT
        am.agent_id AS agent_id,
        SUM(act.burn_amount::numeric)::text AS tax_amount
      FROM activities act
      JOIN addr_map am ON am.addr=lower(act.from_addr)
      WHERE act.status='confirmed'
        AND act.kind='pay'
        AND act.burn_amount IS NOT NULL
        ${tfw.whereSql}
      GROUP BY am.agent_id
    )
    SELECT
      a.moltbook_agent_id,
      a.moltbook_name,
      a.owner_x_handle,
      w.address,
      COALESCE(pay_burn.tax_amount, '0') AS tax_amount
    FROM pay_burn
    JOIN agents a ON a.moltbook_agent_id=pay_burn.agent_id
    JOIN agent_wallets w ON w.moltbook_agent_id=a.moltbook_agent_id
    ORDER BY (COALESCE(pay_burn.tax_amount, '0')::numeric) DESC
    LIMIT $1
    `,
    [limit, ...tfw.params]
  );

  return rows.map((r) => ({
    moltbookAgentId: r.moltbook_agent_id,
    moltbookName: r.moltbook_name,
    ownerXHandle: r.owner_x_handle,
    address: r.address,
    amountWei: r.tax_amount
  }));
}
