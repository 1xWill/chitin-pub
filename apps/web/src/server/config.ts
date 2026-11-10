import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const RateLimitBucketSchema = z
  .object({
    windowSeconds: z.number().int().positive(),
    max: z.number().int().positive()
  })
  .strict();

const CredibilityCurveSchema = z
  .object({
    // Max points contributed by this component.
    maxPoints: z.number().int().min(0).max(100),
    // Diminishing returns curve unit (meaning depends on the component).
    unit: z.number().positive(),
    target: z.number().positive()
  })
  .strict();

const ChitinConfigSchema = z
  .object({
    // If empty, we fall back to request origin.
    publicOrigin: z.string().optional(),

    chain: z
      .object({
        chainId: z.number().int().positive(),
        publicRpcUrl: z.string().url(),
        // Allow empty string in-repo to make "where do I put it?" obvious, while still failing fast at runtime.
        contractAddress: z.union([z.string().regex(/^0x[0-9a-fA-F]{40}$/), z.literal('')]).optional()
      })
      .strict(),

    sources: z
      .object({
        enabled: z.array(z.enum(['moltbook', 'moltx'])).min(1)
      })
      .strict()
      .optional(),

    moltbook: z
      .object({
        apiBase: z.string().url(),
        linkSubmolt: z.string().min(1),
        linkLookupMaxPages: z.number().int().min(1).max(100),
        postsPageSize: z.number().int().min(1).max(100),
        fetchTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
        fetchRetries: z.number().int().min(0).max(5).optional()
      })
      .strict(),

    moltx: z
      .object({
        apiBase: z.string().url(),
        fetchTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
        fetchRetries: z.number().int().min(0).max(5).optional()
      })
      .strict()
      .optional(),

    api: z
      .object({
        activitiesDefaultLimit: z.number().int().min(1).max(500),
        activitiesMaxLimit: z.number().int().min(1).max(2000),
        // Activities pagination (used by /activities UI).
        activitiesPageSize: z.number().int().min(1).max(100).optional(),
        activitiesMaxPages: z.number().int().min(1).max(200).optional()
      })
      .strict(),

    ui: z
      .object({
        // Client-side polling interval for activities/metrics/leaderboard (visibility-aware to reduce load).
        pollIntervalSeconds: z.number().int().min(5).max(300).optional()
      })
      .strict()
      .optional(),

    reconcile: z
      .object({
        onSubmitBatchSize: z.number().int().min(0).max(500),
        // Throttle best-effort reconcile triggered by public submits to batch bursts and reduce upstream RPC cost.
        onSubmitCooldownSeconds: z.number().int().min(0).max(300).optional(),
        pendingMaxAgeSeconds: z.number().int().min(60).max(60 * 60 * 24 * 60).optional()
      })
      .strict(),

    credibility: z
      .object({
        // PAY social deflation rule: burn 2.5% (250 bps) of the gross payment.
        payBurnBps: z.number().int().min(0).max(5000),

        baseScore: z.number().int().min(0).max(100),
        minScore: z.number().int().min(0).max(100),
        maxScore: z.number().int().min(0).max(100),

        // Credibility is intended to be stable across epochs:
        // - It is not based on holdings.
        // - It does not depend on tip emission epoch budgets.
        //
        // Score components:
        // - PAY compliance ratio (dominant): paidBurn / (paidBurn + evadedBurn).
        // - PAY scale (diminishing returns): based on total verified burn amount.
        // - PAY diversity (diminishing returns): based on distinct recipients paid with verified burn (optionally min-gross gated).

        // PAY compliance is the dominant component, but it must ramp with volume so a single small PAY doesn't
        // instantly yield a max score.
        //
        // We compute a *delta* in [-maxPoints, +maxPoints] based on:
        // - centered compliance ratio in [-1, +1]
        // - volume factor in [0, 1] from expected burn curve (paid + evaded).
        payComplianceDeltaMaxPoints: z.number().int().min(0).max(100),

        // Diminishing returns curve for the compliance volume factor (x = expected burn, in CHITIN).
        payComplianceExpectedBurnScale: CredibilityCurveSchema,

        // Small bonus for tipping taxes paid (forces are onchain anyway); intentionally low weight.
        tipTaxScale: CredibilityCurveSchema.optional(),

        // Diminishing returns curve for burn scale (x = total verified burn, in CHITIN).
        payBurnScale: CredibilityCurveSchema,

        // Diminishing returns curve for recipient diversity (x = distinct recipient count).
        payRecipientDiversity: CredibilityCurveSchema,

        // Minimum gross PAY size (in CHITIN) for a recipient to count toward diversity.
        minGrossPayForRecipientCountChitin: z.number().min(0)
      })
      .strict()
      .optional(),

    locks: z
      .object({
        // Prevent relayer gas-drain via nonce replay bursts; TTL allows recovery if a request dies mid-flight.
        tipNonceLockTtlSeconds: z.number().int().min(5).max(600).optional(),
        // Housekeeping to prevent unbounded lock growth (best-effort via cron).
        cleanupMaxAgeSeconds: z.number().int().positive().optional(),
        // Prevent thundering herd: on-demand balance refresh (should be rare, but lock it anyway).
        refreshBalancesOnDemandTtlSeconds: z.number().int().min(5).max(600).optional()
      })
      .strict()
      .optional(),

    rateLimit: z
      .object({
        cleanupMaxAgeSeconds: z.number().int().positive(),
        linkSubmitPerIp: RateLimitBucketSchema,
        aliasSubmitPerIp: RateLimitBucketSchema.optional(),
        transferSubmitPerIp: RateLimitBucketSchema,
        tipPerIp: RateLimitBucketSchema,
        tipPerAgent: RateLimitBucketSchema.optional()
      })
      .strict()
  })
  .strict();

export type ChitinConfig = z.infer<typeof ChitinConfigSchema>;

function findConfigPath(): string {
  const fromEnv = (process.env.CHITIN_CONFIG_PATH ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);

  // Prefer Next app root.
  const candidates = [
    path.join(process.cwd(), 'chitin.config.json'),
    path.join(process.cwd(), 'apps', 'web', 'chitin.config.json')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Default to the "expected" path for clearer error messages.
  return candidates[0];
}

let cached: { path: string; mtimeMs: number; cfg: ChitinConfig } | null = null;

export function getChitinConfig(): ChitinConfig {
  const p = findConfigPath();

  const stat = fs.statSync(p, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`Missing CHITIN config file: ${p}`);
  }

  // In production, keep it simple + stable: load once.
  // In dev, reload if the file changes.
  if (cached && cached.path === p) {
    if (process.env.NODE_ENV === 'production') return cached.cfg;
    if (cached.mtimeMs === stat.mtimeMs) return cached.cfg;
  }

  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  let cfg: ChitinConfig;
  try {
    cfg = ChitinConfigSchema.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid CHITIN config file: ${p}: ${msg}`);
  }

  cached = { path: p, mtimeMs: stat.mtimeMs, cfg };
  return cfg;
}

export function getPublicOrigin(req: Request): string {
  const cfg = getChitinConfig();
  const fromCfg = (cfg.publicOrigin ?? '').trim();
  if (fromCfg) return fromCfg.replace(/\/+$/, '');
  return new URL(req.url).origin;
}
