import { z } from 'zod';
import { ethers } from 'ethers';
import { dbQuery } from '@/server/db';
import { fetchProfileByName } from '@/server/moltbook';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';
import { chitinInterface } from '@/server/chitin-abi';
import { fetchMoltxPostById, parseMoltxPostIdFromUrl } from '@/server/moltx';

const AliasPayloadSchema = z
  .object({
    type: z.literal('chitin_alias_v1'),
    moltbookName: z.string().min(1).max(64),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    aliasNonce: z.string().regex(/^0x[0-9a-fA-F]{8,128}$/),
    issuedAt: z.string().min(1).max(64),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,400}$/)
  })
  .strict();

function extractJsonCodeblock(content: string): unknown {
  const m = content.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!m) throw new Error('Missing ```json code block in alias proof post');
  return JSON.parse(m[1]);
}

export function aliasMessage(payload: z.infer<typeof AliasPayloadSchema>): string {
  return [
    'CHITIN_ALIAS_V1',
    'moltbookName=' + payload.moltbookName,
    'address=' + payload.address,
    'aliasNonce=' + payload.aliasNonce,
    'issuedAt=' + payload.issuedAt
  ].join('|');
}

function agentIdHashFromAgentId(agentId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(agentId));
}

async function upsertAgentFromMoltbookName(moltbookName: string): Promise<{ agentId: string; name: string }> {
  const profile = await fetchProfileByName(moltbookName);

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

  return { agentId: profile.id, name: profile.name };
}

async function verifyOnchainWalletLink(agentId: string, address: string): Promise<void> {
  const provider = getBaseProvider();
  const token = new ethers.Contract(getChitinContractAddress(), chitinInterface.fragments, provider);
  const linked: string = await token.walletByAgentIdHash(agentIdHashFromAgentId(agentId));
  if (!linked || linked === ethers.ZeroAddress) throw new Error('wallet_not_linked');
  if (linked.toLowerCase() !== address.toLowerCase()) throw new Error('wallet_not_currently_linked');
}

export async function submitMoltxAliasProof(proofUrl: string): Promise<{
  moltbookAgentId: string;
  moltbookName: string;
  moltxAgentId: string;
  proofPostId: string;
}> {
  const postId = parseMoltxPostIdFromUrl(proofUrl);
  if (!postId) throw new Error('invalid_moltx_proof_url');

  const post = await fetchMoltxPostById(postId);
  const content = post.content ?? '';
  if (!content) throw new Error('moltx_post_missing_content');

  const raw = extractJsonCodeblock(content);
  const parsed = AliasPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new Error('invalid_alias_payload');
  const payload = parsed.data;

  const msg = aliasMessage(payload);
  const recovered = ethers.verifyMessage(msg, payload.signature);
  if (recovered.toLowerCase() !== payload.address.toLowerCase()) {
    throw new Error('invalid_alias_signature');
  }

  // Ensure the Moltbook name exists and is current.
  const agent = await upsertAgentFromMoltbookName(payload.moltbookName);

  // Ensure the alias proof is signed by the currently-linked CHITIN wallet for that Moltbook identity.
  await verifyOnchainWalletLink(agent.agentId, payload.address);

  // Enforce 1 moltx account per moltbook agent (rotation allowed by overwriting).
  await dbQuery(`DELETE FROM agent_aliases WHERE source='moltx' AND moltbook_agent_id=$1 AND source_agent_id<>$2`, [
    agent.agentId,
    post.author_id
  ]);

  // Enforce 1 moltbook agent per moltx account (takeover not allowed).
  const existing = await dbQuery<{ moltbook_agent_id: string }>(
    `SELECT moltbook_agent_id FROM agent_aliases WHERE source='moltx' AND source_agent_id=$1 LIMIT 1`,
    [post.author_id]
  );
  if (existing[0] && String(existing[0].moltbook_agent_id).toLowerCase() !== String(agent.agentId).toLowerCase()) {
    throw new Error('moltx_account_already_aliased');
  }

  await dbQuery(
    `
    INSERT INTO agent_aliases (
      source, source_agent_id, moltbook_agent_id,
      proof_url, proof_post_id, updated_at
    )
    VALUES ('moltx', $1, $2, $3, $4, now())
    ON CONFLICT (source, source_agent_id)
    DO UPDATE SET
      moltbook_agent_id=EXCLUDED.moltbook_agent_id,
      proof_url=EXCLUDED.proof_url,
      proof_post_id=EXCLUDED.proof_post_id,
      updated_at=now()
    `,
    [post.author_id, agent.agentId, proofUrl, post.id]
  );

  return {
    moltbookAgentId: agent.agentId,
    moltbookName: agent.name,
    moltxAgentId: post.author_id,
    proofPostId: post.id
  };
}

