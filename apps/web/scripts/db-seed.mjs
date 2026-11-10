import pg from 'pg';
import { ethers } from 'ethers';
import './load-dotenv.mjs';

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Missing env DATABASE_URL');
  process.exit(1);
}

function normalizeDatabaseUrl(raw) {
  try {
    const u = new URL(raw);
    const sslmode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
    const compat = (u.searchParams.get('uselibpqcompat') ?? '').toLowerCase();
    if (compat === 'true') return raw;
    if (sslmode === 'prefer' || sslmode === 'require' || sslmode === 'verify-ca') {
      u.searchParams.set('sslmode', 'verify-full');
      return u.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

function wei(chitin) {
  return ethers.parseUnits(chitin, 18).toString();
}

function isoAgo(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

const AGENTS = [
  {
    id: '11111111-1111-4111-8111-111111111101',
    name: 'clawd_prime',
    ownerXHandle: 'clawd_dev',
    address: '0x71C000000000000000000000000000000000A101',
    balanceWei: wei('18450')
  },
  {
    id: '11111111-1111-4111-8111-111111111102',
    name: 'shell_architect',
    ownerXHandle: 'shell_arch',
    address: '0x71C000000000000000000000000000000000A102',
    balanceWei: wei('14200')
  },
  {
    id: '11111111-1111-4111-8111-111111111103',
    name: 'molt_researcher',
    ownerXHandle: 'molt_ai',
    address: '0x71C000000000000000000000000000000000A103',
    balanceWei: wei('9650')
  },
  {
    id: '11111111-1111-4111-8111-111111111104',
    name: 'reef_auditor',
    ownerXHandle: 'reef_sec',
    address: '0x71C000000000000000000000000000000000A104',
    balanceWei: wei('6120')
  },
  {
    id: '11111111-1111-4111-8111-111111111105',
    name: 'krill_trader',
    ownerXHandle: null,
    address: '0x71C000000000000000000000000000000000A105',
    balanceWei: wei('3400')
  }
];

const UNLINKED = {
  id: '11111111-1111-4111-8111-111111111106',
  name: 'abyssal_bot'
};

const [clawd, shell, molt, reef, krill] = AGENTS;

const ACTIVITIES = [
  {
    kind: 'tip_mint',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000001',
    blockNumber: 21450112,
    createdAt: isoAgo(12),
    tipper: clawd.address,
    recipient: shell.address,
    recipientAgentId: shell.id,
    recipientName: shell.name,
    grossAmount: wei('250'),
    netAmount: wei('243.75'),
    treasuryAmount: wei('6.25'),
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000001'
  },
  {
    kind: 'pay',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000002',
    burnTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000102',
    blockNumber: 21450040,
    createdAt: isoAgo(45),
    fromAddr: shell.address,
    toAddr: molt.address,
    value: wei('390'),
    grossAmount: wei('400'),
    burnAmount: wei('10'),
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000002'
  },
  {
    kind: 'tip_reserve',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000003',
    blockNumber: 21449810,
    createdAt: isoAgo(125),
    tipper: molt.address,
    recipientAgentId: UNLINKED.id,
    recipientName: UNLINKED.name,
    recipientIdHash: ethers.keccak256(ethers.toUtf8Bytes(UNLINKED.id)),
    grossAmount: wei('80'),
    netAmount: wei('78'),
    treasuryAmount: wei('2'),
    claimTxHash: null,
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000003'
  },
  {
    kind: 'tip_mint',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000004',
    blockNumber: 21449200,
    createdAt: isoAgo(310),
    tipper: reef.address,
    recipient: clawd.address,
    recipientAgentId: clawd.id,
    recipientName: clawd.name,
    grossAmount: wei('500'),
    netAmount: wei('487.5'),
    treasuryAmount: wei('12.5'),
    context: 'https://moltx.io/post/9a4b2d30-1111-4222-8333-000000000004'
  },
  {
    kind: 'pay',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000005',
    burnTxHash: null,
    blockNumber: 21448500,
    createdAt: isoAgo(540),
    fromAddr: krill.address,
    toAddr: reef.address,
    value: wei('150'),
    grossAmount: null,
    burnAmount: null,
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000005'
  },
  {
    kind: 'claim',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000006',
    blockNumber: 21410200,
    createdAt: isoAgo(60 * 46),
    recipient: reef.address,
    recipientAgentId: reef.id,
    recipientName: reef.name,
    netAmount: wei('195')
  },
  {
    kind: 'tip_reserve',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000007',
    blockNumber: 21409800,
    createdAt: isoAgo(60 * 48),
    tipper: clawd.address,
    recipientAgentId: reef.id,
    recipientName: reef.name,
    recipientIdHash: ethers.keccak256(ethers.toUtf8Bytes(reef.id)),
    grossAmount: wei('200'),
    netAmount: wei('195'),
    treasuryAmount: wei('5'),
    claimTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000006',
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000006'
  },
  {
    kind: 'pay',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000008',
    burnTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000108',
    blockNumber: 21380100,
    createdAt: isoAgo(60 * 72),
    fromAddr: clawd.address,
    toAddr: shell.address,
    value: wei('975'),
    grossAmount: wei('1000'),
    burnAmount: wei('25'),
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000007'
  },
  {
    kind: 'tip_mint',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000009',
    blockNumber: 21350400,
    createdAt: isoAgo(60 * 96),
    tipper: shell.address,
    recipient: molt.address,
    recipientAgentId: molt.id,
    recipientName: molt.name,
    grossAmount: wei('600'),
    netAmount: wei('585'),
    treasuryAmount: wei('15'),
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000008'
  },
  {
    kind: 'pay',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000010',
    burnTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000110',
    blockNumber: 21210000,
    createdAt: isoAgo(60 * 24 * 10),
    fromAddr: molt.address,
    toAddr: clawd.address,
    value: wei('292.5'),
    grossAmount: wei('300'),
    burnAmount: wei('7.5'),
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000009'
  },
  {
    kind: 'tip_mint',
    txHash: '0xdemo000000000000000000000000000000000000000000000000000000000011',
    blockNumber: 21180000,
    createdAt: isoAgo(60 * 24 * 12),
    tipper: clawd.address,
    recipient: shell.address,
    recipientAgentId: shell.id,
    recipientName: shell.name,
    grossAmount: wei('1200'),
    netAmount: wei('1170'),
    treasuryAmount: wei('30'),
    context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000010'
  }
];

const pool = new Pool({ connectionString: normalizeDatabaseUrl(dbUrl), max: 1 });

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const a of [...AGENTS, UNLINKED]) {
      await client.query(
        `
        INSERT INTO agents (moltbook_agent_id, moltbook_name, is_claimed, owner_x_handle, updated_at)
        VALUES ($1, $2, true, $3, now())
        ON CONFLICT (moltbook_agent_id)
        DO UPDATE SET
          moltbook_name = EXCLUDED.moltbook_name,
          owner_x_handle = EXCLUDED.owner_x_handle,
          updated_at = now()
        `,
        [a.id, a.name, a.ownerXHandle ?? null]
      );
    }

    for (const a of AGENTS) {
      await client.query(
        `
        INSERT INTO agent_wallets (moltbook_agent_id, address, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (moltbook_agent_id)
        DO UPDATE SET address = EXCLUDED.address, updated_at = now()
        `,
        [a.id, a.address]
      );

      await client.query(
        `
        INSERT INTO agent_balances (moltbook_agent_id, address, balance_wei, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (moltbook_agent_id)
        DO UPDATE SET address = EXCLUDED.address, balance_wei = EXCLUDED.balance_wei, updated_at = now()
        `,
        [a.id, a.address, a.balanceWei]
      );
    }

    for (const act of ACTIVITIES) {
      await client.query(
        `
        INSERT INTO activities (
          kind, status, tx_hash, burn_tx_hash, chain_id, block_number,
          tipper, recipient, recipient_agent_id, recipient_name, recipient_id_hash, claim_tx_hash,
          gross_amount, net_amount, treasury_amount,
          from_addr, to_addr, value, burn_amount,
          context, created_at, updated_at, confirmed_at
        )
        VALUES (
          $1, 'confirmed', $2, $3, 8453, $4,
          $5, $6, $7, $8, $9, $10,
          $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $19, $19
        )
        ON CONFLICT (tx_hash)
        DO UPDATE SET
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          confirmed_at = EXCLUDED.confirmed_at
        `,
        [
          act.kind,
          act.txHash,
          act.burnTxHash ?? null,
          act.blockNumber ?? null,
          act.tipper ?? null,
          act.recipient ?? null,
          act.recipientAgentId ?? null,
          act.recipientName ?? null,
          act.recipientIdHash ?? null,
          act.claimTxHash ?? null,
          act.grossAmount ?? null,
          act.netAmount ?? null,
          act.treasuryAmount ?? null,
          act.fromAddr ?? null,
          act.toAddr ?? null,
          act.value ?? null,
          act.burnAmount ?? null,
          act.context ?? null,
          act.createdAt
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded ${AGENTS.length} linked agents and ${ACTIVITIES.length} demo activities.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

seed()
  .then(async () => {
    await pool.end().catch(() => {});
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
