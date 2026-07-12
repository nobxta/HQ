// Typed API layer + SWR hook for the admin Sessions console.
// All mutations go through the safe global endpoints (or the bot-scoped endpoints for
// assigned sessions). No pool logic lives here — this is a thin, typed transport layer.
import useSWR from "swr";
import api from "./api";
import type {
  SessionsOverview,
  BulkOpResult,
} from "./types";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export type OverviewRange = "1h" | "6h" | "24h" | "7d" | "all";

export function useSessionsOverview(range: OverviewRange = "24h") {
  return useSWR<SessionsOverview>(
    `/api/sessions/overview?range=${range}`,
    fetcher,
    { refreshInterval: 15000, keepPreviousData: true, revalidateOnFocus: false },
  );
}

// ── validation ──
export interface ValidateResult {
  sessions: Array<{ file: string; status: string; reason: string }>;
  total: number;
  active: number;
  dead: number;
  busy: number;
  dead_moved: string[];
  skipped: Array<{ filename: string; code: string; message: string }>;
}
export async function validateSessions(filenames?: string[]): Promise<ValidateResult> {
  const { data } = await api.post("/api/sessions/validate", filenames ? { filenames } : {});
  return data;
}
// Assigned validation can be skipped when the session is held by a live task
// (running AdBot worker / chatlist / portal). "skipped" is informational — not a
// dead/invalid outcome — and the backend does not persist anything for it.
export type AssignedValidateStatus = "valid" | "invalid" | "skipped";
export async function validateAssignedSession(botName: string, file: string) {
  const { data } = await api.post(
    `/api/bots/${encodeURIComponent(botName)}/sessions/${encodeURIComponent(file)}/validate`,
  );
  return data as { file: string; status: AssignedValidateStatus; reason: string };
}

// ── spambot ──
export interface SpambotResult {
  sessions: Array<{ file: string; spambot_status: string }>;
  total: number;
  active: number;
  limited: number;
  frozen: number;
  moved_limited: string[];
  moved_frozen: string[];
  skipped: Array<{ filename: string; code: string; message: string }>;
  summary: { requested: number; checked: number; moved: number; skipped: number };
}
export async function spambotCheck(filenames?: string[]): Promise<SpambotResult> {
  const { data } = await api.post("/api/sessions/spambot-check", filenames ? { filenames } : {});
  return data;
}

// ── info ──
export async function getSessionsInfo(filenames: string[]) {
  const { data } = await api.get("/api/sessions/info", { params: { filenames: filenames.join(",") } });
  return data.sessions as Array<Record<string, unknown>>;
}

// ── upload ──
export interface UploadResult {
  added: string[];
  duplicates: string[];
  invalid: string[];
  errors: Array<{ filename: string; code: string; message: string }>;
  extracted: number;
  uploaded: number;
  total_added: number;
  summary: { uploaded: number; extracted: number; added: number; duplicates: number; invalid: number; failed: number };
}
export async function uploadSessions(files: File[]): Promise<UploadResult> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  const { data } = await api.post("/api/sessions/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 120000,
  });
  return data;
}

// ── move ──
export async function moveSession(filename: string, fromBucket: string, toBucket: string) {
  const { data } = await api.post(`/api/sessions/${encodeURIComponent(filename)}/move`, {
    from_bucket: fromBucket,
    to_bucket: toBucket,
  });
  return data;
}
export async function bulkMove(filenames: string[], fromBucket: string, toBucket: string): Promise<BulkOpResult> {
  const { data } = await api.post("/api/sessions/bulk-move", {
    filenames,
    from_bucket: fromBucket,
    to_bucket: toBucket,
  });
  return data;
}

// ── delete ──
export async function deleteSession(filename: string) {
  const { data } = await api.delete(`/api/sessions/${encodeURIComponent(filename)}`);
  return data;
}
export async function bulkDelete(filenames: string[]): Promise<BulkOpResult> {
  const { data } = await api.post("/api/sessions/bulk-delete", { filenames });
  return data;
}

// ── star ──
export async function starSession(filename: string, on: boolean) {
  if (on) await api.post(`/api/sessions/${encodeURIComponent(filename)}/star`);
  else await api.delete(`/api/sessions/${encodeURIComponent(filename)}/star`);
}

// ── assignment (bot-scoped) ──
export async function assignSession(botName: string, file: string) {
  const { data } = await api.post(`/api/bots/${encodeURIComponent(botName)}/sessions/add`, { session_file: file });
  return data;
}
export async function unassignSession(botName: string, file: string) {
  const { data } = await api.post(
    `/api/bots/${encodeURIComponent(botName)}/sessions/${encodeURIComponent(file)}/remove`,
  );
  return data;
}
export async function replaceAssignedSession(botName: string, oldFile: string, newFile: string) {
  const { data } = await api.post(
    `/api/bots/${encodeURIComponent(botName)}/sessions/${encodeURIComponent(oldFile)}/replace`,
    { new_session_file: newFile },
  );
  return data;
}
export async function setSessionEnabled(botName: string, file: string, enabled: boolean) {
  const action = enabled ? "enable" : "disable";
  const { data } = await api.post(
    `/api/bots/${encodeURIComponent(botName)}/sessions/${encodeURIComponent(file)}/${action}`,
  );
  return data;
}

// ── bots list (for assign / replace selectors) ──
export interface BotOption { name: string; state: string; running: boolean; sessions_count: number; plan_name?: string; }
export async function listBotOptions(): Promise<BotOption[]> {
  const { data } = await api.get("/api/bots", { params: { page: 1, per_page: 200 } });
  return (data.items || []).map((b: Record<string, unknown>) => ({
    name: b.name as string,
    state: b.state as string,
    running: Boolean(b.running),
    sessions_count: (b.sessions_count as number) ?? 0,
    plan_name: (b.plan_name as string) || "",
  }));
}

// ── audit (session activity timeline) ──
export interface AuditRow { ts: string; admin_id: string | number; action: string; target: string | null; }
export function useAuditLog(limit = 200) {
  return useSWR<{ entries: AuditRow[]; total: number }>(
    `/api/system/audit?limit=${limit}`,
    fetcher,
    { refreshInterval: 30000, revalidateOnFocus: false },
  );
}
