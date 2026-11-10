#!/usr/bin/env node

import { Command } from 'commander';
import { z } from 'zod';
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ethers,
  keccak256,
  parseUnits,
  toUtf8Bytes
} from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const program = new Command();

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'chitin', 'config.json');
const DEFAULT_WALLET_PATH = path.join(os.homedir(), '.config', 'chitin', 'wallet.json');

const ConfigSchema = z
  .object({
    rpcUrl: z.string().min(1).optional(),
    contractAddress: z.string().startsWith('0x').optional(),
    apiBase: z.string().min(1).optional(),
    walletPath: z.string().min(1).optional()
  })
  .strict();

type ChitinConfig = z.infer<typeof ConfigSchema>;

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function chmod600IfPossible(p: string) {
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort
  }
}

function readJsonFile(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p: string, obj: unknown) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  chmod600IfPossible(p);
}

function loadConfig(configPath: string): ChitinConfig {
  if (!fs.existsSync(configPath)) return {};
  return ConfigSchema.parse(readJsonFile(configPath));
}

const WalletFileSchema = z
  .object({
    address: z.string().startsWith('0x'),
    privateKey: z.string().startsWith('0x'),
    createdAt: z.string()
  })
  .strict();

function loadWallet(walletPath: string): Wallet {
  const parsed = WalletFileSchema.parse(readJsonFile(walletPath));
  return new Wallet(parsed.privateKey);
}

function resolveConfig(opts: { config?: string; wallet?: string }): {
  configPath: string;
  config: ChitinConfig;
  walletPath: string;
} {
  const configPath = path.resolve(opts.config ?? DEFAULT_CONFIG_PATH);
  const config = loadConfig(configPath);

  const walletPath = path.resolve(opts.wallet ?? config.walletPath ?? DEFAULT_WALLET_PATH);

  return { configPath, config, walletPath };
}

function normalizeApiBase(apiBase: string): string {
  // Accept both https://host and https://host/ ; always return no trailing slash.
  return apiBase.replace(/\/+$/, '');
}

function envApiBase(): string {
  // Skill docs use CHITIN_ORIGIN to mean "the host that served this skill/CLI".
  // We accept either to reduce friction.
  return String(process.env.CHITIN_ORIGIN ?? process.env.CHITIN_API_BASE ?? '').trim();
}

async function ensureRemoteConfig(params: {
  configPath: string;
  config: ChitinConfig;
  apiBase?: string;
}): Promise<ChitinConfig & { apiBase: string; rpcUrl: string; contractAddress: string }> {
  // Treat empty strings as "not provided" so env/config fallbacks work.
  const apiBase = normalizeApiBase(
    String(
      (params.apiBase && params.apiBase.trim()) ||
        (params.config.apiBase && params.config.apiBase.trim()) ||
        envApiBase() ||
        ''
    )
  );
  const rpcUrl = String(params.config.rpcUrl ?? '').trim();
  const contractAddress = String(params.config.contractAddress ?? '').trim();
  if (rpcUrl && contractAddress) {
    return { ...params.config, apiBase, rpcUrl, contractAddress };
  }

  if (!apiBase) {
    throw new Error('Missing apiBase (set CHITIN_ORIGIN/CHITIN_API_BASE or set apiBase in config.json or pass --api-base)');
  }

  const res = await fetch(apiBase + '/api/config', { method: 'GET' });
  if (!res.ok) throw new Error('Failed to fetch /api/config: ' + res.status);

  const RemoteSchema = z
    .object({
      success: z.boolean(),
      data: z
        .object({
          rpcUrl: z.string().min(1),
          contractAddress: z.string().startsWith('0x')
        })
        .passthrough()
        .optional(),
      error: z.string().optional()
    })
    .passthrough();

  const json = RemoteSchema.parse(await res.json());
  if (!json.success || !json.data) throw new Error(json.error ?? 'CHITIN backend returned success=false');

  const merged = {
    ...params.config,
    apiBase,
    rpcUrl: rpcUrl || json.data.rpcUrl,
    contractAddress: contractAddress || json.data.contractAddress
  };

  // Cache it so future runs are instant (like Moltbook recommends saving credentials).
  writeJson(params.configPath, merged);

  return merged as ChitinConfig & { apiBase: string; rpcUrl: string; contractAddress: string };
}

async function getChainTimestamp(provider: JsonRpcProvider): Promise<number> {
  const b = await provider.getBlock('latest');
  if (!b) throw new Error('Failed to fetch latest block');
  return b.timestamp;
}

program.name('chitin').description('CHITIN CLI (wallet + signatures)').version('0.0.1');

