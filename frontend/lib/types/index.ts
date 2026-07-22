// ── Auth ──
export interface LoginCredentials {
  username: string;
  password: string;
}
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

// ── Dashboard ──
export interface DashboardStats {
  bots: {
    total: number;
    running: number;
    stopped: number;
    expired: number;
    dead: number;
    frozen?: number;
    suspended?: number;
  };
  sessions: {
    total: number;
    assigned: number;
    free: number;
    dead: number;
    frozen: number;
    limited: number;
    unauth: number;
  };
  orders: {
    total: number;
    completed: number;
    pending: number;
    revenue_usd: number;
    revenue_today?: number;
    revenue_month?: number;
    pending_value?: number;
    paid_today_count?: number;
    pending_count?: number;
    expired_count?: number;
    failed_count?: number;
  };
  system: {
    cpu_percent: number;
    memory_percent: number;
    memory_used_mb: number;
    memory_total_mb: number;
    uptime_seconds: number;
    disk_percent?: number | null;
    disk_used_gb?: number | null;
    disk_total_gb?: number | null;
    logs_size_mb?: number | null;
  };
  workers: {
    create_worker_ok: boolean;
    payment_worker_ok: boolean;
  };
  posting: {
    total_sent: number;
    total_failed: number;
    today_sent: number;
    today_failed: number;
    hourly: Array<{ hour_ts: number; sent: number; failed: number }>;
  };
  renewals_soon: Array<{
    name: string;
    valid_till: string;
    days_left: number;
    plan_name: string;
    renewal_price: number;
    expired: boolean;
  }>;
  top_failing: Array<{
    name: string;
    lifetime_sent: number;
    lifetime_failed: number;
    today_sent: number;
    today_failed: number;
  }>;
  recent_orders: Array<{
    order_id: string;
    user_id?: number;
    status: string;
    order_type: string;
    plan_name: string;
    amount_usd: number;
    created_at: string;
    paid_at: string;
  }>;
}

export interface RangeAnalytics {
  start: number;
  end: number;
  bucket_seconds: number;
  points: Array<{ ts: number; sent: number; failed: number }>;
  total_sent: number;
  total_failed: number;
  bots_with_data: number;
  per_bot: Array<{ name: string; sent: number; failed: number }>;
  generated_at: number;
}

export interface BotHealthRow {
  name: string;
  owner_id?: number | null;
  plan_name: string;
  state: string;
  running: boolean;
  frozen: boolean;
  suspended: boolean;
  sessions_count: number;
  failing_sessions: number;
  cycle_sec: number;
  last_cycle_ts: number;
  sent_24h: number;
  failed_24h: number;
  valid_till: string;
  days_left?: number | null;
  issue?: { severity: "critical" | "warning" | "info"; label: string } | null;
}

export interface FailureReasons {
  total: number;
  range: string;
  reasons: Array<{ key: string; label: string; count: number; sessions: string[] }>;
  generated_at: number;
}

export interface Alert {
  ts: number;
  type: string;
  msg: string;
}

// ── Bots ──
export interface BotSummary {
  name: string;
  bot_username?: string;
  state: string;
  mode: string;
  sessions_count: number;
  cycle: number;
  gap: number;
  valid_till?: string;
  running: boolean;
  frozen: boolean;
  suspended: boolean;
  // Server-authoritative expiry state (see api/services/serializers.py _expiry_fields)
  expired?: boolean;
  in_grace?: boolean;
  grace_hours_left?: number | null;
  expired_at?: string;
}

export interface BotDetail extends BotSummary {
  telegram_user_id?: number;
  group_file?: string;
  message?: string;
  message_mode?: "link" | "text";
  message_text?: string;
  post_links?: string[];
  post_link?: string;
  plan_name?: string;
  renewal_price?: number;
  sessions?: string[];
  excluded_groups?: number[];
  history?: Array<{ ts: number; action: string; detail?: string }>;
  custom_chatlist?: {
    links?: string[];
    slugs?: string[];
  };
  [key: string]: unknown;
}

export interface SessionCycleStats {
  lifetime_sent: number;
  lifetime_failed: number;
  last24h_sent?: number;
  last24h_failed?: number;
  cycles: number;
  last_cycle_ts: number;
  last_cycle_success: number;
  last_cycle_failed: number;
  last_cycle_skipped: number;
  last_cycle_attempted: number;
  last_cycle_duration_sec: number;
  avg_cycle_duration_sec: number;
  best_cycle_success: number;
  best_cycle_ts: number;
  sent?: number;
  failed?: number;
  flood_until?: number;
}

export interface BotStats {
  lifetime_sent: number;
  lifetime_failed: number;
  cycles: number;
  total_cycles: number;
  last_cycle_ts: number;
  last_cycle_session: string;
  session_stats: Record<string, SessionCycleStats>;
  hourly_buckets: Array<{ hour: string; sent: number; failed: number }>;
}

