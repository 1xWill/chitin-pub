export type ActivityStatus = 'pending' | 'confirmed' | 'failed';

export type ActivityView =
  | {
      // Pending tip before onchain reconciliation determines TipMint vs TipReserved.
      kind: 'tip';
      txHash: string;
      blockNumber: number | null;
      createdAt: string;
      tipper: string;
      tipperName: string | null;
      recipientAgentId: string;
      recipientName: string | null;
      recipientIdHash: string;
      grossAmount: string;
      context: string | null;
      status: ActivityStatus;
    }
  | {
      // A claim tx (triggered after a recipient links a wallet).
      // We keep it as a separate row to make the feed more "alive" (the original tip_reserve row still updates to claimed).
      kind: 'claim';
      txHash: string;
      blockNumber: number | null;
      createdAt: string;
      recipient: string;
      recipientAgentId: string;
      recipientName: string | null;
      netAmount: string;
      status: ActivityStatus;
    }
  | {
      kind: 'tip_mint';
      txHash: string;
      blockNumber: number | null;
      createdAt: string;
      tipper: string;
      tipperName: string | null;
      recipient: string;
      recipientName: string | null;
      grossAmount: string;
      netAmount: string | null;
      treasuryAmount: string | null;
      context: string | null;
      status: ActivityStatus;
    }
  | {
      kind: 'tip_reserve';
      txHash: string;
      blockNumber: number | null;
      createdAt: string;
      tipper: string;
      tipperName: string | null;
      recipientAgentId: string;
      recipientName: string | null;
      recipientIdHash: string;
      grossAmount: string;
      netAmount: string | null;
      treasuryAmount: string | null;
      claimed: boolean;
      claimTxHash: string | null;
      context: string | null;
      status: ActivityStatus;
    }
  | {
      // Pay is either:
      // - "tax unpaid": plain ERC-20 transfer submitted to backend
      // - "tax paid": transfer + verified burn tx
      kind: 'pay';
      txHash: string; // transfer tx hash
      burnTxHash: string | null;
      blockNumber: number | null;
      createdAt: string;
      from: string;
      fromName: string | null;
      to: string;
      toName: string | null;
      netAmount: string; // transfer value
      grossAmount: string | null; // net + burn (only known when burn is verified)
      burnAmount: string | null; // burn() amount (only set when verified)
      taxStatus: 'paid' | 'unpaid';
      context: string | null;
      status: ActivityStatus;
    };
