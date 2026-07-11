import useSWR from "swr";
import api from "../api";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export interface CouponData {
  type: "percent" | "fixed";
  value: number;
  active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  max_redemptions: number | null;
  max_per_user: number | null;
  min_order_usd: number | null;
  max_order_usd: number | null;
  billing: "week" | "month" | "both";
  applies_to: string[];
  redeemed_count: number;
  redemptions: { order_id: string; user_key: string; email: string; at: string }[];
  note: string;
  created_at: string;
}

export function useCoupons() {
  return useSWR<Record<string, CouponData>>("/api/system/coupons", fetcher);
}
