export type SourceId = 'moltbook' | 'moltx';

export type ResolvedRecipient = {
  // CHITIN canonical identity (Moltbook UUID).
  moltbookAgentId: string;
  moltbookName: string | null;

  // Which source we resolved from (e.g. moltx post URL).
  source: SourceId;
  sourceAgentId: string | null;
};

export type ResolveContextResult =
  | { ok: true; recipient: ResolvedRecipient }
  | { ok: false; error: string };

export interface ContextSourcePlugin {
  id: SourceId;
  match(url: URL): boolean;
  resolveRecipient(url: URL): Promise<ResolveContextResult>;
}

