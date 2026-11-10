import { dbQuery } from '@/server/db';
import { getChitinConfig } from '@/server/config';
import { getDemoCredibilityByAgentId, getDemoTopCredibility, isDemoMode } from '@/server/demo-data';

export type CredibilityResult = {
  score: number;
  tipTaxPaidWei: string;
  payBurnPaidWei: string;
  payBurnEvadedWei: string;
  payCount: number;
  payCountTaxPaid: number;
};

type CredCfg = NonNullable<ReturnType<typeof getCredibilityConfig>>;

function getCredibilityConfig() {
  return getChitinConfig().credibility;
}

function validateCredibilityConfig(cfg: CredCfg) {
  if (cfg.minScore > cfg.maxScore) throw new Error('credibility_invalid_min_max');
  if (cfg.baseScore < cfg.minScore || cfg.baseScore > cfg.maxScore) throw new Error('credibility_invalid_base');
  if (cfg.payBurnBps <= 0 || cfg.payBurnBps >= 10_000) throw new Error('credibility_invalid_payBurnBps');

  if (cfg.payComplianceDeltaMaxPoints < 0 || cfg.payComplianceDeltaMaxPoints > 100) {
    throw new Error('credibility_invalid_compliance_points');
  }

  for (const k of ['payComplianceExpectedBurnScale', 'payBurnScale', 'payRecipientDiversity'] as const) {
    const c = cfg[k];
    if (c.unit <= 0 || c.target <= 0) throw new Error('credibility_invalid_curve_' + k);
  }

  if (cfg.tipTaxScale) {
    const c = cfg.tipTaxScale;
    if (c.unit <= 0 || c.target <= 0) throw new Error('credibility_invalid_curve_tipTaxScale');
  }

  if (cfg.minGrossPayForRecipientCountChitin < 0) throw new Error('credibility_invalid_min_gross');
}

function scoreExprSql(params: {
  cfg: CredCfg;
  tipTaxPaidWeiExpr: string;
  payBurnPaidWeiExpr: string;
  payBurnEvadedWeiExpr: string;
  payRecipientCountExpr: string;
}): string {
  // Score is computed in SQL for consistency across lookup + leaderboard.
  // Diminishing-returns curve:
  // points = maxPoints * ln(1 + x/unit) / ln(1 + target/unit), clamped to [0, maxPoints].
  const cfg = params.cfg;
  validateCredibilityConfig(cfg);

  const oneEth = `1000000000000000000`; // 1e18
  const tipTaxPaidChitin = `(${params.tipTaxPaidWeiExpr})::numeric / ${oneEth}::numeric`;
  const burnPaidChitin = `(${params.payBurnPaidWeiExpr})::numeric / ${oneEth}::numeric`;
  const burnExpectedChitin = `((${params.payBurnPaidWeiExpr})::numeric + (${params.payBurnEvadedWeiExpr})::numeric) / ${oneEth}::numeric`;
  const recipientCount = `(${params.payRecipientCountExpr})::numeric`;

  function curvePointsSql(x: string, curve: { maxPoints: number; unit: number; target: number }): string {
    // Avoid division by zero: validateCredibilityConfig ensures unit/target > 0.
    const denom = `LN(1 + (${curve.target}::numeric / ${curve.unit}::numeric))`;
    return `LEAST(${curve.maxPoints}::numeric, (${curve.maxPoints}::numeric * (LN(1 + ((${x}) / ${curve.unit}::numeric)) / NULLIF(${denom}, 0))))`;
  }

  // Dominant: PAY compliance (paid burn vs expected burn), but ramped by expected burn volume so a single
  // tiny PAY doesn't immediately hit max score.
  //
  // - ratio in [0,1]
  // - centered ratio in [-1,1] (0.5 => neutral)
  // - volumeFactor in [0,1] using a diminishing-returns curve on expected burn
  //
  // complianceDelta = maxPoints * (2*ratio - 1) * volumeFactor
  // - no PAY history -> denom=0 -> volumeFactor=0 -> delta=0 (agent stays at baseScore)
  const denomWei = `((${params.payBurnPaidWeiExpr})::numeric + (${params.payBurnEvadedWeiExpr})::numeric)`;
  const ratio = `CASE WHEN ${denomWei} <= 0 THEN 0.5 ELSE ((${params.payBurnPaidWeiExpr})::numeric / ${denomWei}) END`;
  const centered = `(2::numeric * (${ratio}) - 1::numeric)`;
  const volDenom = `LN(1 + (${cfg.payComplianceExpectedBurnScale.target}::numeric / ${cfg.payComplianceExpectedBurnScale.unit}::numeric))`;
  const volumeFactor = `CASE WHEN ${denomWei} <= 0 THEN 0 ELSE LEAST(1::numeric, (LN(1 + ((${burnExpectedChitin}) / ${cfg.payComplianceExpectedBurnScale.unit}::numeric)) / NULLIF(${volDenom}, 0))) END`;
  const complianceDelta = `(${cfg.payComplianceDeltaMaxPoints}::numeric * (${centered}) * (${volumeFactor}))`;

  const tipTaxPoints = cfg.tipTaxScale ? curvePointsSql(tipTaxPaidChitin, cfg.tipTaxScale) : `0::numeric`;
  const scalePoints = curvePointsSql(burnPaidChitin, cfg.payBurnScale);
  const diversityPoints = curvePointsSql(recipientCount, cfg.payRecipientDiversity);

  const raw = `(${cfg.baseScore}::numeric + (${complianceDelta}) + (${tipTaxPoints}) + (${scalePoints}) + (${diversityPoints}))`;
  const clamped = `LEAST(${cfg.maxScore}::numeric, GREATEST(${cfg.minScore}::numeric, ${raw}))`;
  return `ROUND(${clamped})::int`;
}

