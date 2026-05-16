import useSWR from "swr";
import api from "../api";
import type { DashboardStats, Alert } from "../types";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export function useDashboard() {
  return useSWR<DashboardStats>("/api/dashboard", fetcher, { refreshInterval: 10000 });
}

export function useAlerts() {
  return useSWR<{ items: Alert[]; total: number }>("/api/dashboard/alerts", fetcher, { refreshInterval: 15000 });
}

export function useSystemHealth() {
  return useSWR("/api/dashboard/health", fetcher, { refreshInterval: 15000 });
}
