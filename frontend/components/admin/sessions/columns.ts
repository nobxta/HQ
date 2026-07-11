// Table column model — required columns can never be hidden.
export type ColumnKey =
  | "account" | "file" | "health" | "location" | "assigned"
  | "runtime" | "last_checked" | "activity";

export const COLUMNS: Array<{ key: ColumnKey; label: string; required?: boolean; optional?: boolean }> = [
  { key: "account", label: "Account", required: true },
  { key: "file", label: "Session file", optional: true },
  { key: "health", label: "Health", required: true },
  { key: "location", label: "Location", required: true },
  { key: "assigned", label: "Assigned to", required: true },
  { key: "runtime", label: "Runtime", optional: true },
  { key: "last_checked", label: "Last checked", optional: true },
  { key: "activity", label: "Activity", optional: true },
];

export type Density = "comfortable" | "compact";

export const DEFAULT_VISIBLE: Record<ColumnKey, boolean> = {
  account: true, file: true, health: true, location: true,
  assigned: true, runtime: true, last_checked: true, activity: true,
};

const COLS_KEY = "admin.sessions.columns.v1";
const DENSITY_KEY = "admin.sessions.density.v1";

export function loadVisible(): Record<ColumnKey, boolean> {
  if (typeof window === "undefined") return { ...DEFAULT_VISIBLE };
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (raw) return { ...DEFAULT_VISIBLE, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_VISIBLE };
}
export function saveVisible(v: Record<ColumnKey, boolean>) {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}
export function loadDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  try { return (localStorage.getItem(DENSITY_KEY) as Density) || "comfortable"; } catch { return "comfortable"; }
}
export function saveDensity(d: Density) {
  try { localStorage.setItem(DENSITY_KEY, d); } catch { /* ignore */ }
}
