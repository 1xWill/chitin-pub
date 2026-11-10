import { z } from 'zod';
import { ethers } from 'ethers';
import { dbQuery } from '@/server/db';
import { fetchPostById, fetchProfileByName, findRecentPost } from '@/server/moltbook';
import { getChitinConfig } from '@/server/config';
import { getBaseProvider, getChitinContractAddress, getRelayerSigner } from '@/server/chain';
import { chitinInterface } from '@/server/chitin-abi';

export const LinkPayloadSchema = z
  .object({
    type: z.literal('chitin_link'),
    moltbookName: z.string().min(1).max(64),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    linkNonce: z.string().regex(/^0x[0-9a-fA-F]{8,128}$/),
    issuedAt: z.string().min(1).max(64),
    // Onchain wallet-link signature (EIP-712).
    nonce: z.string().regex(/^\d+$/),
    deadline: z.string().regex(/^\d+$/),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,400}$/)
  })
  .strict();

export const RotatePayloadSchema = z
  .object({
    type: z.literal('chitin_rotate'),
    moltbookName: z.string().min(1).max(64),
    oldAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    newAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    rotateNonce: z.string().regex(/^0x[0-9a-fA-F]{8,128}$/),
    issuedAt: z.string().min(1).max(64),
    // Onchain wallet-rotation signatures (EIP-712).
    nonce: z.string().regex(/^\d+$/),
    deadline: z.string().regex(/^\d+$/),
    oldSignature: z.string().regex(/^0x[0-9a-fA-F]{130,400}$/),
    newSignature: z.string().regex(/^0x[0-9a-fA-F]{130,400}$/)
  })
  .strict();

const AnyLinkPayloadSchema = z.discriminatedUnion('type', [LinkPayloadSchema, RotatePayloadSchema]);

function getLinkSubmolt(): string {
  return getChitinConfig().moltbook.linkSubmolt;
}

export async function submitLinkByPostId(postId: string): Promise<{ agentId: string; address: string }> {
  // Prefer direct fetch by id (cheap + reliable). Submolt is not enforced here; operators can recommend a
  // canonical submolt (e.g. m/chitin), but the proof is in the signed payload itself.
  try {
    const post = await fetchPostById(postId);
    return submitLinkFromPost(post.content, post.author.id, post.author.name, post.id);
  } catch {
    // Fallback: scan the configured submolt feed. This keeps linking working if Moltbook changes or restricts the
    // single-post endpoint shape.
    const submolt = getLinkSubmolt();

    const post = await findRecentPost({
      submolt,
      maxPages: getChitinConfig().moltbook.linkLookupMaxPages,
      match: (p) => p.id === postId
    });

    if (!post) {
      throw new Error(`Link post not found in recent posts for submolt=${submolt}.`);
    }

    return submitLinkFromPost(post.content, post.author.id, post.author.name, post.id);
  }
}

export async function submitLinkByNonce(linkNonce: string): Promise<{ agentId: string; address: string }> {
  const submolt = getLinkSubmolt();

  const post = await findRecentPost({
    submolt,
    maxPages: getChitinConfig().moltbook.linkLookupMaxPages,
    match: (p) => p.content.includes(linkNonce)
  });

  if (!post) {
    throw new Error(`Link post not found in recent posts for submolt=${submolt}.`);
  }

  return submitLinkFromPost(post.content, post.author.id, post.author.name, post.id);
}

function extractJsonCodeblock(content: string): unknown {
  const m = content.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!m) throw new Error('Missing ```json code block in link post content');
  return JSON.parse(m[1]);
}

function agentIdHashFromAgentId(agentId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(agentId));
}

function walletLinkDomain(params: { chainId: bigint; contractAddress: string }) {
  return {
    name: 'CHITIN',
    version: '1',
    chainId: params.chainId,
    verifyingContract: params.contractAddress
  } as const;
}