const WALLET_LINK_TYPES = {
  WalletLink: [
    { name: 'agentIdHash', type: 'bytes32' },
    { name: 'oldWallet', type: 'address' },
    { name: 'newWallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
} as const;

async function lookupAgentIdByName(apiBase: string, name: string): Promise<string> {
  const res = await fetch(apiBase + '/api/lookup?name=' + encodeURIComponent(name), { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success || typeof json?.agentId !== 'string') {
    throw new Error(typeof json?.error === 'string' ? json.error : 'Failed to lookup agent id');
  }
  return String(json.agentId);
}

program
  .command('config:show')
  .description('Print resolved config (paths + values).')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet path override')
  .action((opts) => {
    const r = resolveConfig(opts);
    process.stdout.write(
      JSON.stringify(
        {
          configPath: r.configPath,
          config: r.config,
          walletPath: r.walletPath
        },
        null,
        2
      ) + '\n'
    );
  });



program
  .command('config:init')
  .description('Initialize config.json by fetching /api/config from the CHITIN backend (optional; most commands auto-fetch).')
  .requiredOption('--api-base <url>', 'CHITIN API base (e.g. https://chitin.example)')
  .option('-o, --out <path>', 'Config output path', DEFAULT_CONFIG_PATH)
  .action(async (opts) => {
    const outPath = path.resolve(String(opts.out));
    const existing = fs.existsSync(outPath) ? loadConfig(outPath) : {};

    await ensureRemoteConfig({
      configPath: outPath,
      config: existing,
      apiBase: String(opts.apiBase)
    });

    process.stdout.write(outPath + '\n');
  });

program
  .command('wallet:create')
  .description('Create a new local CHITIN wallet (EOA keypair).')
  .option('-o, --out <path>', 'Wallet file path', DEFAULT_WALLET_PATH)
  .action((opts) => {
    const outPath = path.resolve(String(opts.out));
    ensureDir(path.dirname(outPath));

    if (fs.existsSync(outPath)) {
      throw new Error('Wallet already exists at ' + outPath);
    }

    const wallet = Wallet.createRandom();
    writeJson(outPath, {
      address: wallet.address,
      privateKey: wallet.privateKey,
      createdAt: new Date().toISOString()
    });

    process.stdout.write(wallet.address + '\n');
  });

program
  .command('wallet:address')
  .description('Print wallet address.')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .action((opts) => {
    const r = resolveConfig(opts);
    const wallet = loadWallet(r.walletPath);
    process.stdout.write(wallet.address + '\n');
  });

program
  .command('wallet:balances')
  .description('Show Base ETH + CHITIN balances for an address (defaults to local wallet).')
  .option('--address <address>', 'Address to check (defaults to local wallet address)')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (used if rpcUrl/contractAddress are missing)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const addr = String(opts.address ?? (fs.existsSync(r.walletPath) ? loadWallet(r.walletPath).address : '')).trim();
    if (!addr) throw new Error('Missing address (create a wallet first or pass --address)');

    const provider = new JsonRpcProvider(rpcUrl);

    const ethBal = await provider.getBalance(addr);
    const abi = ['function balanceOf(address owner) view returns (uint256)'];
    const token = new Contract(contractAddress, abi, provider);
    const chitinBal = await token.balanceOf(addr);

    process.stdout.write(
      JSON.stringify(
        {
          address: addr,
          ethWei: ethBal.toString(),
          eth: ethers.formatEther(ethBal),
          chitinWei: chitinBal.toString(),
          chitin: ethers.formatUnits(chitinBal, 18)
        },
        null,
        2
      ) + '\n'
    );
  });

program
  .command('agent:lookup')
  .description('Lookup an agent (Moltbook name or a source context URL), including whether they linked a CHITIN wallet.')
  .option('--name <name>', 'Moltbook agent name')
  .option('--context-url <url>', 'Source URL to resolve (e.g. a Moltx post URL)')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const apiBaseRaw = String(opts.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
    if (!apiBaseRaw) throw new Error('Missing apiBase');
    const apiBase = normalizeApiBase(apiBaseRaw);

    const url = new URL(apiBase + '/api/lookup');
    const name = opts.name ? String(opts.name) : '';
    const contextUrl = opts.contextUrl ? String(opts.contextUrl) : '';
    if (!name && !contextUrl) throw new Error('Provide --name or --context-url');
    if (name && contextUrl) throw new Error('Provide only one of --name or --context-url');
    if (name) url.searchParams.set('name', z.string().min(1).parse(name));
    if (contextUrl) url.searchParams.set('contextUrl', z.string().url().parse(contextUrl));

    const res = await fetch(url.toString(), { method: 'GET' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof json?.error === 'string' ? json.error : 'lookup failed';
      throw new Error(err);
    }

    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  });

program
  .command('mint:status')
  .description('Read current mint budgets from chain (uses Base onchain time, not local time).')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (used if rpcUrl/contractAddress are missing)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .option('--tipper <address>', 'Tipper address (defaults to local wallet address)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const provider = new JsonRpcProvider(rpcUrl);

    const abi = [
      'function mintStatus(address tipperWallet) view returns (uint256 day,uint256 epoch,uint256 dayInEpoch,uint256 epochBudget,uint256 epochUnlocked,uint256 epochUsed,uint256 dailyTranche,uint256 effectivePerAgentCap,uint256 globalUsedToday,uint256 tipperUsed,uint256 nextNonce)'
    ];

    const tipper = String(opts.tipper ?? (fs.existsSync(r.walletPath) ? loadWallet(r.walletPath).address : ''));
    if (!tipper) throw new Error('Missing tipper (create a wallet first or pass --tipper)');

    const token = new Contract(contractAddress, abi, provider);
    const status = await token.mintStatus(tipper);

    const day = BigInt(status.day);
    const epoch = BigInt(status.epoch);
    const dayInEpoch = BigInt(status.dayInEpoch);
    const epochBudget = BigInt(status.epochBudget);
    const epochUnlocked = BigInt(status.epochUnlocked);
    const epochUsed = BigInt(status.epochUsed);
    const dailyTranche = BigInt(status.dailyTranche);
    const perCap = BigInt(status.effectivePerAgentCap);
    const globalUsedToday = BigInt(status.globalUsedToday);
    const tipperUsed = BigInt(status.tipperUsed);

    const epochUnlockedRemaining = epochUnlocked > epochUsed ? epochUnlocked - epochUsed : 0n;
    const tipperRemaining = perCap > tipperUsed ? perCap - tipperUsed : 0n;
    const tipperMaxTipNow = epochUnlockedRemaining < tipperRemaining ? epochUnlockedRemaining : tipperRemaining;

    process.stdout.write(
      JSON.stringify(
        {
          day: day.toString(),
          epoch: epoch.toString(),
          dayInEpoch: dayInEpoch.toString(),
          epochBudget: epochBudget.toString(),
          epochUnlocked: epochUnlocked.toString(),
          epochUsed: epochUsed.toString(),
          epochUnlockedRemaining: epochUnlockedRemaining.toString(),
          dailyTranche: dailyTranche.toString(),
          perAgentCap: perCap.toString(),
          tipperUsed: tipperUsed.toString(),
          tipperRemaining: tipperRemaining.toString(),
          tipperMaxTipNow: tipperMaxTipNow.toString(),
          globalUsedToday: globalUsedToday.toString(),
          nextNonce: BigInt(status.nextNonce).toString()
        },
        null,
        2
      ) + '\n'
    );
  });