export interface BotCreatePayload {
  name: string;
  bot_token: string;
  use_pool?: boolean;
  sessions_count: number;
  cycle: number;
  gap: number;
  mode: string;
  group_file: string;
  valid_till: string;
  renewal_price?: number;
  plan_name?: string;
}

export interface BotUpdatePayload {
  cycle?: number;
  gap?: number;
  group_file?: string;
  valid_till?: string;
  message_mode?: "link" | "text";
  message_text?: string;
  post_links?: string[];
}

// ── Sessions ──
export interface SessionInfo {
  filename: string;
  status: string;
  bot_name?: string;
  real_name?: string;
  user_id?: number;
  bucket?: string;
}

export interface PoolOverview {
  free: number;
  dead: number;
  frozen: number;
  limited: number;
  unauth: number;
  free_sessions: string[];
  dead_sessions: string[];
}

// Aggregated /api/sessions/overview
export type SessionHealth =
  | "healthy" | "limited" | "frozen" | "unauthorized" | "dead" | "unknown";
export type SessionPool =
  | "free" | "assigned" | "dead" | "frozen" | "limited" | "unauth";
export type SessionDerivedStatus =
  | "ready" | "running" | "stopped" | "disabled" | "floodwait"
  | "paused" | "dead" | "limited" | "frozen" | "unauthorized" | "unknown";

export interface SessionOverviewItem {
  filename: string;
  resolved_path_type: "active" | "user" | "dead" | "frozen" | "limited" | "unauth";
  file_present: boolean;
  pool: SessionPool;
  starred: boolean;

  // Identity — sourced from the per-session cache (pool.json["session_meta"]); null where the
  // account doesn't expose it (never guessed from the filename). `real_name` is kept as an
  // alias of `full_name` for back-compat with older components.
  full_name: string | null;
  real_name: string | null;
  user_id: number | null;
  username: string | null;
  phone: string | null;          // verified Telegram phone, or null
  bio: string | null;
  premium: boolean;
  restricted: boolean;
  authorized: boolean | null;

  bot_name: string | null;
  bot_state: string | null;
  bot_plan: string | null;
  disabled: boolean;

  health: SessionHealth;
  validation_status: string | null;
  validation_reason: string | null;
  last_validated_at: number | null;
  last_checked: number | null;   // epoch of last live probe (identity/health)
  spam_status: string | null;
  spam_details: string | null;
  last_spambot_check_at: number | null;
  last_released_from: string | null;
  last_released_at: number | null;

  derived_status: SessionDerivedStatus;
  pause_until: number | null;
  pause_remaining_sec: number | null;

  attention: boolean;
  attention_reason: string | null;

  sent: number;
  failed: number;
  flood: number;
  success_rate: number | null;
  last_active_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  last_cycle_ts: number | null;
}

export interface SessionsOverviewSummary {
  total: number;
  ready: number;
  assigned: number;
  enabled: number;
  disabled: number;
  needs_attention: number;
  dead: number;
  frozen: number;
  limited: number;
  unauthorized: number;
  healthy: number;
  unknown: number;
  starred: number;
}

export interface SessionsOverview {
  generated_at: string;
  range: string;
  summary: SessionsOverviewSummary;
  sessions: SessionOverviewItem[];
}

// Structured bulk-operation result shape returned by the safe session endpoints.
export interface BulkOpFailure {
  filename: string;
  code: string;
  message: string;
  bot_name?: string;
  bot_running?: boolean;
}
export interface BulkOpResult {
  success: string[];
  failed: BulkOpFailure[];
  skipped: BulkOpFailure[];
  summary: { requested: number; succeeded: number; failed: number; skipped: number };
}

// ── Orders ──
export interface OrderInfo {
  order_id: string;
  user_id?: number;
  status: string;
  order_type: string;
  plan_name?: string;
  mode?: string;
  amount_usd?: number;
  pay_currency?: string;
  created_at?: string;
  paid_at?: string;
  bot_name?: string;
  [key: string]: unknown;
}

// ── Groups ──
export interface GroupFile {
  filename: string;
  lines: number;
  size_bytes?: number;
  content?: string;
}

// ── Plans ──
export interface PlanInfo {
  id: string;
  sessions: number;
  cycle: number;
  gap: number;
  price_week: number;
  price_month: number;
  group_file?: string;
  free_replacements: number;
}

// ── Broadcast ──
export interface BroadcastSegment {
  name: string;
  count: number;
}

// ── System ──
export interface WorkerHealth {
  name: string;
  last_heartbeat?: number;
  age_seconds?: number;
  healthy: boolean;
}

export interface AuditEntry {
  ts: number;
  action: string;
  detail?: string;
  admin?: string;
}

// ── Pagination ──
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}
