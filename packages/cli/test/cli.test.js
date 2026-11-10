import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ethers } from 'ethers';

function runCli(args, opts = {}) {
  return execFileSync('node', ['dist/chitin.cjs', ...args], {
    encoding: 'utf8',
    ...opts
  });
}

test('wallet:create writes a wallet file and prints its address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chitin-cli-'));
  const walletPath = path.join(dir, 'wallet.json');

  const addr = runCli(['wallet:create', '--out', walletPath]).trim();
  assert.ok(addr.startsWith('0x'));

  const saved = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  assert.equal(saved.address, addr);
  assert.ok(saved.privateKey.startsWith('0x'));

  const addr2 = runCli(['wallet:address', '--wallet', walletPath]).trim();
  assert.equal(addr2, addr);

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test('link:payload prints a JSON payload containing type + address + signature', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chitin-cli-'));
  const walletPath = path.join(dir, 'wallet.json');

  const addr = runCli(['wallet:create', '--out', walletPath]).trim();
  const agentId = '00000000-0000-0000-0000-000000000000';
  const contract = '0x1111111111111111111111111111111111111111';
  const chainId = '8453';
  const out = runCli([
    'link:payload',
    '--wallet',
    walletPath,
    '--moltbook-name',
    'test_agent',
    '--agent-id',
    agentId,
    '--contract',
    contract,
    '--chain-id',
    chainId,
    '--nonce',
    '0',
    '--deadline',
    '9999999999'
  ]);
  const payload = JSON.parse(out);

  assert.equal(payload.type, 'chitin_link');
  assert.equal(payload.moltbookName, 'test_agent');
  assert.equal(payload.address, addr);
  assert.ok(typeof payload.linkNonce === 'string' && payload.linkNonce.startsWith('0x'));
  assert.ok(typeof payload.nonce === 'string' && /^\d+$/.test(payload.nonce));
  assert.ok(typeof payload.deadline === 'string' && /^\d+$/.test(payload.deadline));
  assert.ok(typeof payload.signature === 'string' && payload.signature.startsWith('0x'));

  const agentIdHash = ethers.keccak256(ethers.toUtf8Bytes(agentId));
  const domain = {
    name: 'CHITIN',
    version: '1',
    chainId: BigInt(chainId),
    verifyingContract: contract
  };
  const types = {
    WalletLink: [
      { name: 'agentIdHash', type: 'bytes32' },
      { name: 'oldWallet', type: 'address' },
      { name: 'newWallet', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  };
  const value = {
    agentIdHash,
    oldWallet: ethers.ZeroAddress,
    newWallet: addr,
    nonce: BigInt(payload.nonce),
    deadline: BigInt(payload.deadline)
  };

  assert.equal(ethers.verifyTypedData(domain, types, value, payload.signature).toLowerCase(), addr.toLowerCase());

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test('link:rotate-payload prints a JSON payload with signatures from old + new wallets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chitin-cli-'));
  const oldWalletPath = path.join(dir, 'old-wallet.json');
  const newWalletPath = path.join(dir, 'new-wallet.json');

  const oldAddr = runCli(['wallet:create', '--out', oldWalletPath]).trim();
  const newAddr = runCli(['wallet:create', '--out', newWalletPath]).trim();

  const agentId = '00000000-0000-0000-0000-000000000000';
  const contract = '0x1111111111111111111111111111111111111111';
  const chainId = '8453';
  const out = runCli([
    'link:rotate-payload',
    '--moltbook-name',
    'test_agent',
    '--old-wallet',
    oldWalletPath,
    '--new-wallet',
    newWalletPath,
    '--agent-id',
    agentId,
    '--contract',
    contract,
    '--chain-id',
    chainId,
    '--nonce',
    '0',
    '--deadline',
    '9999999999'
  ]);
  const payload = JSON.parse(out);

  assert.equal(payload.type, 'chitin_rotate');
  assert.equal(payload.moltbookName, 'test_agent');
  assert.equal(payload.oldAddress, oldAddr);
  assert.equal(payload.newAddress, newAddr);
  assert.ok(typeof payload.rotateNonce === 'string' && payload.rotateNonce.startsWith('0x'));
  assert.ok(typeof payload.nonce === 'string' && /^\d+$/.test(payload.nonce));
  assert.ok(typeof payload.deadline === 'string' && /^\d+$/.test(payload.deadline));
  assert.ok(typeof payload.oldSignature === 'string' && payload.oldSignature.startsWith('0x'));
  assert.ok(typeof payload.newSignature === 'string' && payload.newSignature.startsWith('0x'));

  const agentIdHash = ethers.keccak256(ethers.toUtf8Bytes(agentId));
  const domain = {
    name: 'CHITIN',
    version: '1',
    chainId: BigInt(chainId),
    verifyingContract: contract
  };
  const types = {
    WalletLink: [
      { name: 'agentIdHash', type: 'bytes32' },
      { name: 'oldWallet', type: 'address' },
      { name: 'newWallet', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  };
  const value = {
    agentIdHash,
    oldWallet: oldAddr,
    newWallet: newAddr,
    nonce: BigInt(payload.nonce),
    deadline: BigInt(payload.deadline)
  };

  assert.equal(ethers.verifyTypedData(domain, types, value, payload.oldSignature).toLowerCase(), oldAddr.toLowerCase());
  assert.equal(ethers.verifyTypedData(domain, types, value, payload.newSignature).toLowerCase(), newAddr.toLowerCase());

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});