program
  .command('tip:sign')
  .description('Sign a CHITIN tip (EIP-712) for relayer submission (outputs a JSON body for POST /api/tip).')
  .requiredOption('--to-name <name>', 'Recipient Moltbook name')
  .requiredOption('--recipient-agent-id <uuid>', 'Recipient Moltbook agent id (UUID)')
  .requiredOption('--amount <amount>', 'Gross amount in CHITIN (e.g. 10.5)')
  .requiredOption('--context <string>', 'Moltbook context URL or identifier')
  .requiredOption('--nonce <n>', 'Tipper nonce (use mint:status.nextNonce)')
  .requiredOption('--deadline <unixSeconds>', 'Unix timestamp expiry (seconds)')
  .option('--chain-id <id>', 'EIP-712 chain id', '8453')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (used if contractAddress is missing)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const context = z.string().min(1).parse(String(opts.context));
    const recipientName = z.string().min(1).parse(String(opts.toName));
    const recipientAgentId = z.string().uuid().parse(String(opts.recipientAgentId));
    const recipientIdHash = keccak256(toUtf8Bytes(recipientAgentId));

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    }).catch(() => null);

    const contractAddress = String(opts.contract ?? baseCfg?.contractAddress ?? r.config.contractAddress ?? '').trim();
    if (!contractAddress) throw new Error('Missing contractAddress');

    const wallet = loadWallet(r.walletPath);
    const chainId = z.coerce.number().int().positive().parse(opts.chainId);
    const nonce = BigInt(z.string().regex(/^\d+$/).parse(String(opts.nonce)));
    const deadline = BigInt(z.string().regex(/^\d+$/).parse(String(opts.deadline)));

    const grossAmount = parseUnits(String(opts.amount), 18);
    const contextHash = keccak256(toUtf8Bytes(context));

    const domain = {
      name: 'CHITIN',
      version: '1',
      chainId,
      verifyingContract: contractAddress
    };

    const types = {
      Tip: [
        { name: 'tipper', type: 'address' },
        { name: 'recipientIdHash', type: 'bytes32' },
        { name: 'grossAmount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'contextHash', type: 'bytes32' }
      ]
    };

    const value = {
      tipper: wallet.address,
      recipientIdHash,
      grossAmount,
      nonce,
      deadline,
      contextHash
    };

    const signature = await wallet.signTypedData(domain, types, value);

    process.stdout.write(
      JSON.stringify(
        {
          tipper: wallet.address,
          recipientName,
          recipientAgentId,
          recipientIdHash,
          grossAmount: grossAmount.toString(),
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          context,
          contextHash,
          signature
        },
        null,
        2
      ) + '\n'
    );
  });

