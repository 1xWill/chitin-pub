import { ethers } from 'ethers';

export const chitinInterface = new ethers.Interface([
  'function mintStatus(address tipperWallet) view returns (uint256 day,uint256 epoch,uint256 dayInEpoch,uint256 epochBudget,uint256 epochUnlocked,uint256 epochUsed,uint256 dailyTranche,uint256 effectivePerAgentCap,uint256 globalUsedToday,uint256 tipperUsed,uint256 nextNonce)',
  'function paused() view returns (bool)',
  'function setPaused(bool isPaused)',
  'function linkNoncesByAgentIdHash(bytes32 agentIdHash) view returns (uint256)',
  'function linkAgentWallet(bytes32 agentIdHash,address wallet,uint256 nonce,uint256 deadline,bytes walletSignature)',
  'function rotateAgentWallet(bytes32 agentIdHash,address oldWallet,address newWallet,uint256 nonce,uint256 deadline,bytes oldWalletSignature,bytes newWalletSignature)',
  'function lockAgentWallet(bytes32 agentIdHash)',
  'function rotateLockedAgentWallet(address newWallet)',
  'function walletLinkLockedByAgentIdHash(bytes32 agentIdHash) view returns (bool)',
  'function agentIdHashByWallet(address wallet) view returns (bytes32)',
  'function walletByAgentIdHash(bytes32 agentIdHash) view returns (address)',
  'function claimable(bytes32 recipientIdHash) view returns (uint256)',
  'function claim(bytes32 recipientIdHash) returns (uint256)',
  'function tip(address tipper,bytes32 recipientIdHash,uint256 grossAmount,uint256 nonce,uint256 deadline,bytes32 contextHash,bytes signature)',
  'function burnUnusedBudgetForEpoch(uint256 epoch)',
  'function unusedBudgetBurned(uint256 epoch) view returns (bool)',
  'function unusedBudgetBurnedByEpoch(uint256 epoch) view returns (uint256)',
  'function startDay() view returns (uint256)',
  'function burn(uint256 amount)',
  'event Paused(bool paused)',
  'event WalletLinkLocked(bytes32 indexed agentIdHash,address indexed wallet)',
  'event TipMint(address indexed tipper,bytes32 indexed recipientIdHash,address indexed recipient,uint256 grossAmount,uint256 netAmount,uint256 treasuryAmount,bytes32 contextHash,uint256 day,uint256 nonce)',
  'event TipReserved(address indexed tipper,bytes32 indexed recipientIdHash,uint256 grossAmount,uint256 netAmount,uint256 treasuryAmount,bytes32 contextHash,uint256 day,uint256 nonce)',
  'event Claimed(bytes32 indexed recipientIdHash,address indexed recipient,uint256 amount)',
  'event UnusedBudgetBurned(uint256 indexed epoch,uint256 amount)',
  'event Burned(address indexed burner,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);

export const TIP_TYPES: Record<string, ethers.TypedDataField[]> = {
  Tip: [
    { name: 'tipper', type: 'address' },
    { name: 'recipientIdHash', type: 'bytes32' },
    { name: 'grossAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'contextHash', type: 'bytes32' }
  ]
};