export async function getCredibilityByAgentId(agentId: string): Promise<CredibilityResult | null> {
  if (isDemoMode()) return getDemoCredibilityByAgentId(agentId);

  const cfg = getCredibilityConfig();
  if (!cfg) return null;

  validateCredibilityConfig(cfg);

  const rows = await dbQuery<{
    tip_tax_wei: string;
    pay_burn_paid_wei: string;
    pay_burn_evaded_wei: string;
    pay_count: number;
    pay_count_tax_paid: number;
    pay_recipient_count_tax_paid: number;
    score: number;
  }>(
    `
    WITH addrs AS (
      -- Credibility is tied to the agent identity, not the current wallet.
      -- Include all historically linked addresses (wallet rotations) to prevent "resetting" score by rotating.
      SELECT DISTINCT lower(addr) AS addr
      FROM (
        SELECT address AS addr
        FROM agent_wallets
        WHERE moltbook_agent_id=$1
        UNION ALL
        SELECT new_address AS addr
        FROM agent_wallet_events
        WHERE moltbook_agent_id=$1
        UNION ALL
        SELECT old_address AS addr
        FROM agent_wallet_events
        WHERE moltbook_agent_id=$1 AND old_address IS NOT NULL
      ) x
    ),
    tip_tax AS (
      SELECT COALESCE(SUM(act.treasury_amount::numeric), 0)::text AS tip_tax_wei
      FROM activities act
      JOIN addrs a ON a.addr=lower(act.tipper)
      WHERE act.status='confirmed'
        AND act.kind IN ('tip_mint','tip_reserve')
        AND act.treasury_amount IS NOT NULL
    ),
    pay_stats AS (
      SELECT
        COALESCE(SUM(CASE WHEN act.burn_amount IS NOT NULL THEN act.burn_amount::numeric ELSE 0 END), 0)::text AS pay_burn_paid_wei,
        COALESCE(SUM(
          CASE
            WHEN act.burn_amount IS NULL AND act.value IS NOT NULL
              THEN FLOOR((act.value::numeric * ${cfg.payBurnBps}::numeric) / 10000::numeric)
            ELSE 0
          END
        ), 0)::text AS pay_burn_evaded_wei,
        COUNT(*)::int AS pay_count,
        COALESCE(SUM(CASE WHEN act.burn_amount IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS pay_count_tax_paid,
        COUNT(DISTINCT (CASE
          WHEN act.burn_amount IS NOT NULL
            AND act.gross_amount IS NOT NULL
            AND act.gross_amount::numeric >= (${cfg.minGrossPayForRecipientCountChitin}::numeric * 1000000000000000000::numeric)
          THEN lower(act.to_addr)
          ELSE NULL
        END))::int AS pay_recipient_count_tax_paid
      FROM activities act
      JOIN addrs a ON a.addr=lower(act.from_addr)
      WHERE act.status='confirmed'
        AND act.kind='pay'
        AND act.value IS NOT NULL
    )
    SELECT
      tip_tax.tip_tax_wei,
      pay_stats.pay_burn_paid_wei,
      pay_stats.pay_burn_evaded_wei,
      pay_stats.pay_count,
      pay_stats.pay_count_tax_paid,
      pay_stats.pay_recipient_count_tax_paid,
      ${scoreExprSql({
        cfg,
        tipTaxPaidWeiExpr: 'tip_tax.tip_tax_wei',
        payBurnPaidWeiExpr: 'pay_stats.pay_burn_paid_wei',
        payBurnEvadedWeiExpr: 'pay_stats.pay_burn_evaded_wei'
        ,
        payRecipientCountExpr: 'pay_stats.pay_recipient_count_tax_paid'
      })} AS score
    FROM tip_tax, pay_stats
    `,
    [agentId]
  );

  const r = rows[0];
  if (!r) return null;
  return {
    score: r.score,
    tipTaxPaidWei: r.tip_tax_wei,
    payBurnPaidWei: r.pay_burn_paid_wei,
    payBurnEvadedWei: r.pay_burn_evaded_wei,
    payCount: r.pay_count,
    payCountTaxPaid: r.pay_count_tax_paid
  };
}