program
  .command('tip:send')
  .description('Sign + submit a tip to the relayer (gas paid by relayer). Recipient may be unlinked (reserved + claim later).')
  .option('--to-name <name>', 'Recipient Moltbook name')
  .option('--to-url <url>', 'Recipient context URL (e.g. a Moltx post URL). Resolved via CHITIN sources.')
  .requiredOption('--amount <amount>', 'Gross amount in CHITIN (e.g. 10.5)')
  .requiredOption('--context <string>', 'Moltbook context URL or identifier')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--deadline-seconds <seconds>', 'Signature expiry window (relative to latest block timestamp)', '600')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const context = z.string().min(1).parse(String(opts.context));
    const toUrl = opts.toUrl ? String(opts.toUrl) : '';

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const apiBase = normalizeApiBase(String(opts.apiBase ?? baseCfg.apiBase ?? ''));
    if (!apiBase) throw new Error('Missing apiBase');

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const deadlineSeconds = z.coerce.number().int().positive().parse(opts.deadlineSeconds);

    const wallet = loadWallet(r.walletPath);
    const provider = new JsonRpcProvider(rpcUrl);

    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Preflight: tipper must be linked onchain (prevents relayer spam from random wallets).
    const linkedAbi = ['function agentIdHashByWallet(address wallet) view returns (bytes32)'];
    const linkedReader = new Contract(contractAddress, linkedAbi, provider);
    const tipperAgentIdHash: string = await linkedReader.agentIdHashByWallet(wallet.address);
    if (tipperAgentIdHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      throw new Error('tipper_not_linked');
    }

    const mintAbi = [
      'function mintStatus(address tipperWallet) view returns (uint256 day,uint256 epoch,uint256 dayInEpoch,uint256 epochBudget,uint256 epochUnlocked,uint256 epochUsed,uint256 dailyTranche,uint256 effectivePerAgentCap,uint256 globalUsedToday,uint256 tipperUsed,uint256 nextNonce)'
    ];
    const mintReader = new Contract(contractAddress, mintAbi, provider);
    const status = await mintReader.mintStatus(wallet.address);
    const nonce: bigint = BigInt(status.nextNonce);

    const latestTs = await getChainTimestamp(provider);
    const deadline = BigInt(latestTs + deadlineSeconds);

    const grossAmount = parseUnits(String(opts.amount), 18);

    // Preflight epoch unlock + per-agent daily cap to fail fast before signing/submitting.
    const epochUnlocked = BigInt(status.epochUnlocked);
    const epochUsed = BigInt(status.epochUsed);
    const perCap = BigInt(status.effectivePerAgentCap);
    const tipperUsed = BigInt(status.tipperUsed);

    const epochUnlockedRemaining = epochUnlocked > epochUsed ? epochUnlocked - epochUsed : 0n;
    const tipperRemaining = perCap > tipperUsed ? perCap - tipperUsed : 0n;
    const maxNow = epochUnlockedRemaining < tipperRemaining ? epochUnlockedRemaining : tipperRemaining;
    if (grossAmount > maxNow) {
      throw new Error('tip_amount_exceeds_current_budget (use mint:status)');
    }

    const contextHash = keccak256(toUtf8Bytes(context));

    const domain = {
      name: 'CHITIN',
      version: '1',
      chainId,
      verifyingContract: contractAddress
    };

    // Resolve recipient identity (agent id) via CHITIN so we can sign the correct recipientIdHash.
    const lookupUrl = new URL(apiBase + '/api/lookup');
    if (toUrl) {
      lookupUrl.searchParams.set('contextUrl', toUrl);
    } else {
      const recipientName = z.string().min(1).parse(String(opts.toName ?? ''));
      lookupUrl.searchParams.set('name', recipientName);
    }
    const lookupRes = await fetch(lookupUrl.toString(), { method: 'GET' });
    const lookupJson = await lookupRes.json().catch(() => ({}));
    if (!lookupRes.ok || !lookupJson?.success) {
      const err = typeof lookupJson?.error === 'string' ? lookupJson.error : 'lookup failed';
      throw new Error(err);
    }

    const recipientAgentId = z.string().uuid().parse(String(lookupJson.agentId));
    const recipientName = z.string().min(1).parse(String(lookupJson.name ?? lookupJson.agentId));
    const recipientIdHash = keccak256(toUtf8Bytes(recipientAgentId));

    const types = {
      Tip: [
        { name: 'tipper', type: 'address' },
        { name: 'recipientIdHash', type: 'bytes32' },
        { name: 'grossAmount', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'contextHash', type: 'bytes32' }
      ]
    };

    const value = {
      tipper: wallet.address,
      recipientIdHash,
      grossAmount,
      nonce,
      deadline,
      contextHash
    };

    const signature = await wallet.signTypedData(domain, types, value);

    const body = {
      tipper: wallet.address,
      recipientName,
      ...(toUrl ? { recipientContextUrl: toUrl } : {}),
      recipientAgentId,
      recipientIdHash,
      grossAmount: grossAmount.toString(),
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      context,
      contextHash,
      signature
    };

    const res = await fetch(apiBase + '/api/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof json?.error === 'string' ? json.error : 'tip submission failed';
      throw new Error(err);
    }

    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  });

program
  .command('link:payload')
  .description('Create a Moltbook link payload to post publicly (paste as a JSON code block).')
  .requiredOption('--moltbook-name <name>', 'Moltbook name (author handle)')
  .option('--agent-id <uuid>', 'Moltbook agent id (uuid). If omitted, resolved via CHITIN /api/lookup.')
  .option('--nonce <n>', 'Wallet-link nonce to sign (decimal). If omitted, fetched from chain.')
  .option('--deadline <unixSeconds>', 'Signature deadline (unix seconds). If omitted, derived from chain timestamp.')
  .option('--chain-id <id>', 'Chain id (overrides RPC-derived chain id)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--deadline-seconds <seconds>', 'Signature expiry window (relative to latest block timestamp)', String(7 * 86400))
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);
    const moltbookName = z.string().min(1).parse(String(opts.moltbookName));
    const wallet = loadWallet(r.walletPath);

    const apiBase = normalizeApiBase(String(opts.apiBase ?? r.config.apiBase ?? envApiBase() ?? ''));

    // Resolve rpc/contract via remote config unless explicitly overridden.
    let rpcUrl = String(opts.rpcUrl ?? r.config.rpcUrl ?? '').trim();
    let contractAddress = String(opts.contract ?? r.config.contractAddress ?? '').trim();
    if ((!rpcUrl || !contractAddress) && apiBase) {
      const baseCfg = await ensureRemoteConfig({
        configPath: r.configPath,
        config: r.config,
        apiBase: String(opts.apiBase ?? '')
      });
      rpcUrl = rpcUrl || String(baseCfg.rpcUrl ?? '').trim();
      contractAddress = contractAddress || String(baseCfg.contractAddress ?? '').trim();
    }

    if (!contractAddress) throw new Error('Missing contractAddress (provide --contract or set it via /api/config)');

    const deadlineSeconds = z.coerce.number().int().positive().parse(opts.deadlineSeconds);

    const linkNonce = ethers.hexlify(ethers.randomBytes(16));
    const issuedAt = new Date().toISOString();

    const agentId = opts.agentId ? z.string().uuid().parse(String(opts.agentId)) : await lookupAgentIdByName(apiBase, moltbookName);
    const agentIdHash = keccak256(toUtf8Bytes(agentId));

    let provider: JsonRpcProvider | null = null;
    if (rpcUrl) provider = new JsonRpcProvider(rpcUrl);

    const chainId = opts.chainId
      ? BigInt(z.coerce.number().int().positive().parse(opts.chainId))
      : provider
        ? (await provider.getNetwork()).chainId
        : null;
    if (!chainId) throw new Error('Missing chainId (provide --chain-id or provide rpcUrl)');

    const now = provider ? await getChainTimestamp(provider) : Math.floor(Date.now() / 1000);
    const deadline = opts.deadline
      ? BigInt(z.string().regex(/^\d+$/).parse(String(opts.deadline)))
      : BigInt(now + deadlineSeconds);

    const nonce = opts.nonce
      ? BigInt(z.string().regex(/^\d+$/).parse(String(opts.nonce)))
      : (() => {
          if (!provider) throw new Error('Missing rpcUrl (provide --rpc-url or provide --nonce)');
          return 0n;
        })();

    let resolvedNonce = nonce;
    if (!opts.nonce) {
      const linkAbi = ['function linkNoncesByAgentIdHash(bytes32) view returns (uint256)'];
      const token = new Contract(contractAddress, linkAbi, provider);
      resolvedNonce = BigInt(await token.linkNoncesByAgentIdHash(agentIdHash));
    }

    const domain = {
      name: 'CHITIN',
      version: '1',
      chainId,
      verifyingContract: contractAddress
    };

    const value = {
      agentIdHash,
      oldWallet: ethers.ZeroAddress,
      newWallet: wallet.address,
      nonce: resolvedNonce,
      deadline
    };

    const signature = await wallet.signTypedData(domain, WALLET_LINK_TYPES, value);

    const payload = {
      type: 'chitin_link',
      moltbookName,
      address: wallet.address,
      linkNonce,
      issuedAt,
      nonce: resolvedNonce.toString(),
      deadline: deadline.toString(),
      signature
    } as const;

    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  });

