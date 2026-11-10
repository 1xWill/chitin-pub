import { NextResponse } from 'next/server';
import { z } from 'zod';
import { countActivitiesCapped, listActivities } from '@/server/activities';
import { getChitinConfig } from '@/server/config';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  page: z.coerce.number().int().min(1).max(500).optional()
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = QuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const cfg = getChitinConfig();
    const pageSize = cfg.api.activitiesPageSize ?? 10;
    const maxPages = cfg.api.activitiesMaxPages ?? 20;

    // If `page` is provided, use paginated mode (used by /activities UI).
    if (q.page) {
      if (q.page > maxPages) {
        throw new Error('page_too_large');
      }

      const cap = pageSize * maxPages;
      const cappedCount = await countActivitiesCapped(cap);
      const totalPages = Math.max(1, Math.ceil(cappedCount / pageSize));

      const safePage = Math.min(q.page, totalPages);
      const offset = (safePage - 1) * pageSize;
      const items = await listActivities({ limit: pageSize + 1, offset });
      const hasMore = items.length > pageSize;
      const pageItems = hasMore ? items.slice(0, pageSize) : items;
      return NextResponse.json(
        {
          success: true,
          page: safePage,
          pageSize,
          maxPages,
          totalPages,
          hasMore,
          activities: pageItems
        },
        { headers: { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=60' } }
      );
    }

    const limit = q.limit ?? cfg.api.activitiesDefaultLimit;

    if (limit > cfg.api.activitiesMaxLimit) {
      throw new Error('limit_too_large');
    }

    const items = await listActivities({ limit });
    return NextResponse.json(
      { success: true, activities: items },
      { headers: { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=60' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
