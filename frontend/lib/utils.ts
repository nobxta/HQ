import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

// The backend stores plan/validity dates as DD/MM/YYYY (not ISO) almost everywhere
// (shop orders, renewals, the Telegram admin bot). Native `new Date("25/12/2026")`
// is parsed as US MM/DD/YYYY, which is wrong for day<=12 and "Invalid Date" for day>12.
export function parseFlexibleDate(d: string | number): Date {
  if (typeof d === "number") return new Date(d * 1000);
  const s = d.trim();
  const ddmmyyyy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }
  return new Date(s);
}

export function formatDate(d: string | number | undefined): string {
  if (!d) return "—";
  const date = parseFlexibleDate(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(d: string | number | undefined): string {
  if (!d) return "—";
  const date = parseFlexibleDate(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Convert an HTML <input type="date"> value (YYYY-MM-DD) to the backend's DD/MM/YYYY. */
export function isoToDdmmyyyy(iso: string): string {
  const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, yyyy, mm, dd] = m;
  return `${dd}/${mm}/${yyyy}`;
}

/** Convert the backend's DD/MM/YYYY validity date to an HTML <input type="date"> value (YYYY-MM-DD). */
export function ddmmyyyyToIso(v: string | undefined): string {
  if (!v) return "";
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Already ISO (or ISO datetime) — keep just the date part.
  return v.split("T")[0];
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

// Telegram profile link that actually works in a browser. `tg://user?id=` only resolves
// inside Telegram's own app/webview — clicking it on a normal website silently fails (no
// registered protocol handler), which reads as a broken/fake button. https://t.me/<username>
// is Telegram's real web deep link (opens the app via universal link, or web.telegram.org,
// or the store page if the app isn't installed) — but it only exists for accounts with a
// public username. There is no public web URL to open a profile by numeric ID alone.
export function telegramProfileUrl(username?: string | null): string | null {
  const u = (username || "").trim().replace(/^@/, "");
  return u ? `https://t.me/${u}` : null;
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
