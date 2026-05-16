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
  };
  system: {
    cpu_percent: number;
    memory_percent: number;
    memory_used_mb: number;
    memory_total_mb: number;
    uptime_seconds: number;
  };
  workers: {
    create_worker_ok: boolean;
    payment_worker_ok: boolean;
  };
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
}

export interface BotDetail extends BotSummary {
  telegram_user_id?: number;
  group_file?: string;
  message?: string;
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

export interface BotStats {
  lifetime_sent: number;
  lifetime_failed: number;
  cycles: number;
  session_stats: Record<string, { sent: number; failed: number; flood_until?: number }>;
  hourly_buckets: Array<{ hour: string; sent: number; failed: number }>;
}

export interface BotCreatePayload {
  name: string;
  bot_token: string;
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
  name: string;
  mode: string;
  sessions: number;
  cycle: number;
  gap: number;
  price_usd: number;
  duration_days: number;
  group_file?: string;
  label?: string;
  [key: string]: unknown;
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