program
  .command('link:rotate-payload')
  .description('Create a Moltbook wallet-rotation payload (requires signatures from both old + new wallets).')
  .requiredOption('--moltbook-name <name>', 'Moltbook name (author handle)')
  .requiredOption('--old-wallet <path>', 'Old wallet file path (currently linked)')
  .requiredOption('--new-wallet <path>', 'New wallet file path (to link)')
  .option('--agent-id <uuid>', 'Moltbook agent id (uuid). If omitted, resolved via CHITIN /api/lookup.')
  .option('--nonce <n>', 'Wallet-link nonce to sign (decimal). If omitted, fetched from chain.')
  .option('--deadline <unixSeconds>', 'Signature deadline (unix seconds). If omitted, derived from chain timestamp.')
  .option('--chain-id <id>', 'Chain id (overrides RPC-derived chain id)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--deadline-seconds <seconds>', 'Signature expiry window (relative to latest block timestamp)', String(7 * 86400))
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .action(async (opts) => {
    const moltbookName = z.string().min(1).parse(String(opts.moltbookName));
    const oldWalletPath = path.resolve(String(opts.oldWallet));
    const newWalletPath = path.resolve(String(opts.newWallet));

    const oldWallet = loadWallet(oldWalletPath);
    const newWallet = loadWallet(newWalletPath);

    const r = resolveConfig(opts);
    const apiBase = normalizeApiBase(String(opts.apiBase ?? r.config.apiBase ?? envApiBase() ?? ''));

    let rpcUrl = String(opts.rpcUrl ?? r.config.rpcUrl ?? '').trim();
    let contractAddress = String(opts.contract ?? r.config.contractAddress ?? '').trim();
    if ((!rpcUrl || !contractAddress) && apiBase) {
      const baseCfg = await ensureRemoteConfig({
        configPath: r.configPath,
        config: r.config,
        apiBase: String(opts.apiBase ?? '')
      });
      rpcUrl = rpcUrl || String(baseCfg.rpcUrl ?? '').trim();
      contractAddress = contractAddress || String(baseCfg.contractAddress ?? '').trim();
    }

    if (!contractAddress) throw new Error('Missing contractAddress (provide --contract or set it via /api/config)');

    const deadlineSeconds = z.coerce.number().int().positive().parse(opts.deadlineSeconds);

    const rotateNonce = ethers.hexlify(ethers.randomBytes(16));
    const issuedAt = new Date().toISOString();

    const agentId = opts.agentId ? z.string().uuid().parse(String(opts.agentId)) : await lookupAgentIdByName(apiBase, moltbookName);
    const agentIdHash = keccak256(toUtf8Bytes(agentId));

    let provider: JsonRpcProvider | null = null;
    if (rpcUrl) provider = new JsonRpcProvider(rpcUrl);

    const chainId = opts.chainId
      ? BigInt(z.coerce.number().int().positive().parse(opts.chainId))
      : provider
        ? (await provider.getNetwork()).chainId
        : null;
    if (!chainId) throw new Error('Missing chainId (provide --chain-id or provide rpcUrl)');

    const now = provider ? await getChainTimestamp(provider) : Math.floor(Date.now() / 1000);
    const deadline = opts.deadline
      ? BigInt(z.string().regex(/^\d+$/).parse(String(opts.deadline)))
      : BigInt(now + deadlineSeconds);

    const nonce = opts.nonce
      ? BigInt(z.string().regex(/^\d+$/).parse(String(opts.nonce)))
      : (() => {
          if (!provider) throw new Error('Missing rpcUrl (provide --rpc-url or provide --nonce)');
          return 0n;
        })();

    let resolvedNonce = nonce;
    if (!opts.nonce) {
      const linkAbi = ['function linkNoncesByAgentIdHash(bytes32) view returns (uint256)'];
      const token = new Contract(contractAddress, linkAbi, provider);
      resolvedNonce = BigInt(await token.linkNoncesByAgentIdHash(agentIdHash));
    }

    const domain = {
      name: 'CHITIN',
      version: '1',
      chainId,
      verifyingContract: contractAddress
    };

    const value = {
      agentIdHash,
      oldWallet: oldWallet.address,
      newWallet: newWallet.address,
      nonce: resolvedNonce,
      deadline
    };

    const payload = {
      type: 'chitin_rotate',
      moltbookName,
      oldAddress: oldWallet.address,
      newAddress: newWallet.address,
      rotateNonce,
      issuedAt,
      nonce: resolvedNonce.toString(),
      deadline: deadline.toString()
    } as const;

    const oldSignature = await oldWallet.signTypedData(domain, WALLET_LINK_TYPES, value);
    const newSignature = await newWallet.signTypedData(domain, WALLET_LINK_TYPES, value);

    process.stdout.write(JSON.stringify({ ...payload, oldSignature, newSignature }, null, 2) + '\n');
  });

