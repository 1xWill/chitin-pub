#!/usr/bin/env bash
set -euo pipefail

# Staging runner for local UI + mock Moltbook + Base Sepolia contract deploy + smoke test.
#
# Prereqs: `.env` contains BASE_RPC_URL (Base Sepolia), DATABASE_URL, CRON_TOKEN,
# DEPLOYER_PRIVATE_KEY, RELAYER_PRIVATE_KEY.
#
# Usage:
#   ./tools/staging-run.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set -a
source .env
set +a

if [[ -z "${BASE_RPC_URL:-}" || -z "${DATABASE_URL:-}" || -z "${CRON_TOKEN:-}" || -z "${DEPLOYER_PRIVATE_KEY:-}" || -z "${RELAYER_PRIVATE_KEY:-}" ]]; then
  echo "Missing required env vars in .env (need BASE_RPC_URL, DATABASE_URL, CRON_TOKEN, DEPLOYER_PRIVATE_KEY, RELAYER_PRIVATE_KEY)" >&2
  exit 1
fi

echo "[1/7] Ensure migrations"
npm run db:migrate -w @chitin/web

echo "[1.5/7] Prepare Sepolia staging config (tools/.staging/chitin.config.json)"
mkdir -p tools/.staging
STAGING_CONFIG="$ROOT/tools/.staging/chitin.config.json"
cp apps/web/chitin.config.sepolia.json "$STAGING_CONFIG"
export CHITIN_CONFIG_PATH="$STAGING_CONFIG"

echo "[2/7] Start mock Moltbook (127.0.0.1:8787)"
if [[ ! -f tools/.mock-moltbook.pid ]] || ! kill -0 "$(cat tools/.mock-moltbook.pid)" 2>/dev/null; then
  node tools/mock-moltbook/server.mjs 8787 > tools/.mock-moltbook.log 2>&1 &
  echo $! > tools/.mock-moltbook.pid
fi

echo "[2.5/7] Start mock Moltx (127.0.0.1:8788)"
if [[ ! -f tools/.mock-moltx.pid ]] || ! kill -0 "$(cat tools/.mock-moltx.pid)" 2>/dev/null; then
  node tools/mock-moltx/server.mjs 8788 > tools/.mock-moltx.log 2>&1 &
  echo $! > tools/.mock-moltx.pid
fi

echo "[2.6/7] Point staging config moltx.apiBase to local mock"
node - <<'NODE'
const fs = require('node:fs');
const p = process.env.CHITIN_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
cfg.moltx = cfg.moltx || {};
cfg.moltx.apiBase = 'http://127.0.0.1:8788/v1';
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('wrote', p, 'moltx.apiBase=', cfg.moltx.apiBase);
NODE

echo "[3/7] Ensure CLI build (used by smoke script)"
npm run build -w @chitin/cli >/dev/null

echo "[4/7] Deploy contract to Base Sepolia (requires Sepolia ETH in deployer/relayer wallet)"
ALLOW_DEPLOYER_TREASURY=1 DEPLOY_CONFIG_PATH="tools/deploy.config.sepolia.json" npx hardhat run packages/contracts/scripts/deploy-base.js --network base | tee tools/.staging.deploy.log

ADDR="$(rg -n \"^CHITIN:\" -o tools/.staging.deploy.log | sed -E \"s/^CHITIN: //\" | tail -n 1)"
if [[ -z "$ADDR" ]]; then
  echo "Failed to parse deployed contract address from tools/.staging.deploy.log" >&2
  exit 1
fi

echo "[5/7] Write contract address into staging config ($STAGING_CONFIG)"
node - <<NODE
const fs = require('node:fs');
const p = process.env.CHITIN_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(p,'utf8'));
cfg.chain = cfg.chain || {};
cfg.chain.contractAddress = '${ADDR}';
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\\n', 'utf8');
console.log('wrote', p, 'chain.contractAddress=', cfg.chain.contractAddress);
NODE

echo "[6/7] Start web dev server (http://localhost:3000)"
if [[ ! -f tools/.web-dev.pid ]] || ! kill -0 "$(cat tools/.web-dev.pid)" 2>/dev/null; then
  CHITIN_CONFIG_PATH="$STAGING_CONFIG" npm run dev -w @chitin/web > tools/.web-dev.log 2>&1 &
  echo $! > tools/.web-dev.pid
fi

echo "[7/7] Run smoke test (writes activities; you can watch UI)"
CHITIN_ORIGIN="http://127.0.0.1:3000" node tools/staging-smoke.mjs

echo "OK. UI: http://localhost:3000"
