import useSWR from "swr";
import api from "../api";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export function usePlans() {
  return useSWR<Record<string, any[]>>("/api/system/plans", fetcher);
}