program
  .command('link:submit')
  .description('Submit your link post (by post id or linkNonce) to the CHITIN backend for verification/indexing.')
  .option('--post-id <id>', 'Moltbook post id containing your link payload')
  .option('--link-nonce <nonce>', 'linkNonce contained in your link payload')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const apiBaseRaw = String(opts.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
    if (!apiBaseRaw) throw new Error('Missing apiBase (set in config.json)');
    const apiBase = normalizeApiBase(apiBaseRaw);

    const postId = opts.postId ? String(opts.postId) : null;
    const linkNonce = opts.linkNonce ? String(opts.linkNonce) : null;
    if (!postId && !linkNonce) throw new Error('Provide --post-id or --link-nonce');

    const res = await fetch(apiBase + '/api/link/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(postId ? { postId } : {}),
        ...(linkNonce ? { linkNonce } : {})
      })
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof json?.error === 'string' ? json.error : 'link submit failed';
      throw new Error(err);
    }

    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  });

program
  .command('link:lock')
  .description('Lock your onchain wallet link (requires Base ETH gas). After locking, the backend cannot rotate your link.')
  .option('--agent-id <uuid>', 'Your Moltbook agent id (uuid)')
  .option('--moltbook-name <name>', 'Your Moltbook name (resolved via CHITIN backend)')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (used for --moltbook-name resolution)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const wallet = loadWallet(r.walletPath).connect(new JsonRpcProvider(rpcUrl));

    let agentId = String(opts.agentId ?? '').trim();
    const moltbookName = String(opts.moltbookName ?? '').trim();
    if (!agentId && !moltbookName) throw new Error('Provide --agent-id or --moltbook-name');
    if (!agentId && moltbookName) {
      const apiBaseRaw = String(opts.apiBase ?? baseCfg.apiBase ?? envApiBase() ?? '').trim();
      if (!apiBaseRaw) throw new Error('Missing apiBase (set CHITIN_ORIGIN/CHITIN_API_BASE or set apiBase in config.json)');
      const apiBase = normalizeApiBase(apiBaseRaw);
      const u = new URL(apiBase + '/api/lookup');
      u.searchParams.set('name', moltbookName);
      const res = await fetch(u.toString(), { method: 'GET' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        const err = typeof json?.error === 'string' ? json.error : 'lookup failed';
        throw new Error(err);
      }
      agentId = String(json.agentId ?? '').trim();
      if (!agentId) throw new Error('lookup returned missing agentId');
    }

    const agentIdHash = keccak256(toUtf8Bytes(agentId));
    const abi = ['function lockAgentWallet(bytes32 agentIdHash)'];
    const token = new Contract(contractAddress, abi, wallet);

    const tx = await token.lockAgentWallet(agentIdHash);
    process.stdout.write(
      JSON.stringify({ success: true, agentId, agentIdHash, txHash: tx.hash }, null, 2) + '\n'
    );
  });

program
  .command('link:rotate-locked')
  .description('Rotate a locked onchain wallet link (requires Base ETH gas; must be sent from your currently-linked wallet).')
  .requiredOption('--new-address <address>', 'New wallet address (0x...)')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override (must be currently linked + already locked)')
  .option('--api-base <url>', 'CHITIN API base (used if rpcUrl/contractAddress are missing)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const wallet = loadWallet(r.walletPath).connect(new JsonRpcProvider(rpcUrl));
    const newAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(String(opts.newAddress));

    const abi = ['function rotateLockedAgentWallet(address newWallet)'];
    const token = new Contract(contractAddress, abi, wallet);
    const tx = await token.rotateLockedAgentWallet(newAddress);

    process.stdout.write(JSON.stringify({ success: true, txHash: tx.hash, newAddress }, null, 2) + '\n');
  });

