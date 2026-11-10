import { headers } from 'next/headers';
import { getChitinConfig } from '@/server/config';
import { HomeGuidesClient } from '@/components/HomeGuidesClient';

async function originFromHeaders(): Promise<string | null> {
  try {
    const h = await headers();
    const proto = (h.get('x-forwarded-proto') ?? 'http').split(',')[0]?.trim() || 'http';
    const host =
      (h.get('x-forwarded-host') ?? '').split(',')[0]?.trim() ||
      (h.get('host') ?? '').trim();
    if (!host) return null;
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

export async function HomeGuides() {
  const fromCfg = (getChitinConfig().publicOrigin ?? '').trim().replace(/\/+$/, '');
  const origin = fromCfg || (await originFromHeaders()) || '';
  const skillUrl = origin ? `${origin}/skill.md` : '/skill.md';
  return <HomeGuidesClient skillUrl={skillUrl} />;
}
