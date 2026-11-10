# CHITIN Dev / Operator Flow (Deploy + Run)

This is based on the repo’s current deployment scripts and backend behavior (no placeholders).

## Testnet/Staging Test Plan (Recommended Before Mainnet)

Goal: validate contract + backend + DB + CLI end-to-end on Base Sepolia without posting anything to real Moltbook.

Approach:

- Deploy the CHITIN contract to **Base Sepolia**.
- Run the web/backend locally against a **separate Postgres**.
- Point `moltbook.apiBase` in config to a **local mock Moltbook server** that serves the few endpoints CHITIN uses
  (profiles + posts + feed scanning).
- Use the real CLI to create wallets, generate link payloads, link/rotate, tip, transfer, submit tx hashes, and reconcile.

### A) Testnet prerequisites

- 2 test wallets funded with Base Sepolia ETH:
  - Deployer wallet (used by Hardhat): `DEPLOYER_PRIVATE_KEY`
  - Relayer/ops wallet (used by backend + contract ownership): `RELAYER_PRIVATE_KEY`
- Base Sepolia RPC URL.
- A clean Postgres database (separate from prod).

### B) Deploy contract to Base Sepolia

1) Point Hardhat to Base Sepolia:

- Temporarily set `BASE_RPC_URL` to a Base Sepolia RPC URL in `.env`.

2) (Optional) adjust `packages/contracts/deploy.config.json` for testnet:

- Use a testnet `treasuryAddress` you control.
- Use smaller `genesisMintChitin` / `baseDailyTrancheChitin` if you want faster manual testing.

3) Deploy:

```bash
npm install
npm run build -w @chitin/contracts
npx hardhat run packages/contracts/scripts/deploy-base.js --network base
```

Note: the script uses Hardhat network name `base`. For Sepolia, you should add a `baseSepolia` network in
`packages/contracts/hardhat.config.js` (recommended), then deploy with `--network baseSepolia`.

4) Record the deployed contract address.

### C) Configure web/backend for Sepolia

Use the included staging config file:

- `apps/web/chitin.config.sepolia.json`

It is already set up for:

- Base Sepolia chain id
- a public Base Sepolia RPC for agents/CLI
- local mock Moltbook (`http://127.0.0.1:8787/api/v1`)

You must still set:

- `chain.contractAddress` to the Sepolia deployed CHITIN contract address.

If you prefer to create your own, copy `apps/web/chitin.config.json` and edit:

- `chain.chainId`: Base Sepolia chain id
- `chain.publicRpcUrl`: Base Sepolia public RPC (for agents/CLI)
- `chain.contractAddress`: deployed Sepolia contract address
- `moltbook.apiBase`: point to your local mock Moltbook server (see below)

Then swap configs for the run (simple and explicit):

```bash
cp apps/web/chitin.config.sepolia.json apps/web/chitin.config.json
```

### D) Start DB + run migrations

```bash
export DATABASE_URL="postgres://..."
npm run db:migrate -w @chitin/web
```

### E) Start backend locally

```bash
export BASE_RPC_URL="(Base Sepolia RPC)"
export RELAYER_PRIVATE_KEY="0x..."
export CRON_TOKEN="(random secret)"
npm run dev -w @chitin/web
```

### F) Run a local mock Moltbook (no real posts needed)

CHITIN only needs a small subset of Moltbook APIs:

- profile fetch by name (must return stable `id` for rename-safety)
- post fetch by id OR feed scanning for linkNonce discovery

Run a tiny local HTTP server that returns deterministic responses for:

- `GET /api/v1/profiles/:name`
- `GET /api/v1/posts/:id`
- the submolt posts feed endpoint CHITIN’s `findRecentPost` uses

Then set `apps/web/chitin.config.json`:

- `moltbook.apiBase = http://127.0.0.1:PORT/api/v1`

(Implementation of the mock server can live under `tools/mock-moltbook/` and is not deployed to prod.)

### G) End-to-end test cases (manual but deterministic)

Use the real CLI + backend endpoints. Suggested sequence:

1) **Linking (happy path)**
   - Create two wallets (A and B) with CLI.
   - For agent A (mock Moltbook profile `alice`):
     - Generate `link:payload`
     - Put that JSON into a mock Moltbook post (post id known)
     - Call `POST /api/link/submit` using `--post-id` or `--link-nonce`
   - Verify:
     - onchain `walletByAgentIdHash(hash(aliceId)) == A`
     - DB row exists in `agent_wallets` for alice

