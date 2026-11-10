import { dbQuery } from '@/server/db';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';
import { chitinInterface } from '@/server/chitin-abi';

export type ReconcileResult = {
  checked: number;
  confirmed: number;
  failed: number;
  stillPending: number;
};

type PendingRow = {
  id: number;
  kind: 'tip' | 'tip_mint' | 'tip_reserve' | 'claim' | 'pay' | 'transfer';
  tx_hash: string;
  burn_tx_hash?: string | null;
};

export async function cleanupOldPendingActivities(maxAgeSeconds: number): Promise<{ deleted: number }> {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('pending_cleanup_age_invalid');
  }

  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  const rows = await dbQuery<{ deleted: number }>(
    `
    WITH deleted AS (
      DELETE FROM activities
      WHERE status='pending' AND created_at < $1::timestamptz
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted FROM deleted
    `,
    [cutoff]
  );

  return { deleted: rows[0]?.deleted ?? 0 };
}

async function isLinkedAddress(address: string): Promise<boolean> {
  const rows = await dbQuery<{ cnt: number }>(
    `
    SELECT COUNT(*)::int AS cnt
    FROM (
      SELECT 1
      FROM agent_wallets
      WHERE lower(address)=lower($1)
      UNION ALL
      SELECT 1
      FROM agent_wallet_events
      WHERE lower(new_address)=lower($1)
         OR (old_address IS NOT NULL AND lower(old_address)=lower($1))
    ) x
    `,
    [address]
  );
  return (rows[0]?.cnt ?? 0) > 0;
}

