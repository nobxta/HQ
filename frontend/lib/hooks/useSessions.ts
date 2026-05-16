import useSWR from "swr";
import api from "../api";
import type { SessionInfo, PoolOverview } from "../types";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export function useSessions(status?: string) {
  const params = status ? `?status=${status}` : "";
  return useSWR<{ sessions: SessionInfo[]; total: number }>(
    `/api/sessions${params}`, fetcher, { refreshInterval: 10000 }
  );
}

export function usePool() {
  return useSWR<PoolOverview>("/api/sessions/pool", fetcher, { refreshInterval: 10000 });
}
