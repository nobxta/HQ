// Operational views + filter model for the Sessions console.
// Pure functions only — no React — so the page, cards and toolbar share one definition.
import type { SessionOverviewItem, SessionHealth, SessionPool } from "@/lib/types";

export type SessionView = "all" | "ready" | "assigned" | "needs_action" | "unchecked" | "starred";

export const VIEW_DEFS: Array<{ key: SessionView; label: string }> = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready" },
  { key: "assigned", label: "Assigned" },
  { key: "needs_action", label: "Needs action" },
  { key: "unchecked", label: "Unchecked" },
  { key: "starred", label: "Starred" },
];

export function matchesView(s: SessionOverviewItem, view: SessionView): boolean {
  switch (view) {
    case "all": return true;
    case "ready": return s.pool === "free";
    case "assigned": return !!s.bot_name;
    case "needs_action": return s.attention;
    case "unchecked": return !s.validation_status && !s.last_validated_at;
    case "starred": return s.starred;
    default: return true;
  }
}

export function viewCount(sessions: SessionOverviewItem[], view: SessionView): number {
  return sessions.reduce((n, s) => n + (matchesView(s, view) ? 1 : 0), 0);
}

// ── Filters ──
export interface SessionFilters {
  pool: SessionPool | "";
  health: SessionHealth | "";
  assignment: "assigned" | "free" | "";
  bot: string;
  botState: "running" | "stopped" | "";
  enabled: "enabled" | "disabled" | "";
  validation: "valid" | "invalid" | "unchecked" | "";
  starred: boolean;
}

export const EMPTY_FILTERS: SessionFilters = {
  pool: "", health: "", assignment: "", bot: "", botState: "",
  enabled: "", validation: "", starred: false,
};

export function activeFilterCount(f: SessionFilters): number {
  let n = 0;
  if (f.pool) n++;
  if (f.health) n++;
  if (f.assignment) n++;
  if (f.bot) n++;
  if (f.botState) n++;
  if (f.enabled) n++;
  if (f.validation) n++;
  if (f.starred) n++;
  return n;
}

export function matchesFilters(s: SessionOverviewItem, f: SessionFilters): boolean {
  if (f.pool && s.pool !== f.pool) return false;
  if (f.health && s.health !== f.health) return false;
  if (f.assignment === "assigned" && !s.bot_name) return false;
  if (f.assignment === "free" && s.bot_name) return false;
  if (f.bot && s.bot_name !== f.bot) return false;
  if (f.botState === "running" && s.derived_status !== "running") return false;
  if (f.botState === "stopped" && s.derived_status === "running") return false;
  if (f.enabled === "enabled" && s.disabled) return false;
  if (f.enabled === "disabled" && !s.disabled) return false;
  if (f.validation === "valid" && s.validation_status !== "valid") return false;
  if (f.validation === "invalid" && s.validation_status !== "invalid") return false;
  if (f.validation === "unchecked" && (s.validation_status || s.last_validated_at)) return false;
  if (f.starred && !s.starred) return false;
  return true;
}

export function matchesSearch(s: SessionOverviewItem, q: string): boolean {
  if (!q) return true;
  const t = q.toLowerCase();
  return (
    s.filename.toLowerCase().includes(t) ||
    (s.real_name || "").toLowerCase().includes(t) ||
    String(s.user_id ?? "").includes(t) ||
    (s.bot_name || "").toLowerCase().includes(t) ||
    (s.validation_reason || "").toLowerCase().includes(t) ||
    (s.last_error || "").toLowerCase().includes(t)
  );
}