export async function reconcilePending(limit: number): Promise<ReconcileResult> {
  const rows = await dbQuery<PendingRow>(
    `
    SELECT id, kind, tx_hash, burn_tx_hash
    FROM activities
    WHERE status='pending'
    ORDER BY created_at ASC
    LIMIT $1
    `,
    [limit]
  );

  const provider = getBaseProvider();
  const contractAddress = getChitinContractAddress().toLowerCase();
  const network = await provider.getNetwork();

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  const tipEvent = chitinInterface.getEvent('TipMint');
  const tipReserveEvent = chitinInterface.getEvent('TipReserved');
  const claimEvent = chitinInterface.getEvent('Claimed');
  const transferEvent = chitinInterface.getEvent('Transfer');
  if (!tipEvent || !tipReserveEvent || !claimEvent || !transferEvent) throw new Error('Missing CHITIN event ABI');

  for (const row of rows) {
    const receipt = await provider.getTransactionReceipt(row.tx_hash);

    if (!receipt) {
      stillPending++;
      continue;
    }

    if (receipt.status !== 1) {
      await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'tx_failed']);
      failed++;
      continue;
    }

    const logs = receipt.logs.filter((l) => l.address.toLowerCase() === contractAddress);

    if (row.kind === 'tip') {
      const mintLog = logs.find((l) => l.topics[0] === tipEvent.topicHash);
      const reserveLog = logs.find((l) => l.topics[0] === tipReserveEvent.topicHash);

      // Exactly one should exist, but handle ambiguity defensively.
      if (mintLog && reserveLog) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
          row.id,
          'ambiguous_tip_logs'
        ]);
        failed++;
        continue;
      }

      if (mintLog) {
        const ev = chitinInterface.parseLog(mintLog);
        if (!ev) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'parse_failed'
          ]);
          failed++;
          continue;
        }

        const tipper = String(ev.args.tipper);
        const recipient = String(ev.args.recipient);

        // Only keep agent-to-agent tips.
        if (!(await isLinkedAddress(tipper)) || !(await isLinkedAddress(recipient))) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'not_agent_to_agent'
          ]);
          failed++;
          continue;
        }

        await dbQuery(
          `
          UPDATE activities
          SET
            kind='tip_mint',
            status='confirmed',
            chain_id=$2,
            block_number=$3,
            log_index=$4,
            tipper=$5,
            recipient=$6,
            gross_amount=$7,
            net_amount=$8,
            treasury_amount=$9,
            context_hash=$10,
            confirmed_at=now(),
            updated_at=now(),
            error=NULL
          WHERE id=$1
          `,
          [
            row.id,
            network.chainId.toString(),
            receipt.blockNumber,
            mintLog.index,
            tipper,
            recipient,
            (ev.args.grossAmount as bigint).toString(),
            (ev.args.netAmount as bigint).toString(),
            (ev.args.treasuryAmount as bigint).toString(),
            String(ev.args.contextHash)
          ]
        );

        confirmed++;
        continue;
      }

      if (reserveLog) {
        const ev = chitinInterface.parseLog(reserveLog);
        if (!ev) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'parse_failed'
          ]);
          failed++;
          continue;
        }

        const tipper = String(ev.args.tipper);
        const recipientIdHash = String(ev.args.recipientIdHash);

        // Only keep tips from linked agents (recipient may not be linked yet).
        if (!(await isLinkedAddress(tipper))) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'tipper_not_linked'
          ]);
          failed++;
          continue;
        }

        // Ensure the stored recipient id hash matches the onchain log.
        const stored = await dbQuery<{ recipient_id_hash: string | null }>(
          `SELECT recipient_id_hash FROM activities WHERE id=$1 LIMIT 1`,
          [row.id]
        );
        const storedHash = (stored[0]?.recipient_id_hash ?? '').toLowerCase();
        if (!storedHash || storedHash !== recipientIdHash.toLowerCase()) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'recipient_id_hash_mismatch'
          ]);
          failed++;
          continue;
        }

        await dbQuery(
          `
          UPDATE activities
          SET
            kind='tip_reserve',
            status='confirmed',
            chain_id=$2,
            block_number=$3,
            log_index=$4,
            tipper=$5,
            gross_amount=$6,
            net_amount=$7,
            treasury_amount=$8,
            context_hash=$9,
            confirmed_at=now(),
            updated_at=now(),
            error=NULL
          WHERE id=$1
          `,
          [
            row.id,
            network.chainId.toString(),
            receipt.blockNumber,
            reserveLog.index,
            tipper,
            (ev.args.grossAmount as bigint).toString(),
            (ev.args.netAmount as bigint).toString(),
            (ev.args.treasuryAmount as bigint).toString(),
            String(ev.args.contextHash)
          ]
        );

        // If a claim already happened after this reserve tx, stitch it in.
        const stitched = await dbQuery<{ tx_hash: string; confirmed_at: string | null }>(
          `
          SELECT tx_hash, confirmed_at
          FROM activities
          WHERE kind='claim' AND status='confirmed' AND recipient_id_hash=$1 AND block_number >= $2
          ORDER BY block_number ASC
          LIMIT 1
          `,
          [recipientIdHash, receipt.blockNumber]
        );
        if (stitched[0]?.tx_hash) {
          await dbQuery(
            `
            UPDATE activities
            SET claim_tx_hash=$2, claimed_at=COALESCE($3::timestamptz, now()), updated_at=now()
            WHERE id=$1 AND claim_tx_hash IS NULL
            `,
            [row.id, stitched[0].tx_hash, stitched[0].confirmed_at]
          );
        }

        confirmed++;
        continue;
      }

      await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
        row.id,
        'no_tip_log'
      ]);
      failed++;
      continue;
    }

    if (row.kind === 'tip_mint') {
      const log = logs.find((l) => l.topics[0] === tipEvent.topicHash);
      if (!log) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'no_tipmint_log']);
        failed++;
        continue;
      }

      const ev = chitinInterface.parseLog(log);
      if (!ev) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'parse_failed']);
        failed++;
        continue;
      }

      const tipper = String(ev.args.tipper);
      const recipient = String(ev.args.recipient);

      // Only keep agent-to-agent tips.
      if (!(await isLinkedAddress(tipper)) || !(await isLinkedAddress(recipient))) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'not_agent_to_agent']);
        failed++;
        continue;
      }

      await dbQuery(
        `
        UPDATE activities
        SET
          status='confirmed',
          chain_id=$2,
          block_number=$3,
          log_index=$4,
          tipper=$5,
          recipient=$6,
          gross_amount=$7,
          net_amount=$8,
          treasury_amount=$9,
          context_hash=$10,
          confirmed_at=now(),
          updated_at=now(),
          error=NULL
        WHERE id=$1
        `,
        [
          row.id,
          network.chainId.toString(),
          receipt.blockNumber,
          log.index,
          tipper,
          recipient,
          (ev.args.grossAmount as bigint).toString(),
          (ev.args.netAmount as bigint).toString(),
          (ev.args.treasuryAmount as bigint).toString(),
          String(ev.args.contextHash)
        ]
      );

      confirmed++;
      continue;
    }

    if (row.kind === 'tip_reserve') {
      const log = logs.find((l) => l.topics[0] === tipReserveEvent.topicHash);
      if (!log) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'no_tipreserved_log']);
        failed++;
        continue;
      }

      const ev = chitinInterface.parseLog(log);
      if (!ev) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'parse_failed']);
        failed++;
        continue;
      }

      const tipper = String(ev.args.tipper);
      const recipientIdHash = String(ev.args.recipientIdHash);

      // Only keep tips from linked agents (recipient may not be linked yet).
      if (!(await isLinkedAddress(tipper))) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'tipper_not_linked']);
        failed++;
        continue;
      }

      // Ensure the stored recipient id hash matches the onchain log.
      const stored = await dbQuery<{ recipient_id_hash: string | null }>(
        `SELECT recipient_id_hash FROM activities WHERE id=$1 LIMIT 1`,
        [row.id]
      );
      const storedHash = (stored[0]?.recipient_id_hash ?? '').toLowerCase();
      if (!storedHash || storedHash !== recipientIdHash.toLowerCase()) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'recipient_id_hash_mismatch']);
        failed++;
        continue;
      }

      await dbQuery(
        `
        UPDATE activities
        SET
          status='confirmed',
          chain_id=$2,
          block_number=$3,
          log_index=$4,
          tipper=$5,
          gross_amount=$6,
          net_amount=$7,
          treasury_amount=$8,
          context_hash=$9,
          confirmed_at=now(),
          updated_at=now(),
          error=NULL
        WHERE id=$1
        `,
        [
          row.id,
          network.chainId.toString(),
          receipt.blockNumber,
          log.index,
          tipper,
          (ev.args.grossAmount as bigint).toString(),
          (ev.args.netAmount as bigint).toString(),
          (ev.args.treasuryAmount as bigint).toString(),
          String(ev.args.contextHash)
        ]
      );

      // If a claim already happened after this reserve tx, stitch it in.
      const stitched = await dbQuery<{ tx_hash: string; confirmed_at: string | null }>(
        `
        SELECT tx_hash, confirmed_at
        FROM activities
        WHERE kind='claim' AND status='confirmed' AND recipient_id_hash=$1 AND block_number >= $2
        ORDER BY block_number ASC
        LIMIT 1
        `,
        [recipientIdHash, receipt.blockNumber]
      );
      if (stitched[0]?.tx_hash) {
        await dbQuery(
          `
          UPDATE activities
          SET claim_tx_hash=$2, claimed_at=COALESCE($3::timestamptz, now()), updated_at=now()
          WHERE id=$1 AND claim_tx_hash IS NULL
          `,
          [row.id, stitched[0].tx_hash, stitched[0].confirmed_at]
        );
      }

      confirmed++;
      continue;
    }

    if (row.kind === 'claim') {
      const log = logs.find((l) => l.topics[0] === claimEvent.topicHash);
      if (!log) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'no_claimed_log']);
        failed++;
        continue;
      }

      const ev = chitinInterface.parseLog(log);
      if (!ev) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'parse_failed']);
        failed++;
        continue;
      }

      const recipientIdHash = String(ev.args.recipientIdHash);
      const recipient = String(ev.args.recipient);

      if (!(await isLinkedAddress(recipient))) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'recipient_not_linked']);
        failed++;
        continue;
      }

      await dbQuery(
        `
        UPDATE activities
        SET
          status='confirmed',
          chain_id=$2,
          block_number=$3,
          log_index=$4,
          recipient=$5,
          recipient_id_hash=$6,
          net_amount=$7,
          confirmed_at=now(),
          updated_at=now(),
          error=NULL
        WHERE id=$1
        `,
        [
          row.id,
          network.chainId.toString(),
          receipt.blockNumber,
          log.index,
          recipient,
          recipientIdHash,
          (ev.args.amount as bigint).toString()
        ]
      );

      // Mark all reserves up to this claim as claimed.
      await dbQuery(
        `
        UPDATE activities
        SET claim_tx_hash=$2, claimed_at=now(), updated_at=now()
        WHERE kind='tip_reserve'
          AND status='confirmed'
          AND recipient_id_hash=$1
          AND claim_tx_hash IS NULL
          AND block_number <= $3
        `,
        [recipientIdHash, row.tx_hash, receipt.blockNumber]
      );

      confirmed++;
      continue;
    }

    if (row.kind === 'pay') {
      const burnTxHash = String(row.burn_tx_hash ?? '').trim();

      const transferLog = logs.find((l) => l.topics[0] === transferEvent.topicHash);
      if (!transferLog) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'no_transfer_log']);
        failed++;
        continue;
      }
      const tev = chitinInterface.parseLog(transferLog);
      if (!tev) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'parse_failed']);
        failed++;
        continue;
      }

      const from = String(tev.args.from);
      const to = String(tev.args.to);
      const net = BigInt((tev.args.value as bigint).toString());

      // If there is a burn tx hash, verify it and compute burn amount; otherwise this is "tax unpaid".
      let burnAmt: bigint | null = null;
      if (burnTxHash) {
        const burnReceipt = await provider.getTransactionReceipt(burnTxHash);
        if (!burnReceipt) {
          stillPending++;
          continue;
        }
        if (burnReceipt.status !== 1) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'burn_tx_failed'
          ]);
          failed++;
          continue;
        }

        // Parse burn amount from burn receipt via Transfer(from -> 0x0).
        const burnLogs = burnReceipt.logs.filter((l) => l.address.toLowerCase() === contractAddress);
        let burnFrom = '';
        let burnTo = '';
        let burnVal = BigInt(0);
        for (const l of burnLogs) {
          if (l.topics[0] !== transferEvent.topicHash) continue;
          const ev = chitinInterface.parseLog(l);
          if (!ev) continue;
          const to0 = String(ev.args.to).toLowerCase() === '0x0000000000000000000000000000000000000000';
          if (!to0) continue;
          burnFrom = String(ev.args.from);
          burnTo = String(ev.args.to);
          burnVal = BigInt((ev.args.value as bigint).toString());
          break;
        }

        if (!burnFrom || !burnTo) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'no_burn_transfer_to_zero'
          ]);
          failed++;
          continue;
        }
        if (burnFrom.toLowerCase() !== from.toLowerCase()) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'burn_sender_mismatch'
          ]);
          failed++;
          continue;
        }
        if (burnVal <= BigInt(0)) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'burn_amount_zero'
          ]);
          failed++;
          continue;
        }

        // Enforce the social rule for "pay": burn is exactly floor(2.5% of gross).
        const gross = net + burnVal;
        const expectedBurn = (gross * BigInt(250)) / BigInt(10_000);
        if (expectedBurn !== burnVal) {
          await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
            row.id,
            'burn_ratio_mismatch'
          ]);
          failed++;
          continue;
        }

        burnAmt = burnVal;
      }

      if (!(await isLinkedAddress(from)) || !(await isLinkedAddress(to))) {
        await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'not_agent_to_agent']);
        failed++;
        continue;
      }

      const grossStr = burnAmt ? (net + burnAmt).toString() : null;
      const burnStr = burnAmt ? burnAmt.toString() : null;
      await dbQuery(
        `
        UPDATE activities
        SET
          status='confirmed',
          chain_id=$2,
          block_number=$3,
          log_index=$4,
          from_addr=$5,
          to_addr=$6,
          value=$7,
          gross_amount=COALESCE($8, gross_amount),
          burn_amount=COALESCE($9, burn_amount),
          confirmed_at=now(),
          updated_at=now(),
          error=NULL
        WHERE id=$1
        `,
        [
          row.id,
          network.chainId.toString(),
          receipt.blockNumber,
          transferLog.index,
          from,
          to,
          net.toString(),
          grossStr,
          burnStr
        ]
      );

      confirmed++;
      continue;
    }

    if (row.kind !== 'transfer') {
      await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [
        row.id,
        'unknown_kind'
      ]);
      failed++;
      continue;
    }

    const transferLog = logs.find((l) => l.topics[0] === transferEvent.topicHash);
    if (!transferLog) {
      await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'no_transfer_log']);
      failed++;
      continue;
    }

    const tev = chitinInterface.parseLog(transferLog);
    if (!tev) {
      await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'parse_failed']);
      failed++;
      continue;
    }

    const from = String(tev.args.from);
    const to = String(tev.args.to);

    if (!(await isLinkedAddress(from)) || !(await isLinkedAddress(to))) {
      await dbQuery(`UPDATE activities SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [row.id, 'not_agent_to_agent']);
      failed++;
      continue;
    }

    await dbQuery(
      `
      UPDATE activities
      SET
        status='confirmed',
        chain_id=$2,
        block_number=$3,
        log_index=$4,
        from_addr=$5,
        to_addr=$6,
        value=$7,
        confirmed_at=now(),
        updated_at=now(),
        error=NULL
      WHERE id=$1
      `,
      [
        row.id,
        network.chainId.toString(),
        receipt.blockNumber,
        transferLog.index,
        from,
        to,
        (tev.args.value as bigint).toString()
      ]
    );

    confirmed++;
  }

  return { checked: rows.length, confirmed, failed, stillPending };
}