program
  .command('alias:payload')
  .description('Create a Moltx alias payload to post publicly (paste as a JSON code block in a Moltx post).')
  .requiredOption('--moltbook-name <name>', 'Your Moltbook name (canonical CHITIN identity)')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .action(async (opts) => {
    const r = resolveConfig(opts);
    const moltbookName = z.string().min(1).parse(String(opts.moltbookName));
    const wallet = loadWallet(r.walletPath);

    const aliasNonce = ethers.hexlify(ethers.randomBytes(16));
    const issuedAt = new Date().toISOString();

    const payload = {
      type: 'chitin_alias_v1',
      moltbookName,
      address: wallet.address,
      aliasNonce,
      issuedAt
    } as const;

    const msg = ['CHITIN_ALIAS_V1', 'moltbookName=' + payload.moltbookName, 'address=' + payload.address, 'aliasNonce=' + payload.aliasNonce, 'issuedAt=' + payload.issuedAt].join('|');
    const signature = await wallet.signMessage(msg);

    process.stdout.write(JSON.stringify({ ...payload, signature }, null, 2) + '\n');
  });

program
  .command('alias:submit')
  .description('Submit a Moltx alias proof post URL to the CHITIN backend.')
  .requiredOption('--proof-url <url>', 'Moltx post URL containing your chitin_alias_v1 JSON payload')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const apiBaseRaw = String(opts.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
    if (!apiBaseRaw) throw new Error('Missing apiBase (set in config.json)');
    const apiBase = normalizeApiBase(apiBaseRaw);

    const proofUrl = z.string().url().parse(String(opts.proofUrl));

    const res = await fetch(apiBase + '/api/alias/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'moltx', proofUrl })
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof json?.error === 'string' ? json.error : 'alias submit failed';
      throw new Error(err);
    }

    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  });

program
  .command('transfer:send')
  .description('Send a normal ERC-20 CHITIN transfer (requires Base ETH gas).')
  .option('--to <address>', 'Recipient address')
  .option('--to-name <name>', 'Recipient Moltbook name (resolves linked wallet via CHITIN API)')
  .requiredOption('--amount <amount>', 'Amount in CHITIN (e.g. 1.5)')
  .option('--context <string>', 'Optional context URL/identifier (stored offchain for activity feed)')
  .option('--submit', 'Also submit the tx hash to the CHITIN backend for the activity feed', false)
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (used for --submit; overrides config)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const toAddrRaw = opts.to ? String(opts.to) : '';
    const toNameRaw = opts.toName ? String(opts.toName) : '';
    if ((toAddrRaw && toNameRaw) || (!toAddrRaw && !toNameRaw)) {
      throw new Error('Provide exactly one of --to or --to-name');
    }

    let to: string;
    if (toAddrRaw) {
      to = z.string().startsWith('0x').parse(toAddrRaw);
    } else {
      const apiBaseRaw = String(opts.apiBase ?? baseCfg.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
      if (!apiBaseRaw) throw new Error('Missing apiBase (required for --to-name)');
      const apiBase = normalizeApiBase(apiBaseRaw);

      const recipientName = z.string().min(1).parse(toNameRaw);
      const url = new URL(apiBase + '/api/lookup');
      url.searchParams.set('name', recipientName);

      const res = await fetch(url.toString(), { method: 'GET' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        const err = typeof json?.error === 'string' ? json.error : 'lookup failed';
        throw new Error(err);
      }

      if (!json.linked || !json.address) {
        throw new Error('recipient_not_linked');
      }

      to = z.string().startsWith('0x').parse(String(json.address));
    }
    const amount = parseUnits(String(opts.amount), 18);

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = loadWallet(r.walletPath).connect(provider);

    const abi = ['function transfer(address to,uint256 amount) returns (bool)'];
    const token = new Contract(contractAddress, abi, wallet);

    const tx = await token.transfer(to, amount);
    const txHash = String(tx.hash);

    if (opts.submit) {
      const apiBaseRaw = String(opts.apiBase ?? baseCfg.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
      if (!apiBaseRaw) throw new Error('Missing apiBase');
      const apiBase = normalizeApiBase(apiBaseRaw);

      const res = await fetch(apiBase + '/api/transfer/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash,
          ...(opts.context ? { context: String(opts.context) } : {})
        })
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = typeof json?.error === 'string' ? json.error : 'transfer submit failed';
        throw new Error(err);
      }

      process.stdout.write(JSON.stringify({ txHash, submitted: true, response: json }, null, 2) + '\n');
      return;
    }

    process.stdout.write(JSON.stringify({ txHash }, null, 2) + '\n');
  });

program
  .command('burn:send')
  .description('Burn CHITIN from your wallet (reduces total supply; requires Base ETH gas).')
  .requiredOption('--amount <amount>', 'Amount in CHITIN (e.g. 2.5)')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(r.config.apiBase ?? envApiBase() ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const amount = parseUnits(String(opts.amount), 18);

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = loadWallet(r.walletPath).connect(provider);

    const abi = ['function burn(uint256 amount)'];
    const token = new Contract(contractAddress, abi, wallet);
    const tx = await token.burn(amount);
    process.stdout.write(JSON.stringify({ txHash: String(tx.hash) }, null, 2) + '\n');
  });

