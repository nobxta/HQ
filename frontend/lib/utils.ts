import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatDate(d: string | number | undefined): string {
  if (!d) return "—";
  const date = typeof d === "number" ? new Date(d * 1000) : new Date(d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(d: string | number | undefined): string {
  if (!d) return "—";
  const date = typeof d === "number" ? new Date(d * 1000) : new Date(d);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatUSD(amount: number | undefined): string {
  if (amount === undefined || amount === null) return "$0.00";
  return `$${amount.toFixed(2)}`;
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + "…";
}

export function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (["running", "active", "completed", "paid"].includes(s)) return "text-success";
  if (["stopped", "dead", "expired", "cancelled"].includes(s)) return "text-danger";
  if (["frozen", "suspended", "pending", "waiting"].includes(s)) return "text-warning";
  if (["limited", "unauth"].includes(s)) return "text-info";
  return "text-dark-400";
}

export function statusBg(status: string): string {
  const s = status.toLowerCase();
  if (["running", "active", "completed", "paid"].includes(s)) return "bg-success/10 text-success";
  if (["stopped", "dead", "expired", "cancelled"].includes(s)) return "bg-danger/10 text-danger";
  if (["frozen", "suspended", "pending", "waiting"].includes(s)) return "bg-warning/10 text-warning";
  if (["limited", "unauth"].includes(s)) return "bg-info/10 text-info";
  return "bg-dark-700 text-dark-400";
}
