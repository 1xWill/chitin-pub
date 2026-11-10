// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// CHITIN: currency for Claw agents (Base).
///
/// Key properties:
/// - Gasless tips via relayer (EIP-712 signature).
/// - Epoch-based emissions (7-day epochs):
///   - Weekly hard cap halves each epoch.
///   - Daily unlock prevents "week drained on day 1".
///   - Unused weekly budget is burned at epoch end.
/// - Recipients are addressed by identity hash (bytes32). If recipient wallet is linked onchain, mint immediately;
///   otherwise reserve and allow claim after linking.
contract Chitin is ERC20, EIP712, Ownable {
    using ECDSA for bytes32;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TREASURY_FEE_BPS = 250; // 2.5%
    uint256 public constant EPOCH_DAYS = 7;

    bytes32 public constant TIP_TYPEHASH =
        keccak256(
            "Tip(address tipper,bytes32 recipientIdHash,uint256 grossAmount,uint256 nonce,uint256 deadline,bytes32 contextHash)"
        );

    // Gasless wallet linking is relayer-submitted but wallet-authorized.
    // The relayer/claimer must provide the wallet's EIP-712 signature to link/rotate.
    bytes32 public constant WALLET_LINK_TYPEHASH =
        keccak256("WalletLink(bytes32 agentIdHash,address oldWallet,address newWallet,uint256 nonce,uint256 deadline)");

    event TipMint(
        address indexed tipper,
        bytes32 indexed recipientIdHash,
        address indexed recipient,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 treasuryAmount,
        bytes32 contextHash,
        uint256 day,
        uint256 nonce
    );

    event TipReserved(
        address indexed tipper,
        bytes32 indexed recipientIdHash,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 treasuryAmount,
        bytes32 contextHash,
        uint256 day,
        uint256 nonce
    );

    event Claimed(bytes32 indexed recipientIdHash, address indexed recipient, uint256 amount);

    event UnusedBudgetBurned(uint256 indexed epoch, uint256 amount);

    event Burned(address indexed burner, uint256 amount);

    event Paused(bool paused);

    event WalletLinkLocked(bytes32 indexed agentIdHash, address indexed wallet);

    address public treasury;
    address public claimer;

    bool public paused;

    // Total amount burned via burn(), reducing totalSupply().
    uint256 public totalBurned;

    // Emissions start day (UTC day index) fixed at deploy.
    uint256 public immutable startDay;

    // Epoch 0 daily tranche (gross) and per-agent daily cap ratio (BPS of tranche), fixed at deploy for predictable
    // hard-cap math.
    uint256 public immutable baseDailyTranche;
    uint256 public immutable perAgentDailyMintCapBps;

    // Onchain registry: one active wallet per agent identity hash.
    mapping(bytes32 => address) public walletByAgentIdHash;
    mapping(address => bytes32) public agentIdHashByWallet;

    // If an agent locks their wallet link, only the wallet owner can rotate (requires gas);
    // the operator/claimer can no longer update it.
    mapping(bytes32 => bool) public walletLinkLockedByAgentIdHash;

    // Replay protection + per-agent cap usage (keyed by agent identity hash).
    mapping(bytes32 => uint256) public noncesByAgent;

    // Replay protection for gasless linking/rotation (keyed by agent identity hash).
    mapping(bytes32 => uint256) public linkNoncesByAgentIdHash;

    // Daily mint usage tracking (by *gross* amount). This is for per-agent daily caps and analytics.
    mapping(uint256 => uint256) public globalMintedByDay;
    mapping(uint256 => mapping(bytes32 => uint256)) public mintedByDayByTipperAgent;

    // Epoch mint usage tracking (by *gross* amount) and weekly unused-budget burn accounting.
    mapping(uint256 => uint256) public mintedByEpoch;
    mapping(uint256 => bool) public unusedBudgetBurned;
    mapping(uint256 => uint256) public unusedBudgetBurnedByEpoch;

    // Claimable tip reserves (net amounts) keyed by recipient identity hash.
    mapping(bytes32 => uint256) public reservedNetByRecipientIdHash;

    error InvalidSignature();
    error InvalidNonce();
    error DeadlineExpired();
    error InvalidRecipient();
    error SelfTipNotAllowed();
    error CapExceeded();
    error NotClaimer();
    error NothingToClaim();
    error WalletNotLinked();
    error WalletAlreadyLinked();
    error AlreadyBurned();
    error EpochNotEnded();
    error EpochBudgetExceeded();
    error EpochUnlockExceeded();
    error PausedError();
    error WalletLinkLockedError();
    error NotWalletOwner();
    error NotSelfManaged();

    constructor(
        address initialOwner,
        address initialTreasury,
        uint256 genesisMint,
        uint256 baseDailyTranche_,
        uint256 perAgentDailyMintCapBps_
    ) ERC20("Chitin Claw Money", "CHITIN") EIP712("CHITIN", "1") Ownable(initialOwner) {
        require(initialTreasury != address(0), "treasury=0");
        require(baseDailyTranche_ > 0, "tranche=0");
        require(perAgentDailyMintCapBps_ <= BPS_DENOMINATOR, "perBps>1");

        treasury = initialTreasury;
        claimer = initialOwner;
        startDay = _day();
        baseDailyTranche = baseDailyTranche_;
        perAgentDailyMintCapBps = perAgentDailyMintCapBps_;

        if (genesisMint > 0) {
            _mint(initialTreasury, genesisMint);
        }
    }

    modifier onlyClaimer() {
        if (msg.sender != claimer && msg.sender != owner()) revert NotClaimer();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    function setPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit Paused(isPaused);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "treasury=0");
        treasury = newTreasury;
    }

    function setClaimer(address newClaimer) external onlyOwner {
        require(newClaimer != address(0), "claimer=0");
        claimer = newClaimer;
    }

    /// Link an agent wallet (gasless via relayer, wallet-authorized).
    /// One wallet per agent and one agent per wallet.
    function linkAgentWallet(
        bytes32 agentIdHash,
        address wallet,
        uint256 nonce,
        uint256 deadline,
        bytes calldata walletSignature
    ) external onlyClaimer whenNotPaused {
        if (agentIdHash == bytes32(0)) revert InvalidRecipient();
        if (wallet == address(0)) revert InvalidRecipient();
        if (walletLinkLockedByAgentIdHash[agentIdHash]) revert WalletLinkLockedError();
        if (walletByAgentIdHash[agentIdHash] != address(0)) revert WalletAlreadyLinked();

        _setAgentWalletBySig(agentIdHash, address(0), wallet, nonce, deadline, bytes(""), walletSignature);
    }

    /// Rotate an agent wallet (gasless via relayer). Requires signatures from both old + new wallets.
    function rotateAgentWallet(
        bytes32 agentIdHash,
        address oldWallet,
        address newWallet,
        uint256 nonce,
        uint256 deadline,
        bytes calldata oldWalletSignature,
        bytes calldata newWalletSignature
    ) external onlyClaimer whenNotPaused {
        if (agentIdHash == bytes32(0)) revert InvalidRecipient();
        if (oldWallet == address(0)) revert InvalidRecipient();
        if (newWallet == address(0)) revert InvalidRecipient();
        if (walletLinkLockedByAgentIdHash[agentIdHash]) revert WalletLinkLockedError();

        address current = walletByAgentIdHash[agentIdHash];
        if (current == address(0)) revert WalletNotLinked();
        if (current != oldWallet) revert InvalidSignature();

        _setAgentWalletBySig(agentIdHash, oldWallet, newWallet, nonce, deadline, oldWalletSignature, newWalletSignature);
    }

    function _setAgentWalletBySig(
        bytes32 agentIdHash,
        address oldWallet,
        address newWallet,
        uint256 nonce,
        uint256 deadline,
        bytes memory oldWalletSignature,
        bytes memory newWalletSignature
    ) internal {
        if (block.timestamp > deadline) revert DeadlineExpired();

        uint256 expectedNonce = linkNoncesByAgentIdHash[agentIdHash];
        if (nonce != expectedNonce) revert InvalidNonce();

        bytes32 currentAgent = agentIdHashByWallet[newWallet];
        if (currentAgent != bytes32(0) && currentAgent != agentIdHash) revert WalletAlreadyLinked();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(WALLET_LINK_TYPEHASH, agentIdHash, oldWallet, newWallet, nonce, deadline))
        );

        address recoveredNew = ECDSA.recover(digest, newWalletSignature);
        if (recoveredNew != newWallet) revert InvalidSignature();

        if (oldWallet != address(0)) {
            address recoveredOld = ECDSA.recover(digest, oldWalletSignature);
            if (recoveredOld != oldWallet) revert InvalidSignature();
        }

        // Effects
        linkNoncesByAgentIdHash[agentIdHash] = expectedNonce + 1;

        // Clear old wallet mapping if rotating.
        if (oldWallet != address(0) && oldWallet != newWallet) {
            agentIdHashByWallet[oldWallet] = bytes32(0);
        }

        walletByAgentIdHash[agentIdHash] = newWallet;
        agentIdHashByWallet[newWallet] = agentIdHash;
    }

    /// Permanently lock an agent's wallet link (migration to higher security).
    /// Once locked, the operator/claimer cannot update the agent's wallet mapping.
    /// This requires gas and must be called by the currently-linked wallet.
    function lockAgentWallet(bytes32 agentIdHash) external {
        address current = walletByAgentIdHash[agentIdHash];
        if (current == address(0)) revert WalletNotLinked();
        if (msg.sender != current) revert NotWalletOwner();
        if (walletLinkLockedByAgentIdHash[agentIdHash]) return;
        walletLinkLockedByAgentIdHash[agentIdHash] = true;
        emit WalletLinkLocked(agentIdHash, current);
    }

    /// Rotate a locked wallet link. This requires gas and must be called by the currently-linked wallet.
    /// (Useful after "locking" an agent to self-managed mode.)
    function rotateLockedAgentWallet(address newWallet) external whenNotPaused {
        if (newWallet == address(0)) revert InvalidRecipient();

        bytes32 agentIdHash = agentIdHashByWallet[msg.sender];
        if (agentIdHash == bytes32(0)) revert WalletNotLinked();
        if (!walletLinkLockedByAgentIdHash[agentIdHash]) revert NotSelfManaged();

        bytes32 currentAgent = agentIdHashByWallet[newWallet];
        if (currentAgent != bytes32(0) && currentAgent != agentIdHash) revert WalletAlreadyLinked();

        // Clear old wallet mapping, then set the new one.
        agentIdHashByWallet[msg.sender] = bytes32(0);
        walletByAgentIdHash[agentIdHash] = newWallet;
        agentIdHashByWallet[newWallet] = agentIdHash;
    }

    function mintStatus(address tipperWallet)
        external
        view
        returns (
            uint256 day,
            uint256 epoch,
            uint256 dayInEpoch,
            uint256 epochBudget,
            uint256 epochUnlocked,
            uint256 epochUsed,
            uint256 dailyTranche,
            uint256 effectivePerAgentCap,
            uint256 globalUsedToday,
            uint256 tipperUsed,
            uint256 nextNonce
        )
    {
        day = _day();
        (epoch, dayInEpoch) = _epochForDay(day);
        (epochBudget, epochUnlocked, dailyTranche) = _epochBudgetAndUnlocked(epoch, dayInEpoch);
        epochUsed = mintedByEpoch[epoch];
        globalUsedToday = globalMintedByDay[day];
        effectivePerAgentCap = (dailyTranche * perAgentDailyMintCapBps) / BPS_DENOMINATOR;

        bytes32 tipperAgent = agentIdHashByWallet[tipperWallet];
        if (tipperAgent == bytes32(0)) {
            tipperUsed = 0;
            nextNonce = 0;
        } else {
            tipperUsed = mintedByDayByTipperAgent[day][tipperAgent];
            nextNonce = noncesByAgent[tipperAgent];
        }
    }

    function burnUnusedBudgetForEpoch(uint256 epoch) external whenNotPaused {
        uint256 currentEpoch = _currentEpoch();
        if (epoch >= currentEpoch) revert EpochNotEnded();
        if (unusedBudgetBurned[epoch]) revert AlreadyBurned();
        _burnUnusedBudgetForEpoch(epoch);
    }

    function _burnUnusedBudgetForEpoch(uint256 epoch) internal {
        uint256 budget = _epochBudget(epoch);
        uint256 used = mintedByEpoch[epoch];

        uint256 unused = used >= budget ? 0 : (budget - used);
        unusedBudgetBurned[epoch] = true;
        unusedBudgetBurnedByEpoch[epoch] = unused;

        // "Burn" unused emission capacity onchain without changing end-state total supply:
        // mint then burn the same amount (net 0 supply change) so it's auditable via events/state.
        if (unused > 0) {
            _mint(address(this), unused);
            _burn(address(this), unused);
        }

        emit UnusedBudgetBurned(epoch, unused);
    }

    function _autoBurnPreviousEpochIfNeeded(uint256 currentEpoch) internal {
        if (currentEpoch == 0) return;
        uint256 prev = currentEpoch - 1;
        if (unusedBudgetBurned[prev]) return;
        _burnUnusedBudgetForEpoch(prev);
    }

    /// Burn CHITIN from the caller, reducing total supply.
    function burn(uint256 amount) external {
        totalBurned += amount;
        _burn(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }

    /// Gasless tip: recipient is addressed by identity hash; mints immediately if recipient wallet is linked,
    /// otherwise reserves for later claim.
    function tip(
        address tipper,
        bytes32 recipientIdHash,
        uint256 grossAmount,
        uint256 nonce,
        uint256 deadline,
        bytes32 contextHash,
        bytes calldata signature
    ) external whenNotPaused {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (recipientIdHash == bytes32(0)) revert InvalidRecipient();

        uint256 day = _day();
        (uint256 epoch, uint256 dayInEpoch) = _epochForDay(day);
        _autoBurnPreviousEpochIfNeeded(epoch);

        bytes32 tipperAgent = agentIdHashByWallet[tipper];
        if (tipperAgent == bytes32(0)) revert WalletNotLinked();
        if (tipperAgent == recipientIdHash) revert SelfTipNotAllowed();

        uint256 expectedNonce = noncesByAgent[tipperAgent];
        if (nonce != expectedNonce) revert InvalidNonce();

        (uint256 epochBudget, uint256 unlocked, uint256 tranche) = _epochBudgetAndUnlocked(epoch, dayInEpoch);
        uint256 newEpochUsed = mintedByEpoch[epoch] + grossAmount;
        if (newEpochUsed > epochBudget) revert EpochBudgetExceeded();
        if (newEpochUsed > unlocked) revert EpochUnlockExceeded();

        uint256 perCap = (tranche * perAgentDailyMintCapBps) / BPS_DENOMINATOR;
        uint256 newTipper = mintedByDayByTipperAgent[day][tipperAgent] + grossAmount;
        if (newTipper > perCap) revert CapExceeded();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TIP_TYPEHASH, tipper, recipientIdHash, grossAmount, nonce, deadline, contextHash))
        );
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != tipper) revert InvalidSignature();

        // Effects
        noncesByAgent[tipperAgent] = expectedNonce + 1;
        globalMintedByDay[day] = globalMintedByDay[day] + grossAmount;
        mintedByDayByTipperAgent[day][tipperAgent] = newTipper;
        mintedByEpoch[epoch] = newEpochUsed;

        uint256 treasuryAmount = (grossAmount * TREASURY_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = grossAmount - treasuryAmount;
        if (netAmount == 0) revert CapExceeded();

        if (treasuryAmount > 0) _mint(treasury, treasuryAmount);

        address recipientWallet = walletByAgentIdHash[recipientIdHash];
        if (recipientWallet != address(0)) {
            _mint(recipientWallet, netAmount);
            emit TipMint(tipper, recipientIdHash, recipientWallet, grossAmount, netAmount, treasuryAmount, contextHash, day, nonce);
        } else {
            reservedNetByRecipientIdHash[recipientIdHash] += netAmount;
            emit TipReserved(tipper, recipientIdHash, grossAmount, netAmount, treasuryAmount, contextHash, day, nonce);
        }
    }

    function claimable(bytes32 recipientIdHash) external view returns (uint256) {
        return reservedNetByRecipientIdHash[recipientIdHash];
    }

    function claim(bytes32 recipientIdHash) external onlyClaimer whenNotPaused returns (uint256 amount) {
        address recipient = walletByAgentIdHash[recipientIdHash];
        if (recipient == address(0)) revert WalletNotLinked();

        amount = reservedNetByRecipientIdHash[recipientIdHash];
        if (amount == 0) revert NothingToClaim();

        reservedNetByRecipientIdHash[recipientIdHash] = 0;
        _mint(recipient, amount);
        emit Claimed(recipientIdHash, recipient, amount);
    }

    function _day() internal view returns (uint256) {
        // UTC day index derived from Base block timestamp.
        return block.timestamp / 1 days;
    }

    function _currentEpoch() internal view returns (uint256) {
        (uint256 epoch, ) = _epochForDay(_day());
        return epoch;
    }

    function _epochForDay(uint256 day) internal view returns (uint256 epoch, uint256 dayInEpoch) {
        if (day <= startDay) return (0, 0);
        uint256 offset = day - startDay;
        epoch = offset / EPOCH_DAYS;
        dayInEpoch = offset % EPOCH_DAYS;
        return (epoch, dayInEpoch);
    }

    function _epochBudget(uint256 epoch) internal view returns (uint256) {
        // Epoch budget halves every epoch.
        // Epoch 0 budget = baseDailyTranche * 7.
        uint256 w0 = baseDailyTranche * EPOCH_DAYS;
        return w0 >> epoch;
    }

    function _epochBudgetAndUnlocked(uint256 epoch, uint256 dayInEpoch)
        internal
        view
        returns (uint256 epochBudget, uint256 epochUnlocked, uint256 tranche)
    {
        epochBudget = _epochBudget(epoch);
        tranche = epochBudget / EPOCH_DAYS;
        uint256 remainder = epochBudget - (tranche * EPOCH_DAYS);

        epochUnlocked = tranche * (dayInEpoch + 1);
        // Allow the leftover rounding remainder only on the final day of the epoch so the full weekly budget can be used.
        if (dayInEpoch == EPOCH_DAYS - 1) {
            epochUnlocked += remainder;
        }
        return (epochBudget, epochUnlocked, tranche);
    }
}
