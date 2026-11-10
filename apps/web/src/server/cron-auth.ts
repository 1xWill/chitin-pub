import { z } from 'zod';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing env ' + name);
  return v;
}

export function requireCronAuth(req: Request): void {
  const token = requiredEnv('CRON_TOKEN');

  // Prefer Authorization: Bearer <token>
  const auth = String(req.headers.get('authorization') ?? '').trim();
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const provided = m ? m[1] : auth;
    if (provided === token) return;
  }

  // Also allow a dedicated header (nicer for Vercel Cron config UIs).
  const hdr = String(req.headers.get('x-chitin-cron-token') ?? '').trim();
  if (hdr && hdr === token) return;

  throw new Error('unauthorized');
}

export const CronLimitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional()
});

