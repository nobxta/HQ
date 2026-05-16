import useSWR from "swr";
import api from "../api";
import type { OrderInfo } from "../types";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export function useOrders(status?: string, page = 1) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("page", String(page));
  return useSWR<{ items: OrderInfo[]; total: number; pages: number }>(
    `/api/orders?${params}`, fetcher, { refreshInterval: 10000 }
  );
}

export function usePendingOrders() {
  return useSWR<{ orders: OrderInfo[]; total: number }>(
    "/api/orders/pending", fetcher, { refreshInterval: 8000 }
  );
}