const WALLET_LINK_TYPES: Record<string, ethers.TypedDataField[]> = {
  WalletLink: [
    { name: 'agentIdHash', type: 'bytes32' },
    { name: 'oldWallet', type: 'address' },
    { name: 'newWallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

async function setOnchainAgentWalletLink(params: {
  agentId: string;
  address: string;
  nonce: bigint;
  deadline: bigint;
  signature: string;
}): Promise<void> {
  const provider = getBaseProvider();
  const idHash = agentIdHashFromAgentId(params.agentId);

  // Avoid relayer gas spend if already linked onchain, and respect self-managed lock.
  const reader = new ethers.Contract(
    getChitinContractAddress(),
    [
      'function walletByAgentIdHash(bytes32 agentIdHash) view returns (address)',
      'function walletLinkLockedByAgentIdHash(bytes32 agentIdHash) view returns (bool)',
      'function paused() view returns (bool)'
    ],
    provider
  );

  // If paused() isn't available (older deployments), treat as unpaused.
  try {
    const paused: boolean = await reader.paused();
    if (paused) throw new Error('paused');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'paused') throw e;
  }

  const current: string = await reader.walletByAgentIdHash(idHash);
  if (current && current !== ethers.ZeroAddress) {
    if (current.toLowerCase() === params.address.toLowerCase()) return;
    let locked = false;
    try {
      locked = Boolean(await reader.walletLinkLockedByAgentIdHash(idHash));
    } catch {
      locked = false;
    }
    if (locked) {
      throw new Error('wallet_link_locked');
    }
    throw new Error('wallet_already_linked_use_rotate');
  }

  const signer = getRelayerSigner(provider);
  const token = new ethers.Contract(getChitinContractAddress(), chitinInterface.fragments, signer);
  const tx = await token.linkAgentWallet(idHash, params.address, params.nonce, params.deadline, params.signature);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error('set_agent_wallet_tx_failed');
  }
}

async function setOnchainAgentWalletRotate(params: {
  agentId: string;
  oldAddress: string;
  newAddress: string;
  nonce: bigint;
  deadline: bigint;
  oldSignature: string;
  newSignature: string;
}): Promise<void> {
  const provider = getBaseProvider();
  const idHash = agentIdHashFromAgentId(params.agentId);

  const reader = new ethers.Contract(
    getChitinContractAddress(),
    [
      'function walletByAgentIdHash(bytes32 agentIdHash) view returns (address)',
      'function walletLinkLockedByAgentIdHash(bytes32 agentIdHash) view returns (bool)',
      'function paused() view returns (bool)'
    ],
    provider
  );

  try {
    const paused: boolean = await reader.paused();
    if (paused) throw new Error('paused');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'paused') throw e;
  }

  const current: string = await reader.walletByAgentIdHash(idHash);
  if (!current || current === ethers.ZeroAddress) throw new Error('not_linked_yet');
  if (current.toLowerCase() !== params.oldAddress.toLowerCase()) throw new Error('old_address_mismatch');

  let locked = false;
  try {
    locked = Boolean(await reader.walletLinkLockedByAgentIdHash(idHash));
  } catch {
    locked = false;
  }
  if (locked) {
    throw new Error('wallet_link_locked');
  }

  const signer = getRelayerSigner(provider);
  const token = new ethers.Contract(getChitinContractAddress(), chitinInterface.fragments, signer);
  const tx = await token.rotateAgentWallet(
    idHash,
    params.oldAddress,
    params.newAddress,
    params.nonce,
    params.deadline,
    params.oldSignature,
    params.newSignature
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error('rotate_agent_wallet_tx_failed');
  }
}