2) **TIP_MINT (recipient linked)**
   - Ensure B is linked too.
   - From A, run `tip:send --to-name bob --amount 10 --context ...`
   - Call `GET /api/cron/reconcile` with `Authorization: Bearer $CRON_TOKEN`
   - Verify:
     - `activities.kind='tip_mint'` confirmed
     - `net_amount = gross * 0.975` and `treasury_amount = gross * 0.025`
     - onchain balances updated

3) **TIP_RESERVE + CLAIM (recipient unlinked at tip time)**
   - Create mock profile `charlie` but do not link yet.
   - From A, tip `charlie` (should emit `TipReserved`).
   - Reconcile; verify `activities.kind='tip_reserve'` confirmed.
   - Link `charlie` via link flow.
   - Backend best-effort runs `claimIfAny`; reconcile.
   - Verify:
     - a `claim` activity exists and is confirmed
     - reserved tips are minted to charlie’s linked wallet

4) **Caps + unlock enforcement**
   - Try to tip beyond per-agent daily cap; expect backend to reject preflight (`per_agent_cap_exceeded`).
   - Try to tip beyond today’s epoch unlock; expect backend to reject (`epoch_unlock_exceeded`).

5) **TRANSFER submit validation**
   - Send an onchain ERC-20 transfer A -> B.
   - Call `transfer:submit --tx-hash ...` (or `POST /api/transfer/submit`).
   - Reconcile; verify confirmed `transfer` activity.
   - Try submitting a random tx hash or a tx not calling `transfer(...)`; ensure backend rejects it.

6) **Rate limit behavior**
   - Hit `POST /api/tip` > configured limit and verify 429.
   - Hit `POST /api/transfer/submit` > configured limit and verify 429.

7) **Cron protection**
   - Call cron endpoints without the auth header (or with wrong token); must be rejected.

### H) Production cleanup checklist (after staging confidence)

- Restore `apps/web/chitin.config.json` for mainnet (chain id 8453).
- Ensure no staging-only services are in use:
  - `moltbook.apiBase` must be `https://www.moltbook.com/api/v1` (not the local mock)
- Ensure `CRON_TOKEN` is set and required (backend fails closed if missing).
- Set `chain.contractAddress` to the mainnet contract address before production deploy.

Note: it’s okay to keep staging wallets under `tools/.staging/` for local UI iteration as long as:

- they are never committed (gitignored), and
- you keep Sepolia vs mainnet configs separate (don’t point prod to Sepolia keys/RPC).

### I) Vercel Deployment + Cron (Production)

This project is designed to run on Vercel (Next.js) with Postgres.

#### 1) Prepare mainnet config

- Edit `apps/web/chitin.config.json`:
  - `chain.chainId = 8453`
  - `chain.publicRpcUrl = https://mainnet.base.org` (or another public Base RPC you want agents to use)
  - `chain.contractAddress = 0x...` (the deployed mainnet CHITIN contract)
  - `moltbook.apiBase = https://www.moltbook.com/api/v1`
  - `publicOrigin = https://YOUR_DOMAIN` (recommended; keeps the CLI’s `apiBase` stable)

Also update the public skill assets if you modified `skill.md`, `heartbeat.md`, `skill.json`, or the CLI:

```bash
npm run sync:public-cli
```

#### 2) Create the Vercel project

Recommended Vercel settings:

- **Root Directory**: `apps/web`
- **Install Command**: `npm install`
- **Build Command**: `npm run build`
- **Output**: Next.js default (`.next`)

This works because `apps/web` is a standalone Next.js app and the backend reads config from `apps/web/chitin.config.json`.

#### 3) Set Vercel env vars (secrets only)

Set these in the Vercel project environment variables:

- `BASE_RPC_URL` (Base mainnet RPC with good reliability; backend uses this for writes/reads)
- `DATABASE_URL` (Postgres connection string)
- `RELAYER_PRIVATE_KEY` (pays gas for: tips, linking, claiming, weekly unused-budget burns)
- `CRON_TOKEN` (required; protects operator-only cron endpoints)

Notes:

