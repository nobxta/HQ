import useSWR from "swr";
import api from "../api";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export function useMaintenance() {
  return useSWR<{ maintenance_enabled: boolean }>("/api/system/maintenance", fetcher, { refreshInterval: 10000 });
}

export function useWorkers() {
  return useSWR("/api/system/workers", fetcher, { refreshInterval: 10000 });
}

export function useAuditLog(limit = 50) {
  return useSWR<{ entries: any[]; total: number }>(
    `/api/system/audit?limit=${limit}`, fetcher, { refreshInterval: 15000 }
  );
}

export function useAdminSettings() {
  return useSWR("/api/system/admin-settings", fetcher);
}