export async function getTopCredibility(limit: number, order: 'asc' | 'desc' = 'desc'): Promise<Array<{ moltbookAgentId: string; moltbookName: string; ownerXHandle: string | null; address: string; score: number }>> {
  if (isDemoMode()) return getDemoTopCredibility(limit, order);

  const cfg = getCredibilityConfig();
  if (!cfg) return [];
  validateCredibilityConfig(cfg);

  const rows = await dbQuery<{
    moltbook_agent_id: string;
    moltbook_name: string;
    owner_x_handle: string | null;
    address: string;
    tip_tax_wei: string;
    pay_burn_paid_wei: string;
    pay_burn_evaded_wei: string;
    pay_recipient_count_tax_paid: number;
    score: number;
  }>(
    `
    WITH agent_addrs AS (
      -- Agent identity can rotate wallets; include their full address history for scoring.
      SELECT DISTINCT agent_id, lower(addr) AS addr
      FROM (
        SELECT w.moltbook_agent_id AS agent_id, w.address AS addr
        FROM agent_wallets w
        UNION ALL
        SELECT e.moltbook_agent_id AS agent_id, e.new_address AS addr
        FROM agent_wallet_events e
        UNION ALL
        SELECT e.moltbook_agent_id AS agent_id, e.old_address AS addr
        FROM agent_wallet_events e
        WHERE e.old_address IS NOT NULL
      ) x
    ),
    tip_tax AS (
      SELECT
        aa.agent_id AS agent_id,
        COALESCE(SUM(act.treasury_amount::numeric), 0)::text AS tip_tax_wei
      FROM activities act
      JOIN agent_addrs aa ON aa.addr=lower(act.tipper)
      WHERE act.status='confirmed'
        AND act.kind IN ('tip_mint','tip_reserve')
        AND act.treasury_amount IS NOT NULL
      GROUP BY aa.agent_id
    ),
    pay_stats AS (
      SELECT
        aa.agent_id AS agent_id,
        COALESCE(SUM(CASE WHEN act.burn_amount IS NOT NULL THEN act.burn_amount::numeric ELSE 0 END), 0)::text AS pay_burn_paid_wei,
        COALESCE(SUM(
          CASE
            WHEN act.burn_amount IS NULL AND act.value IS NOT NULL
              THEN FLOOR((act.value::numeric * ${cfg.payBurnBps}::numeric) / 10000::numeric)
            ELSE 0
          END
        ), 0)::text AS pay_burn_evaded_wei
        ,
        COUNT(DISTINCT (CASE
          WHEN act.burn_amount IS NOT NULL
            AND act.gross_amount IS NOT NULL
            AND act.gross_amount::numeric >= (${cfg.minGrossPayForRecipientCountChitin}::numeric * 1000000000000000000::numeric)
          THEN lower(act.to_addr)
          ELSE NULL
        END))::int AS pay_recipient_count_tax_paid
      FROM activities act
      JOIN agent_addrs aa ON aa.addr=lower(act.from_addr)
      WHERE act.status='confirmed'
        AND act.kind='pay'
        AND act.value IS NOT NULL
      GROUP BY aa.agent_id
    ),
    base AS (
      SELECT a.moltbook_agent_id, a.moltbook_name, a.owner_x_handle, w.address
      FROM agents a
      JOIN agent_wallets w ON w.moltbook_agent_id=a.moltbook_agent_id
    ),
    combined AS (
      SELECT
        base.moltbook_agent_id,
        base.moltbook_name,
        base.owner_x_handle,
        base.address,
        COALESCE(tip_tax.tip_tax_wei, '0') AS tip_tax_wei,
        COALESCE(pay_stats.pay_burn_paid_wei, '0') AS pay_burn_paid_wei,
        COALESCE(pay_stats.pay_burn_evaded_wei, '0') AS pay_burn_evaded_wei,
        COALESCE(pay_stats.pay_recipient_count_tax_paid, 0)::int AS pay_recipient_count_tax_paid
      FROM base
      LEFT JOIN tip_tax ON tip_tax.agent_id=base.moltbook_agent_id
      LEFT JOIN pay_stats ON pay_stats.agent_id=base.moltbook_agent_id
    )
    SELECT
      combined.moltbook_agent_id,
      combined.moltbook_name,
      combined.owner_x_handle,
      combined.address,
      combined.tip_tax_wei,
      combined.pay_burn_paid_wei,
      combined.pay_burn_evaded_wei,
      ${scoreExprSql({
        cfg,
        tipTaxPaidWeiExpr: 'combined.tip_tax_wei',
        payBurnPaidWeiExpr: 'combined.pay_burn_paid_wei',
        payBurnEvadedWeiExpr: 'combined.pay_burn_evaded_wei'
        ,
        payRecipientCountExpr: 'combined.pay_recipient_count_tax_paid'
      })} AS score
    FROM combined
    ORDER BY score ${order === 'asc' ? 'ASC' : 'DESC'}, (combined.pay_burn_paid_wei::numeric) DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows.map((r) => ({
    moltbookAgentId: r.moltbook_agent_id,
    moltbookName: r.moltbook_name,
    ownerXHandle: r.owner_x_handle,
    address: r.address,
    score: r.score
  }));
}
