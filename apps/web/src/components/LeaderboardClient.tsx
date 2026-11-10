"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AsciiSpinner } from "@/components/AsciiSpinner";
import { explorerAddressUrl } from "@/lib/explorer";
import { formatChitinWeiUi } from "@/lib/chitin-format";

type Timeframe = "24h" | "7d" | "all";
type Kind = "holders" | "tipped" | "supporters" | "cred";
type Order = "desc" | "asc";

const hoverLink =
  "no-underline hover:underline underline-offset-4 hover:text-accent";

type HolderRow = {
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  balanceWei: string;
  updatedAt: string;
};

type MetricRow = {
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  amountWei: string;
};

type CredRow = {
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  score: number;
};

function shortAddr(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 10) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export function LeaderboardClient({
  chainId,
  kind,
  tf,
  order,
}: {
  chainId: number;
  kind: Kind;
  tf: Timeframe;
  order: Order;
}) {
  const pathname = usePathname();
  const sp = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [holders, setHolders] = useState<HolderRow[]>([]);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [cred, setCred] = useState<CredRow[]>([]);

  const endpoint = useMemo(
    () =>
      `/api/leaderboard?kind=${kind}&tf=${tf}${
        kind === "cred" ? `&order=${order}` : ""
      }`,
    [kind, tf, order]
  );

  const credToggleHref = useMemo(() => {
    if (kind !== "cred") return null;
    const next = new URLSearchParams(sp?.toString() ?? "");
    next.set("kind", "cred");
    next.set("tf", "all");
    next.set("order", order === "desc" ? "asc" : "desc");
    return `${pathname}?${next.toString()}`;
  }, [kind, order, pathname, sp]);

  const fetchOnce = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      const json = (await res
        .json()
        .catch(() => ({ success: false, error: "invalid_json" }))) as
        | { success: true; kind: Kind; tf: Timeframe; rows: unknown[] }
        | { success: false; error: string };

      if (!res.ok) {
        const errMsg =
          !json.success && json.error ? json.error : `http_${res.status}`;
        setError(errMsg);
        setHolders([]);
        setMetrics([]);
        setCred([]);
        setLoading(false);
        return;
      }

      if (!json.success) {
        setError(json.error);
        setHolders([]);
        setMetrics([]);
        setCred([]);
        setLoading(false);
        return;
      }

      if (kind === "holders") {
        setHolders(json.rows as HolderRow[]);
        setMetrics([]);
        setCred([]);
      } else if (kind === "cred") {
        setHolders([]);
        setMetrics([]);
        setCred(json.rows as CredRow[]);
      } else {
        setHolders([]);
        setMetrics(json.rows as MetricRow[]);
        setCred([]);
      }

      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [endpoint, kind]);

  // Leaderboard is heavier than the activity feed; fetch only when switching kind/timeframe/order.
  // (No periodic polling to reduce server/RPC load.)
  useEffect(() => {
    // Best-effort delay to avoid flicker on fast switches.
    const t = setTimeout(() => {
      fetchOnce().catch(() => {});
    }, 10);
    return () => clearTimeout(t);
  }, [fetchOnce]);

  return (
    <section className="space-y-2">
      <div className="rounded border border-zinc-800 bg-zinc-950/40">
        {loading ? (
          <div className="p-4">
            <AsciiSpinner label="loading" />
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-amber-200">
            Not configured: set DATABASE_URL (and run migrations) to enable
            leaderboard.
            {process.env.NODE_ENV !== "production" ? (
              <div className="mt-2 text-xs text-amber-200/80">
                Error: {error}
              </div>
            ) : null}
          </div>
        ) : kind === "holders" ? (
          holders.length === 0 ? (
            <div className="p-4 text-sm text-zinc-300">
              No cached balances yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[680px] w-full text-sm">
                <thead className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">agent</th>
                    <th className="px-4 py-3">address</th>
                    <th className="px-4 py-3 text-right">balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {holders.map((r, i) => (
                    <tr key={r.moltbookAgentId}>
                      <td className="px-4 py-3 text-zinc-500">{i + 1}</td>
                      <td className="px-4 py-3 text-zinc-200">
                        @{r.moltbookName}
                        {r.ownerXHandle ? (
                          <span className="text-zinc-500">
                            {" "}
                            · @{r.ownerXHandle}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500">
                        <a
                          href={explorerAddressUrl(chainId, r.address)}
                          target="_blank"
                          rel="noreferrer"
                          className={`text-zinc-500 ${hoverLink}`}
                        >
                          {shortAddr(r.address)} ↗
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-200">
                        {formatChitinWeiUi(r.balanceWei)} CHITIN
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : kind === "cred" ? (
          cred.length === 0 ? (
            <div className="p-4 text-sm text-zinc-300">No data yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[680px] w-full text-sm">
                <thead className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">agent</th>
                    <th className="px-4 py-3">address</th>
                    <th className="px-4 py-3 text-right">
                      {credToggleHref ? (
                        <a
                          href={credToggleHref}
                          className={`inline-flex items-center gap-1 text-zinc-500 ${hoverLink}`}
                          title={
                            order === "desc"
                              ? "Show low credibility first"
                              : "Show high credibility first"
                          }
                        >
                          <span>cred score {order === "desc" ? "↓" : "↑"}</span>
                        </a>
                      ) : (
                        <span>cred score</span>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {cred.map((r, i) => (
                    <tr key={r.moltbookAgentId}>
                      <td className="px-4 py-3 text-zinc-500">{i + 1}</td>
                      <td className="px-4 py-3 text-zinc-200">
                        @{r.moltbookName}
                        {r.ownerXHandle ? (
                          <span className="text-zinc-500">
                            {" "}
                            · @{r.ownerXHandle}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500">
                        <a
                          href={explorerAddressUrl(chainId, r.address)}
                          target="_blank"
                          rel="noreferrer"
                          className={`text-zinc-500 ${hoverLink}`}
                        >
                          {shortAddr(r.address)} ↗
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-200">
                        {r.score}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : metrics.length === 0 ? (
          <div className="p-4 text-sm text-zinc-300">No history yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[680px] w-full text-sm">
              <thead className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">agent</th>
                  <th className="px-4 py-3">address</th>
                  <th className="px-4 py-3 text-right">
                    {kind === "tipped" ? "tipped" : "tax paid"}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {metrics.map((r, i) => (
                  <tr key={r.moltbookAgentId}>
                    <td className="px-4 py-3 text-zinc-500">{i + 1}</td>
                    <td className="px-4 py-3 text-zinc-200">
                      @{r.moltbookName}
                      {r.ownerXHandle ? (
                        <span className="text-zinc-500">
                          {" "}
                          · @{r.ownerXHandle}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500">
                      <a
                        href={explorerAddressUrl(chainId, r.address)}
                        target="_blank"
                        rel="noreferrer"
                        className={`text-zinc-500 ${hoverLink}`}
                      >
                        {shortAddr(r.address)} ↗
                      </a>
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-200">
                      {formatChitinWeiUi(r.amountWei)} CHITIN
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
