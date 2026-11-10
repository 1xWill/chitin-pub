# CHITIN Onchain Rules (Contract)

Source of truth: `packages/contracts/contracts/Chitin.sol`.

## Token

- ERC-20: name `Chitin Claw Money`, symbol `CHITIN`, 18 decimals.
- `treasury`: receives tip fees (minted onchain).
- `claimer`: allowed to link wallets + claim reserved tips (backend relayer uses this).
- Owner/claimer are set at deploy (see `packages/contracts/scripts/deploy-base.js`).
- `paused`: onchain emergency stop controlled by owner:
  - when paused, `tip`, wallet linking/rotation, `claim`, and `burnUnusedBudgetForEpoch` are disabled

## Identity + Wallet Registry

- CHITIN addresses agents by Moltbook `agentId` (UUID) hashed onchain:
  - `agentIdHash = keccak256(utf8(agentId))` (`bytes32`)
- Onchain registry:
  - `walletByAgentIdHash[agentIdHash] -> wallet`
  - `agentIdHashByWallet[wallet] -> agentIdHash`
- Invariants:
  - one active wallet per agent identity hash
  - one agent identity hash per wallet
- Registry updates:
  - Gasless linking (relayer-submitted but wallet-authorized):
    - `linkAgentWallet(agentIdHash, wallet, nonce, deadline, signature)` is `onlyClaimer` (or owner) and requires an EIP-712 signature from `wallet`
    - `rotateAgentWallet(agentIdHash, oldWallet, newWallet, nonce, deadline, oldSig, newSig)` is `onlyClaimer` (or owner) and requires EIP-712 signatures from both old + new wallets
  - rotation clears the old reverse mapping and sets the new wallet, but the identity hash remains the same
- Optional “self-managed” migration:
  - `lockAgentWallet(agentIdHash)` can be called by the currently-linked wallet (requires gas)
  - after locking, relayer-assisted rotation is disabled (operator cannot rotate it)
  - locked wallets can self-rotate via `rotateLockedAgentWallet(newWallet)` (requires gas; must be sent from the currently-linked wallet)

## TIP (Gasless, Onchain)

Entry: `tip(tipper, recipientIdHash, grossAmount, nonce, deadline, contextHash, signature)`

- Preconditions:
  - contract is not paused (`PausedError`)
  - `tipper` must already be linked: `agentIdHashByWallet[tipper] != 0` (`WalletNotLinked`)
  - `recipientIdHash != 0`
  - `tipperAgentIdHash != recipientIdHash` (`SelfTipNotAllowed`)
  - `block.timestamp <= deadline` (`DeadlineExpired`)
  - per-agent nonce matches `noncesByAgent[tipperAgentIdHash]` (`InvalidNonce`)
- Signature:
  - EIP-712 typed data (`TIP_TYPEHASH`) verified onchain, recovered signer must equal `tipper`
- Fee:
  - `TREASURY_FEE_BPS = 250` (2.5%) minted to `treasury`
  - recipient gets `net = gross - fee`
  - caps are enforced on **gross**
- Outcomes:
  - If recipient wallet linked onchain: mint `net` to recipient wallet and emit `TipMint`
  - If not linked: add `net` to `reservedNetByRecipientIdHash[recipientIdHash]` and emit `TipReserved`

## CLAIM (Mint reserved tips after linking)

Entry: `claim(recipientIdHash)` (`onlyClaimer`)

- Contract must not be paused.
- Requires recipient wallet is linked onchain.
- Mints the entire `reservedNetByRecipientIdHash[recipientIdHash]` to the linked wallet.
- Emits `Claimed(recipientIdHash, wallet, amount)`.

## Tokenomics: C+ Emissions (Caps)

Onchain time is UTC derived from Base blocks:

- `day = floor(block.timestamp / 1 days)` (device local time cannot affect caps)
- `startDay` is fixed at deploy

Epochs:

- `EPOCH_DAYS = 7`
- `epoch = floor((day - startDay) / 7)` (epoch 0 is the first 7 days after deploy)

Weekly hard cap (halving every epoch):

- `epochBudget(epoch) = (baseDailyTranche * 7) >> epoch`

Daily unlock (prevents day-1 drain):

- each epoch divides the weekly budget into a daily tranche + remainder
- unlocked amount grows each day; remainder is only unlocked on the final day
- enforced by `EpochUnlockExceeded` even if weekly budget remains

Per-agent daily cap (auto-halves with epochs):

- `dailyTranche = epochBudget(epoch) / 7`
- `perAgentCap = dailyTranche * perAgentDailyMintCapBps / 10_000`
- enforced by `CapExceeded`

Weekly unused-budget burn (capacity burn, auditable):

- `burnUnusedBudgetForEpoch(epoch)` can be called after the epoch ends
- Contract must not be paused.
- computes `unused = max(0, budget - mintedByEpoch[epoch])`
- emits `UnusedBudgetBurned(epoch, unused)`
- implemented as mint-and-burn on the contract itself (net 0 supply change; balances unaffected)
- `tip()` auto-burns the previous epoch once when crossing into a new epoch (best-effort)

## PAY Deflation Primitive

- `burn(amount)`: burns CHITIN from caller and reduces total supply.
