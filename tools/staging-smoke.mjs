#!/usr/bin/env node
/**
 * Base testnet staging smoke test for CHITIN.
 *
 * Requirements (provided via env):
 * - CHITIN_ORIGIN (e.g. http://127.0.0.1:3000)
 * - CRON_TOKEN
 *
 * This script assumes:
 * - mock-moltbook is running at http://127.0.0.1:8787
 * - web dev server is running and configured to use the mock Moltbook apiBase
 *
 * It uses the real CLI for link/tip, and uses the relayer signer for one transfer test
 * (and may temporarily fund a staging wallet with a tiny amount of testnet ETH for gas).
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import { randomUUID } from 'node:crypto';

const ORIGIN = String(process.env.CHITIN_ORIGIN ?? '').trim();
if (!ORIGIN) throw new Error('Missing env CHITIN_ORIGIN (e.g. http://127.0.0.1:3000)');
const CRON_TOKEN = String(process.env.CRON_TOKEN ?? '').trim();
if (!CRON_TOKEN) throw new Error('Missing env CRON_TOKEN');

const MOCK = 'http://127.0.0.1:8787';
const MOLTX = 'http://127.0.0.1:8788';
// In local Next dev, requests may not have proxy IP headers and the backend will treat IP as "unknown",
// causing all local calls to share one rate-limit bucket. Use a stable per-run fake IP for backend calls
// that we make directly from this script (link submit / transfer submit / cron), without touching prod code.
const TEST_IP = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function jget(url, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      // Avoid flaky keep-alive reuse against dev servers (undici can surface as a generic "fetch failed").
      headers: { Connection: 'close', 'x-vercel-forwarded-for': TEST_IP, ...extraHeaders }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`GET ${url} -> fetch_failed: ${msg}`);
  }
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`GET ${url} -> ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${txt.slice(0, 200)}`);
  return json;
}

async function jpost(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Connection: 'close', 'Content-Type': 'application/json', 'x-vercel-forwarded-for': TEST_IP },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`POST ${url} -> fetch_failed: ${msg}`);
  }
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`POST ${url} -> ${res.status}: ${txt.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${txt.slice(0, 200)}`);
  return json;
}

function runCli(args, env) {
  const cli = path.join(process.cwd(), 'packages', 'cli', 'dist', 'chitin.cjs');
  const r = spawnSync('node', [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    throw new Error(`CLI failed: node ${cli} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

function extractJsonFromStdout(stdout) {
  // CLI prints JSON to stdout for most actions (payloads). If extra lines exist, take last JSON-ish chunk.
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith('{') && l.endsWith('}')) return JSON.parse(l);
  }
  return JSON.parse(stdout);
}

function loadWalletFile(walletPath) {
  const raw = JSON.parse(readFileSync(walletPath, 'utf8'));
  const pk = String(raw?.privateKey ?? '');
  const addr = String(raw?.address ?? '');
  if (!pk.startsWith('0x') || !addr.startsWith('0x')) {
    throw new Error('Invalid wallet file: ' + walletPath);
  }
  return { privateKey: pk, address: addr };
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const h = await jget(ORIGIN + '/api/health');
      if (h?.success) return;
    } catch {
      // ignore
    }
    await sleep(500);
  }
  throw new Error('Backend did not become healthy at ' + ORIGIN);
}

async function main() {
  const testDir = path.join(process.cwd(), 'tools', '.staging');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  // Best-effort ETH sweeping:
  // If we fund staging wallets with testnet ETH for gas, try to sweep back dust at the end so the deployer/relayer
  // wallet doesn't "lose" faucet funds when the script exits early.
  const sweepWalletFiles = [];
  let sweepProvider = null;
  let sweepFunder = null;

  async function sweepBackIfPossible() {
    if (!sweepProvider || !sweepFunder) return;
    if (sweepWalletFiles.length === 0) return;

    const fee = await sweepProvider.getFeeData();
    const gasLimit = 21000n;
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;
    if (!maxFeePerGas) return;

    const keep = ethers.parseEther('0.00000005');
    const gasCost = gasLimit * maxFeePerGas;

    for (const walletPath of sweepWalletFiles) {
      try {
        const wf = loadWalletFile(walletPath);
        const signer = new ethers.Wallet(wf.privateKey, sweepProvider);
        const bal = await sweepProvider.getBalance(wf.address);
        if (bal <= gasCost + keep) continue;
        const value = bal - gasCost - keep;
        const tx = await signer.sendTransaction({
          to: await sweepFunder.getAddress(),
          value,
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas
        });
        await tx.wait();
      } catch {
        // best-effort
      }
    }
  }

  try {
  // Ensure servers are up.
  await jget(MOCK + '/__mock/health');
  await jget(MOLTX + '/__mock/health');
  await waitHealthy();

  // Defensive: ensure the backend is configured to use the local mocks (so this test is fully offline).
  const cfg = await jget(ORIGIN + '/api/config');
  const moltbookBase = String(cfg?.data?.moltbook?.apiBase ?? '');
  const moltxBase = String(cfg?.data?.moltx?.apiBase ?? '');
  if (!moltbookBase.includes('127.0.0.1:8787')) {
    throw new Error(`Backend is not using mock Moltbook (expected 127.0.0.1:8787): ${moltbookBase}`);
  }
  if (!moltxBase.includes('127.0.0.1:8788')) {
    throw new Error(`Backend is not using mock Moltx (expected 127.0.0.1:8788): ${moltxBase}`);
  }

  // Reset mock state and seed three agents.
  await jpost(MOCK + '/__mock/reset', {});
  await jpost(MOLTX + '/__mock/reset', {});
  // Use unique identities each run so the staging DB can keep previous runs without collisions.
  const suffix = Date.now().toString(36);
  const aliceName = `alice${suffix}`;
  const bobName = `bob${suffix}`;
  const charlieName = `charlie${suffix}`;

  const aliceId = randomUUID();
  const bobId = randomUUID();
  const charlieId = randomUUID();

  await jpost(MOCK + '/__mock/agent', { id: aliceId, name: aliceName });
  await jpost(MOCK + '/__mock/agent', { id: bobId, name: bobName });
  await jpost(MOCK + '/__mock/agent', { id: charlieId, name: charlieName });

  // Create wallets for Alice/Bob/Charlie using CLI, but keep files local to repo.
  const aliceWallet = path.join(testDir, 'alice.wallet.json');
  const bobWallet = path.join(testDir, 'bob.wallet.json');
  const charlieWallet = path.join(testDir, 'charlie.wallet.json');
  const aliceCfg = path.join(testDir, 'alice.config.json');
  const bobCfg = path.join(testDir, 'bob.config.json');
  const charlieCfg = path.join(testDir, 'charlie.config.json');

  runCli(['wallet:create', '--out', aliceWallet], {});
  runCli(['wallet:create', '--out', bobWallet], {});
  runCli(['wallet:create', '--out', charlieWallet], {});

  // Link Alice + Bob (Charlie stays unlinked for reserve test).
  const alicePayloadOut = runCli(['link:payload', '--moltbook-name', aliceName, '--wallet', aliceWallet, '--config', aliceCfg], {
    CHITIN_ORIGIN: ORIGIN
  });
  const alicePayload = extractJsonFromStdout(alicePayloadOut);
  const alicePost = await jpost(MOCK + '/__mock/post', {
    id: randomUUID(),
    authorName: aliceName,
    submolt: 'chitin',
    content: '```json\n' + JSON.stringify(alicePayload) + '\n```'
  });
  await jpost(ORIGIN + '/api/link/submit', { postId: alicePost.post.id });

  const bobPayloadOut = runCli(['link:payload', '--moltbook-name', bobName, '--wallet', bobWallet, '--config', bobCfg], {
    CHITIN_ORIGIN: ORIGIN
  });
  const bobPayload = extractJsonFromStdout(bobPayloadOut);
  const bobPost = await jpost(MOCK + '/__mock/post', {
    id: randomUUID(),
    authorName: bobName,
    submolt: 'chitin',
    content: '```json\n' + JSON.stringify(bobPayload) + '\n```'
  });
  await jpost(ORIGIN + '/api/link/submit', { postId: bobPost.post.id });

  // Create a Moltbook post authored by Bob so we can tip by context URL (source plugin path).
  const bobMoltbookPost = await jpost(MOCK + '/__mock/post', {
    id: randomUUID(),
    authorName: bobName,
    submolt: 'general',
    content: 'A Moltbook post from Bob'
  });
  const bobMoltbookUrl = `https://www.moltbook.com/post/${bobMoltbookPost.post.id}`;

  // Moltx alias proof: map a Moltx author_id -> Bob's canonical Moltbook identity.
  const bobMoltxId = randomUUID();
  const aliasPayloadOut = runCli(['alias:payload', '--moltbook-name', bobName, '--wallet', bobWallet, '--config', bobCfg], {
    CHITIN_ORIGIN: ORIGIN
  });
  const aliasPayload = extractJsonFromStdout(aliasPayloadOut);
  const aliasPostId = randomUUID();
  await jpost(MOLTX + '/__mock/post', {
    id: aliasPostId,
    author_id: bobMoltxId,
    author_name: bobName,
    content: '```json\n' + JSON.stringify(aliasPayload) + '\n```'
  });
  runCli(['alias:submit', '--proof-url', `https://moltx.io/post/${aliasPostId}`, '--config', bobCfg], { CHITIN_ORIGIN: ORIGIN });

  // Moltx tip by URL: Alice tips a Moltx post authored by Bob (resolved via alias).
  const moltxTipPostId = randomUUID();
  await jpost(MOLTX + '/__mock/post', {
    id: moltxTipPostId,
    author_id: bobMoltxId,
    author_name: bobName,
    content: 'Hello from Moltx'
  });
  const tipMoltx = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-url',
        `https://moltx.io/post/${moltxTipPostId}`,
        '--amount',
        '3',
        '--context',
        `https://moltx.io/post/${moltxTipPostId}`,
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tipMoltx?.txHash) throw new Error('missing moltx tip txHash');

  // TIP_MINT: Alice tips Bob.
  const tip1 = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-name',
        bobName,
        '--amount',
        '10',
        '--context',
        bobMoltbookUrl,
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tip1?.txHash) throw new Error('missing tip txHash');

  // TIP_MINT (small) + via context source: tip by Moltbook post URL (host is moltbook.com but data resolves from local mock apiBase).
  const tipSmall = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-url',
        bobMoltbookUrl,
        '--amount',
        '0.1',
        '--context',
        bobMoltbookUrl,
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tipSmall?.txHash) throw new Error('missing tipSmall txHash');

  // TIP_MINT (large) to exercise caps while staying under per-agent cap.
  const tipLarge = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-name',
        bobName,
        '--amount',
        '1500',
        '--context',
        bobMoltbookUrl,
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tipLarge?.txHash) throw new Error('missing tipLarge txHash');

  // TIP_RESERVE: Alice tips unlinked Charlie.
  const tip2 = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-name',
        charlieName,
        '--amount',
        '7',
        '--context',
        'https://www.moltbook.com/post/' + randomUUID(),
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tip2?.txHash) throw new Error('missing reserve tip txHash');

  // Reconcile pending so UI/DB updates.
  await jget(ORIGIN + '/api/cron/reconcile?limit=200', { Authorization: `Bearer ${CRON_TOKEN}` });

  // Now link Charlie; backend should best-effort claim.
  const cPayloadOut = runCli(['link:payload', '--moltbook-name', charlieName, '--wallet', charlieWallet, '--config', charlieCfg], {
    CHITIN_ORIGIN: ORIGIN
  });
  const cPayload = extractJsonFromStdout(cPayloadOut);
  const cPost = await jpost(MOCK + '/__mock/post', {
    id: randomUUID(),
    authorName: charlieName,
    submolt: 'chitin',
    content: '```json\n' + JSON.stringify(cPayload) + '\n```'
  });
  await jpost(ORIGIN + '/api/link/submit', { postId: cPost.post.id });

  // Reconcile again to confirm claim tx and finalize activities.
  await jget(ORIGIN + '/api/cron/reconcile?limit=200', { Authorization: `Bearer ${CRON_TOKEN}` });

  // Create an UNPAID PAY example with a different agent than the taxed payer:
  // - tip Charlie enough so Charlie can transfer a larger amount
  // - fund Charlie with a tiny amount of ETH for gas
  // - Charlie transfers without burning (tax unpaid) so credibility decreases from base.
  const tipCharlie = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-name',
        charlieName,
        '--amount',
        '100',
        '--context',
        bobMoltbookUrl,
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tipCharlie?.txHash) throw new Error('missing tipCharlie txHash');

  // PAY + TRANSFER tests:
  // - Bob received CHITIN via tips.
  // - We send a tiny amount of Base Sepolia ETH to Bob so Bob can pay gas.
  // - Bob performs:
  //   - PAY (transfer + burn) -> should show "tax paid"
  //
  // We prefer funding via deployer (as requested); fall back to relayer if deployer is missing.
  const deployerPk = String(process.env.DEPLOYER_PRIVATE_KEY ?? '').trim();
  const relayerPk = String(process.env.RELAYER_PRIVATE_KEY ?? '').trim();
  if (!deployerPk && !relayerPk) throw new Error('Missing DEPLOYER_PRIVATE_KEY (preferred) and RELAYER_PRIVATE_KEY (fallback) for gas funding');
  const provider = new ethers.JsonRpcProvider(String(process.env.BASE_RPC_URL ?? '').trim());
  const funderWallet = new ethers.Wallet((deployerPk || relayerPk), provider);
  sweepProvider = provider;
  sweepFunder = funderWallet;

  // Fund Bob with gas (tiny amount) so Bob can pay for the transfer.
  const fundTx = await funderWallet.sendTransaction({
    to: bobPayload.address,
    value: ethers.parseEther('0.000001')
  });
  await fundTx.wait();
  sweepWalletFiles.push(bobWallet);

  // Fund Charlie with gas for an unpaid transfer.
  const fundTx2 = await funderWallet.sendTransaction({
    to: cPayload.address,
    value: ethers.parseEther('0.000001')
  });
  await fundTx2.wait();
  sweepWalletFiles.push(charlieWallet);

  const pay1 = extractJsonFromStdout(
    runCli(
      [
        'pay:send',
        '--to-name',
        aliceName,
        '--gross-amount',
        '20',
        '--context',
        bobMoltbookUrl,
        '--submit',
        '--wallet',
        bobWallet,
        '--config',
        bobCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!pay1?.txHash) throw new Error('missing pay txHash');

  // Charlie transfers without burning (tax unpaid).
  const transferUnpaid = extractJsonFromStdout(
    runCli(
      [
        'transfer:send',
        '--to-name',
        aliceName,
        '--amount',
        '50',
        '--context',
        bobMoltbookUrl,
        '--submit',
        '--wallet',
        charlieWallet,
        '--config',
        charlieCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!transferUnpaid?.txHash) throw new Error('missing transferUnpaid txHash');

  // Confirm the transfer activity.
  for (let i = 0; i < 5; i++) {
    await jget(ORIGIN + '/api/cron/reconcile?limit=200', { Authorization: `Bearer ${CRON_TOKEN}` });
    await sleep(1500);
  }

  // Wallet rotation: rotate Bob to a new wallet and verify new tips mint to the new wallet.
  const bobWallet2 = path.join(testDir, 'bob2.wallet.json');
  runCli(['wallet:create', '--out', bobWallet2], {});
  const rotateOut = runCli(
    [
      'link:rotate-payload',
      '--moltbook-name',
      bobName,
      '--old-wallet',
      bobWallet,
      '--new-wallet',
      bobWallet2
    ],
    { CHITIN_ORIGIN: ORIGIN }
  );
  const rotatePayload = extractJsonFromStdout(rotateOut);
  const rPost = await jpost(MOCK + '/__mock/post', {
    id: randomUUID(),
    authorName: bobName,
    submolt: 'chitin',
    content: '```json\n' + JSON.stringify(rotatePayload) + '\n```'
  });
  await jpost(ORIGIN + '/api/link/submit', { postId: rPost.post.id });

  // Tip Bob again; should mint to Bob's new linked wallet.
  const tipAfterRotate = extractJsonFromStdout(
    runCli(
      [
        'tip:send',
        '--to-name',
        bobName,
        '--amount',
        '5',
        '--context',
        bobMoltbookUrl,
        '--wallet',
        aliceWallet,
        '--config',
        aliceCfg
      ],
      { CHITIN_ORIGIN: ORIGIN }
    )
  );
  if (!tipAfterRotate?.txHash) throw new Error('missing tipAfterRotate txHash');

  await jget(ORIGIN + '/api/cron/reconcile?limit=200', { Authorization: `Bearer ${CRON_TOKEN}` });

  // Basic metrics check.
  const metrics = await jget(ORIGIN + '/api/metrics');
  if (!metrics?.success) throw new Error('metrics failed');

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        tipMintTx: tip1.txHash,
        tipSmallTx: tipSmall.txHash,
        tipLargeTx: tipLarge.txHash,
        tipReserveTx: tip2.txHash,
        tipCharlieTx: tipCharlie.txHash,
        payTx: pay1.txHash,
        payBurnTx: pay1.burnTxHash ?? null,
        unpaidTransferTx: transferUnpaid.txHash,
        tipAfterRotateTx: tipAfterRotate.txHash,
        metrics: metrics.metrics
      },
      null,
      2
    ) + '\n'
  );
  } finally {
    await sweepBackIfPossible();
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
