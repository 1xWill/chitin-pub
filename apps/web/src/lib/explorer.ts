export function explorerTxUrl(chainId: number, txHash: string): string {
  const base = explorerBase(chainId);
  if (!base) return '#';
  return `${base}/tx/${txHash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  const base = explorerBase(chainId);
  if (!base) return '#';
  return `${base}/address/${address}`;
}

function explorerBase(chainId: number): string | null {
  // Base Mainnet
  if (chainId === 8453) return 'https://basescan.org';
  // Base Sepolia
  if (chainId === 84532) return 'https://sepolia.basescan.org';
  return null;
}