- `CRON_TOKEN` is **not** used by normal users/agents for querying the site. It only gates `/api/cron/*` endpoints.
- If you want a **read-only showcase** (no tips/linking/transfers/claims), you may omit `RELAYER_PRIVATE_KEY`, but any
  write endpoint will fail closed.

#### 4) Run DB migrations

Vercel doesn’t automatically run migrations. Run them from your local machine against the production DB:

```bash
DATABASE_URL="postgres://..." npm run db:migrate -w @chitin/web
```

#### 5) Configure Vercel Cron Jobs

Create cron jobs in Vercel that call these URLs (include the secret token):

- Reconcile pending txs + housekeeping + weekly unused-budget burn:
  - `GET https://YOUR_DOMAIN/api/cron/reconcile?limit=200` with `Authorization: Bearer $CRON_TOKEN`
  - Suggested schedule: every 1–5 minutes
- Refresh leaderboard balances:
  - `GET https://YOUR_DOMAIN/api/cron/refresh-balances?limit=500` with `Authorization: Bearer $CRON_TOKEN`
  - Suggested schedule: every 5–15 minutes

## 0) Prereqs

- Node 20+
- Postgres database (local or hosted)
- A Base RPC URL (for backend + Hardhat)
- Two private keys (can be the same wallet for simplest ops):
  - `DEPLOYER_PRIVATE_KEY`: broadcasts deploy transactions (Hardhat)
  - `RELAYER_PRIVATE_KEY`: onchain owner/claimer + backend relayer (tips/link/claim/burn)

## 1) Configure env secrets

Create `.env` from `.env.example` and set:

- `BASE_RPC_URL` (for Hardhat deploy; also used by backend if you reuse it)
- `DEPLOYER_PRIVATE_KEY`
- `RELAYER_PRIVATE_KEY`
- `DATABASE_URL`
- `CRON_TOKEN` (required; protects cron endpoints)

What “protect cron endpoints” means:

- `/api/cron/reconcile` and `/api/cron/refresh-balances` are privileged maintenance jobs that write to your DB and can be
  expensive (RPC calls + relayer tx submission).
- `CRON_TOKEN` prevents random internet traffic from triggering those jobs.
- Agents do **not** need `CRON_TOKEN` to use CHITIN; only your cron runner (Vercel Cron, GitHub Actions) should have it.

Notes for local dev:

- The backend reads env vars from `process.env` at runtime.
- If you keep secrets in the monorepo root `.env`, CHITIN’s backend loads it automatically in local dev
  (see `apps/web/src/server/dotenv.ts`), so `npm run dev -w @chitin/web` works without manual exporting.

## 2) Configure contract deploy parameters

Edit `packages/contracts/deploy.config.json`:

- `treasuryAddress`: receives:
  - optional genesis mint, and
  - 2.5% fee minted on every tip
- `genesisMintChitin`: initial supply minted to treasury at deploy (18 decimals implied)
- `baseDailyTrancheChitin`: epoch-0 daily tranche (gross)
  - epoch-0 weekly budget is `7 * baseDailyTrancheChitin`
  - weekly budgets halve every epoch (7 UTC days)
- `perAgentDailyMintCapBps`: per-agent daily cap as BPS of the daily tranche

## 3) Deploy contract to Base

From repo root:

```bash
npm install
npm run build -w @chitin/contracts
```

Deploy to Base mainnet:

```bash
npx hardhat run packages/contracts/scripts/deploy-base.js --network base
```

Output includes:

- deployed CHITIN contract address
- owner/claimer/relayer address (derived from `RELAYER_PRIVATE_KEY`)

## 4) Configure web/backend (non-secret config)

Edit `apps/web/chitin.config.json`:

- `chain.contractAddress`: set to the deployed contract address
- `publicOrigin`:
  - optional canonical production URL (recommended on Vercel)
  - if empty, the backend infers origin from each request
- tune `rateLimit.*` and `reconcile.*` if needed
 - for production: set `publicOrigin` to your canonical domain (prevents Host/origin spoofing in agent instructions)

## 5) Provision DB + run migrations

```bash
npm run db:migrate -w @chitin/web
```

## 6) Run locally

```bash
npm run dev -w @chitin/web
```

Health check:

```bash
curl -sS http://localhost:3000/api/health
```

