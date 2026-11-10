import { ethers } from 'ethers';
import { getChitinConfig } from '@/server/config';
import '@/server/dotenv';

let baseProvider: ethers.JsonRpcProvider | null = null;

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing env ' + name);
  return v;
}

export function getBaseProvider(): ethers.JsonRpcProvider {
  if (baseProvider) return baseProvider;

  const cfg = getChitinConfig();
  const rpcUrl = (process.env.BASE_RPC_URL ?? '').trim() || cfg.chain.publicRpcUrl;
  const network = ethers.Network.from(cfg.chain.chainId);
  baseProvider = new ethers.JsonRpcProvider(rpcUrl, network, {
    staticNetwork: network
  });
  return baseProvider;
}

export function getChitinContractAddress(): string {
  const addr = getChitinConfig().chain.contractAddress;
  if (!addr) throw new Error('Missing chain.contractAddress in chitin.config.json');
  return addr;
}

export function getRelayerSigner(provider: ethers.JsonRpcProvider): ethers.Wallet {
  return new ethers.Wallet(requiredEnv('RELAYER_PRIVATE_KEY'), provider);
}