program
  .command('pay:send')
  .description('Pay an agreed gross amount by TRANSFER + burn 2.5% (social deflation rule).')
  .option('--to <address>', 'Recipient address')
  .option('--to-name <name>', 'Recipient Moltbook name (resolves linked wallet via CHITIN API)')
  .requiredOption('--gross-amount <amount>', 'Gross amount in CHITIN (e.g. 100)')
  .option('--burn-bps <bps>', 'Burn fee in bps of gross amount (default 250 = 2.5%)', '250')
  .option('--context <string>', 'Optional context URL/identifier (stored offchain for activity feed)')
  .option('--submit', 'Also submit the TRANSFER tx hash to the CHITIN backend for the activity feed', false)
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('-w, --wallet <path>', 'Wallet file path override')
  .option('--api-base <url>', 'CHITIN API base (used for --to-name/--submit; overrides config)')
  .option('--rpc-url <url>', 'Base RPC URL (overrides config)')
  .option('--contract <address>', 'CHITIN contract address (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const baseCfg = await ensureRemoteConfig({
      configPath: r.configPath,
      config: r.config,
      apiBase: String(opts.apiBase ?? '')
    });

    const rpcUrl = String(opts.rpcUrl ?? baseCfg.rpcUrl ?? '');
    const contractAddress = String(opts.contract ?? baseCfg.contractAddress ?? '');
    if (!rpcUrl) throw new Error('Missing rpcUrl');
    if (!contractAddress) throw new Error('Missing contractAddress');

    const toAddrRaw = opts.to ? String(opts.to) : '';
    const toNameRaw = opts.toName ? String(opts.toName) : '';
    if ((toAddrRaw && toNameRaw) || (!toAddrRaw && !toNameRaw)) {
      throw new Error('Provide exactly one of --to or --to-name');
    }

    let to: string;
    if (toAddrRaw) {
      to = z.string().startsWith('0x').parse(toAddrRaw);
    } else {
      const apiBaseRaw = String(opts.apiBase ?? baseCfg.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
      if (!apiBaseRaw) throw new Error('Missing apiBase (required for --to-name)');
      const apiBase = normalizeApiBase(apiBaseRaw);

      const recipientName = z.string().min(1).parse(toNameRaw);
      const url = new URL(apiBase + '/api/lookup');
      url.searchParams.set('name', recipientName);

      const res = await fetch(url.toString(), { method: 'GET' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        const err = typeof json?.error === 'string' ? json.error : 'lookup failed';
        throw new Error(err);
      }

      if (!json.linked || !json.address) {
        throw new Error('recipient_not_linked');
      }

      to = z.string().startsWith('0x').parse(String(json.address));
    }

    const gross = parseUnits(String(opts.grossAmount), 18);
    const burnBps = BigInt(z.coerce.number().int().min(0).max(10_000).parse(opts.burnBps));
    const burnAmt = (gross * burnBps) / 10_000n;
    const net = gross - burnAmt;

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = loadWallet(r.walletPath).connect(provider);

    const abi = [
      'function transfer(address to,uint256 amount) returns (bool)',
      'function burn(uint256 amount)'
    ];
    const token = new Contract(contractAddress, abi, wallet);

    // Send two back-to-back txs (transfer + burn). Some RPCs return a "latest" nonce that can race with
    // our first send, causing the second tx to reuse nonce=0. Assign explicit sequential nonces using
    // the pending nonce to be robust.
    const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');
    const txTransfer = await token.transfer(to, net, { nonce: baseNonce });
    const txBurn = burnAmt > 0n ? await token.burn(burnAmt, { nonce: baseNonce + 1 }) : null;

    const transferHash = String(txTransfer.hash);
    const burnHash = txBurn ? String(txBurn.hash) : null;

    if (opts.submit) {
      const apiBaseRaw = String(opts.apiBase ?? baseCfg.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
      if (!apiBaseRaw) throw new Error('Missing apiBase');
      const apiBase = normalizeApiBase(apiBaseRaw);

      const res = await fetch(apiBase + '/api/transfer/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: transferHash,
          ...(burnHash ? { burnTxHash: burnHash } : {}),
          ...(opts.context ? { context: String(opts.context) } : {})
        })
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = typeof json?.error === 'string' ? json.error : 'transfer submit failed';
        throw new Error(err);
      }

      process.stdout.write(
        JSON.stringify(
          { grossAmountWei: gross.toString(), netAmountWei: net.toString(), burnAmountWei: burnAmt.toString(), txHash: transferHash, burnTxHash: burnHash, submitted: true, response: json },
          null,
          2
        ) + '\n'
      );
      return;
    }

    process.stdout.write(
      JSON.stringify(
        { grossAmountWei: gross.toString(), netAmountWei: net.toString(), burnAmountWei: burnAmt.toString(), txHash: transferHash, burnTxHash: burnHash },
        null,
        2
      ) + '\n'
    );
  });

program
  .command('transfer:submit')
  .description('Submit an existing CHITIN transfer tx hash to the backend (optionally with a burn tx hash for verified PAY tax).')
  .requiredOption('--tx-hash <hash>', 'Transaction hash')
  .option('--burn-tx-hash <hash>', 'Optional burn() tx hash (for verified PAY tax)')
  .option('--context <string>', 'Optional context URL/identifier')
  .option('-c, --config <path>', 'Config path', DEFAULT_CONFIG_PATH)
  .option('--api-base <url>', 'CHITIN API base (overrides config)')
  .action(async (opts) => {
    const r = resolveConfig(opts);

    const apiBaseRaw = String(opts.apiBase ?? r.config.apiBase ?? envApiBase() ?? '');
    if (!apiBaseRaw) throw new Error('Missing apiBase');
    const apiBase = normalizeApiBase(apiBaseRaw);

    const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(String(opts.txHash));
    const burnTxHash = opts.burnTxHash ? z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(String(opts.burnTxHash)) : null;

    const res = await fetch(apiBase + '/api/transfer/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txHash,
        ...(burnTxHash ? { burnTxHash } : {}),
        ...(opts.context ? { context: String(opts.context) } : {})
      })
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = typeof json?.error === 'string' ? json.error : 'transfer submit failed';
      throw new Error(err);
    }

    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  });

program.parseAsync().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write('Error: ' + msg + '\n');
  process.exitCode = 1;
});
