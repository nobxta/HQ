import useSWR from "swr";
import api from "../api";
import type { BotSummary, BotDetail, BotStats } from "../types";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

const silentFetcher = (url: string) =>
  api.get(url).then((r) => r.data).catch((e) => {
    if (e?.response?.status === 404) return null;
    throw e;
  });

export function useAdbots(state?: string, page = 1) {
  const params = new URLSearchParams();
  if (state) params.set("state", state);
  params.set("page", String(page));
  return useSWR<{ items: BotSummary[]; total: number; pages: number }>(
    `/api/bots?${params}`, fetcher, { refreshInterval: 8000 }
  );
}

export function useAdbot(name: string) {
  const swr = useSWR<BotDetail | null>(name ? `/api/bots/${name}` : null, silentFetcher, {
    refreshInterval: 5000,
    shouldRetryOnError: false,
  });
  const is404 = swr.data === null && !swr.isLoading;
  return { ...swr, is404 };
}

export function useAdbotStats(name: string) {
  return useSWR<BotStats>(name ? `/api/bots/${name}/stats` : null, silentFetcher, {
    refreshInterval: 10000,
    shouldRetryOnError: false,
  });
}

export function useAdbotLogs(name: string, lines = 100) {
  return useSWR<{ lines: string[]; total_lines: number }>(
    name ? `/api/bots/${name}/logs?lines=${lines}` : null, silentFetcher, {
      refreshInterval: 3000,
      shouldRetryOnError: false,
    }
  );
}