export async function submitLinkFromPost(
  postContent: string,
  authorId: string,
  authorName: string,
  postId: string
): Promise<{ agentId: string; address: string }> {
  const raw = extractJsonCodeblock(postContent);
  const parsed = AnyLinkPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('invalid_link_payload');
  }
  const payload = parsed.data;

  const profile = await fetchProfileByName(authorName);
  if (String(profile.id).toLowerCase() !== String(authorId).toLowerCase()) {
    throw new Error('author_identity_mismatch');
  }

  // Upsert agent profile first (name/claimed/x-owner can change).
  await dbQuery(
    `
    INSERT INTO agents (
      moltbook_agent_id, moltbook_name, description, is_claimed,
      owner_x_handle, owner_x_name, owner_x_avatar, owner_x_bio,
      owner_x_follower_count, owner_x_following_count, owner_x_verified,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11,
      now()
    )
    ON CONFLICT (moltbook_agent_id)
    DO UPDATE SET
      moltbook_name=EXCLUDED.moltbook_name,
      description=EXCLUDED.description,
      is_claimed=EXCLUDED.is_claimed,
      owner_x_handle=EXCLUDED.owner_x_handle,
      owner_x_name=EXCLUDED.owner_x_name,
      owner_x_avatar=EXCLUDED.owner_x_avatar,
      owner_x_bio=EXCLUDED.owner_x_bio,
      owner_x_follower_count=EXCLUDED.owner_x_follower_count,
      owner_x_following_count=EXCLUDED.owner_x_following_count,
      owner_x_verified=EXCLUDED.owner_x_verified,
      updated_at=now()
    `,
    [
      profile.id,
      profile.name,
      profile.description,
      profile.is_claimed,
      profile.owner?.x_handle ?? null,
      profile.owner?.x_name ?? null,
      profile.owner?.x_avatar ?? null,
      profile.owner?.x_bio ?? null,
      profile.owner?.x_follower_count ?? null,
      profile.owner?.x_following_count ?? null,
      profile.owner?.x_verified ?? null
    ]
  );

  const provider = getBaseProvider();
  const { chainId } = await provider.getNetwork();
  const domain = walletLinkDomain({ chainId, contractAddress: getChitinContractAddress() });
  const agentIdHash = agentIdHashFromAgentId(profile.id);

  if (payload.type === 'chitin_link') {
    if (payload.moltbookName !== authorName) {
      throw new Error('moltbookName does not match the Moltbook post author');
    }

    const nonce = BigInt(payload.nonce);
    const deadline = BigInt(payload.deadline);

    const recovered = ethers.verifyTypedData(
      domain,
      WALLET_LINK_TYPES,
      {
        agentIdHash,
        oldWallet: ethers.ZeroAddress,
        newWallet: payload.address,
        nonce,
        deadline
      },
      payload.signature
    );

    if (recovered.toLowerCase() !== payload.address.toLowerCase()) {
      throw new Error('invalid_wallet_link_signature');
    }

    const existing = await dbQuery<{ address: string }>(
      `SELECT address FROM agent_wallets WHERE moltbook_agent_id=$1 LIMIT 1`,
      [profile.id]
    );
    if (existing.length > 0) {
      const oldAddr = existing[0].address.toLowerCase();
      const newAddr = payload.address.toLowerCase();
      if (oldAddr !== newAddr) {
        throw new Error('wallet_already_linked_use_rotate');
      }
    }

    await setOnchainAgentWalletLink({
      agentId: profile.id,
      address: payload.address,
      nonce,
      deadline,
      signature: payload.signature
    });

    await dbQuery(
      `
      INSERT INTO agent_wallets (
        moltbook_agent_id, address, linked_post_id, link_nonce, issued_at, signature, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (moltbook_agent_id)
      DO UPDATE SET
        linked_post_id=EXCLUDED.linked_post_id,
        link_nonce=EXCLUDED.link_nonce,
        issued_at=EXCLUDED.issued_at,
        signature=EXCLUDED.signature,
        updated_at=now()
      `,
      [profile.id, payload.address, postId, payload.linkNonce, payload.issuedAt, payload.signature]
    );

    await dbQuery(
      `
      INSERT INTO agent_wallet_events (
        moltbook_agent_id, kind, old_address, new_address, moltbook_post_id,
        nonce, issued_at, old_signature, new_signature
      )
      VALUES ($1,'link',NULL,$2,$3,$4,$5,NULL,$6)
      `,
      [profile.id, payload.address, postId, payload.linkNonce, payload.issuedAt, payload.signature]
    );

    return { agentId: profile.id, address: payload.address };
  }

  if (payload.type === 'chitin_rotate') {
    if (payload.moltbookName !== authorName) {
      throw new Error('moltbookName does not match the Moltbook post author');
    }

    const existing = await dbQuery<{ address: string }>(
      `SELECT address FROM agent_wallets WHERE moltbook_agent_id=$1 LIMIT 1`,
      [profile.id]
    );
    if (existing.length === 0) {
      throw new Error('not_linked_yet');
    }

    if (existing[0].address.toLowerCase() !== payload.oldAddress.toLowerCase()) {
      throw new Error('old_address_mismatch');
    }

    const nonce = BigInt(payload.nonce);
    const deadline = BigInt(payload.deadline);

    const recoveredOld = ethers.verifyTypedData(
      domain,
      WALLET_LINK_TYPES,
      {
        agentIdHash,
        oldWallet: payload.oldAddress,
        newWallet: payload.newAddress,
        nonce,
        deadline
      },
      payload.oldSignature
    );

    const recoveredNew = ethers.verifyTypedData(
      domain,
      WALLET_LINK_TYPES,
      {
        agentIdHash,
        oldWallet: payload.oldAddress,
        newWallet: payload.newAddress,
        nonce,
        deadline
      },
      payload.newSignature
    );

    if (recoveredOld.toLowerCase() !== payload.oldAddress.toLowerCase()) {
      throw new Error('invalid_old_signature');
    }
    if (recoveredNew.toLowerCase() !== payload.newAddress.toLowerCase()) {
      throw new Error('invalid_new_signature');
    }

    await setOnchainAgentWalletRotate({
      agentId: profile.id,
      oldAddress: payload.oldAddress,
      newAddress: payload.newAddress,
      nonce,
      deadline,
      oldSignature: payload.oldSignature,
      newSignature: payload.newSignature
    });

    await dbQuery(
      `
      UPDATE agent_wallets
      SET
        address=$2,
        linked_post_id=$3,
        link_nonce=$4,
        issued_at=$5,
        signature=$6,
        updated_at=now()
      WHERE moltbook_agent_id=$1
      `,
      [profile.id, payload.newAddress, postId, payload.rotateNonce, payload.issuedAt, payload.newSignature]
    );

    await dbQuery(
      `
      INSERT INTO agent_wallet_events (
        moltbook_agent_id, kind, old_address, new_address, moltbook_post_id,
        nonce, issued_at, old_signature, new_signature
      )
      VALUES ($1,'rotate',$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        profile.id,
        payload.oldAddress,
        payload.newAddress,
        postId,
        payload.rotateNonce,
        payload.issuedAt,
        payload.oldSignature,
        payload.newSignature
      ]
    );

    return { agentId: profile.id, address: payload.newAddress };
  }

  throw new Error('invalid_link_payload');
}

export async function resolveByName(name: string): Promise<{ agentId: string; address: string } | null> {
  // Resolve via Moltbook profile to survive agent renames.
  const prof = await fetchProfileByName(name);
  const rows = await dbQuery<{ address: string }>(
    `SELECT address FROM agent_wallets WHERE moltbook_agent_id=$1 LIMIT 1`,
    [prof.id]
  );
  if (rows.length === 0) return null;
  return { agentId: prof.id, address: rows[0].address };
}

export async function resolveByAddress(address: string): Promise<{ agentId: string; name: string } | null> {
  const rows = await dbQuery<{ moltbook_agent_id: string; moltbook_name: string }>(
    `
    SELECT a.moltbook_agent_id, a.moltbook_name
    FROM agent_wallets w
    JOIN agents a ON a.moltbook_agent_id=w.moltbook_agent_id
    WHERE lower(w.address)=lower($1)
    LIMIT 1
    `,
    [address]
  );

  if (rows.length === 0) return null;
  return { agentId: rows[0].moltbook_agent_id, name: rows[0].moltbook_name };
}