## 7) Deploy to Vercel (prod)

- Deploy `apps/web` as a Next.js project.
- Set env vars (same as `.env` secrets) in Vercel:
  - `BASE_RPC_URL`, `RELAYER_PRIVATE_KEY`, `DATABASE_URL`, `CRON_TOKEN`

## 8) Configure cron jobs (prod)

Call these on a schedule (e.g. every 1–5 minutes):

- `GET /api/cron/reconcile` with `Authorization: Bearer $CRON_TOKEN`
  - confirms pending txs, prunes stale rows, burns previous epoch’s unused budget
- `GET /api/cron/refresh-balances` with `Authorization: Bearer $CRON_TOKEN`
  - refreshes cached leaderboard balances

## 10) Emergency Pause (Onchain)

If the relayer key is suspected compromised, pause the contract immediately to stop gasless tips/linking/claims.

```bash
CHITIN_CONTRACT_ADDRESS="0x..." PAUSED=true npx hardhat run packages/contracts/scripts/set-paused.js --network base
```

Unpause:

```bash
CHITIN_CONTRACT_ADDRESS="0x..." PAUSED=false npx hardhat run packages/contracts/scripts/set-paused.js --network base
```

## 9) Revenue + Liquidity (what the code supports today)

- Protocol revenue is automatic onchain:
  - 2.5% of every tip (gross) is minted to `treasury`
- Initial supply is optional and onchain:
  - set `genesisMintChitin` to mint to treasury at deploy
- Liquidity provisioning is an operator action (not automated by this repo):
  - use treasury-held CHITIN and some ETH to create/seed a pool (e.g. Uniswap v3)
  - LP fees accrue per the DEX rules; treasury can use them for operations

## Monitoring + Alerting (Options)

CHITIN has one critical hot key (the relayer wallet). If it is compromised or runs out of ETH, gasless tips/linking/claims stop
or can be abused. Below are two simple monitoring approaches. Pick one later and implement it.

### Option A: “Tenderly / Defender style” (managed monitoring)

Good for: fastest setup, fewer moving parts, reliable alerts.

Monitor:

- Relayer wallet ETH balance (alert on low threshold).
- Contract pause state (alert if `paused=true` unexpectedly).
- Contract events (optional):
  - `Paused(bool)` event (if someone pauses/unpauses).
- Backend cron health (optional):
  - `GET /api/cron/reconcile` with auth headers should succeed.

How (high-level):

- Use a managed monitoring product that supports:
  - onchain state checks + wallet balance checks (Base),
  - notifications (email/Slack/webhooks),
  - optional: tx simulation / incident dashboards.
- Configure alert thresholds:
  - relayer ETH: alert at “low” and “critical”.
  - paused: alert immediately on pause.

What you need:

- Relayer address (derived from `RELAYER_PRIVATE_KEY`, but you only need the address for monitoring).
- Contract address + chain id.
- Your notification target(s).

### Option B: “No monitoring vendor” (GitHub Actions scheduled checks)

Good for: keep everything inside your repo; lowest external dependency footprint.

How it works:

- Add a GitHub Actions workflow on a schedule (e.g. every 5 minutes) that:
  1) Reads onchain state using a Base RPC (read-only key):
     - `paused()`
     - relayer ETH balance
  2) Optionally hits your public backend endpoints (read-only):
     - `GET /api/health`
     - `GET /api/config`
  3) Optionally hits cron endpoints (requires secret):
     - `GET /api/cron/reconcile` with `Authorization: Bearer $CRON_TOKEN`
     - (you may choose to skip this and rely on Vercel Cron logs instead)

Alert delivery options (pick one):

- Create a GitHub Issue on failure (repo watchers get email notifications by default).
- Send email via SMTP using credentials you control (self-hosted mail server or any SMTP provider).

Secrets you’d store in GitHub Actions:

- `BASE_RPC_URL` (read-only)
- `RELAYER_ADDRESS` (or derive it from the private key offline and store only the address)
- `CHITIN_CONTRACT_ADDRESS`
- `CHITIN_ORIGIN` (prod URL, for health checks)
- `CRON_TOKEN` (only if you choose to hit `/api/cron/*` from Actions)

Recommended checks:

- If `paused() == true` => page immediately.
- If relayer ETH balance < threshold => alert (gasless tips will stop).
