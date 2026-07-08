import { useMemo } from "react";
import { useAdbotStats, useSessionsOverview, useAdbotLogs } from "./useAdbots";

export type TimeRange = "24h" | "7d" | "30d" | "lifetime";

export interface AnalyticsData {
  timeline: Array<{
    bucket: string;
    sent: number;
    failed: number;
    flood: number;
    limited: number;
    successRate: number;
  }>;
  sessions: Array<{
    sessionFile: string;
    displayName: string;
    maskedAccount: string;
    sent: number;
    failed: number;
    flood: number;
    successRate: number | null;
    status: string;
    lastUsed: string | null;
  }>;
  failureReasons: Array<{
    reason: string;
    count: number;
  }>;
  delivery: {
    sent: number;
    failed: number;
    flood: number;
    successRate: number | null;
    failureRate: number | null;
  };
  cycle: {
    cycleSec: number;
    gapSec: number;
    lastCycleAt: string | null;
    nextCycleAt: string | null;
    status: string;
  };
  isLoading: boolean;
  isError: boolean;
}

const normalizeFailureReason = (text: string): string => {
  const lower = text.toLowerCase();
  if (lower.includes("floodwait") || lower.includes("flood") || lower.includes("limited")) return "FloodWait";
  if (lower.includes("topic_closed") || lower.includes("topic closed")) return "Topic closed";
  if (lower.includes("allow_payment_required") || lower.includes("payment")) return "Payment required";
  if (lower.includes("user_banned_in_channel") || lower.includes("banned from group")) return "Banned from group";
  if (lower.includes("chat_write_forbidden") || lower.includes("write forbidden")) return "Write forbidden";
  if (lower.includes("session_revoked") || lower.includes("unauthorized") || lower.includes("unauth") || lower.includes("dead") || lower.includes("frozen")) return "Session unauthorized";
  return "Unknown failure";
};

export function useAdbotAnalytics(name: string, range: TimeRange, botConfig: any): AnalyticsData {
  const { data: stats, isLoading: statsLoading, error: statsError } = useAdbotStats(name);
  const { data: overview, isLoading: overviewLoading, error: overviewError } = useSessionsOverview(name, range);
  // Default to 2000 lines for a reasonable sample if no backend API is ready.
  // In the future, the backend will return the full pre-aggregated timeline.
  const { data: logsData, isLoading: logsLoading } = useAdbotLogs(name, 2000);

  const analytics = useMemo((): AnalyticsData => {
    // 1. Base Data
    const isLoading = statsLoading || overviewLoading || logsLoading;
    const isError = !!statsError || !!overviewError;

    // 2. Cycle Timing
    let lastCycleAt = null;
    let nextCycleAt = null;
    const cycleSec = botConfig?.cycle || 0;
    const gapSec = botConfig?.gap || 0;
    const isRunning = botConfig?.running;

    if (stats?.last_cycle_ts) {
      lastCycleAt = new Date(stats.last_cycle_ts * 1000).toISOString();
      if (isRunning) {
        nextCycleAt = new Date((stats.last_cycle_ts + cycleSec) * 1000).toISOString();
      }
    }

    // 3. Delivery
    const sent = stats?.lifetime_sent || 0;
    const failed = stats?.lifetime_failed || 0;
    const total = sent + failed;
    const successRate = total > 0 ? Math.round((sent / total) * 100) : null;
    const failureRate = total > 0 ? Math.round((failed / total) * 100) : null;

    // 4. Sessions
    let sessions: AnalyticsData["sessions"] = [];
    if (overview?.sessions) {
      sessions = overview.sessions.map((s) => {
        const sTotal = s.stats.sent + s.stats.failed;
        return {
          sessionFile: s.file,
          displayName: s.display_name || `Session ${s.index}`,
          maskedAccount: s.phone_from_file || s.telegram_user_id?.toString() || s.file,
          sent: s.stats.sent,
          failed: s.stats.failed,
          flood: s.stats.flood || 0,
          successRate: sTotal > 0 ? Math.round((s.stats.sent / sTotal) * 100) : null,
          status: s.status,
          lastUsed: s.last_active_at ? new Date(s.last_active_at * 1000).toISOString() : null,
        };
      });
      // Sort: Highest failed first, or lowest success rate
      sessions.sort((a, b) => {
        if (b.failed !== a.failed) return b.failed - a.failed;
        const aRate = a.successRate ?? 100;
        const bRate = b.successRate ?? 100;
        return aRate - bRate;
      });
    }

    // 5. Timeline & Failure Reasons (from Logs fallback)
    const timelineMap = new Map<string, { sent: number; failed: number; flood: number; limited: number }>();
    const failureMap = new Map<string, number>();

    if (logsData?.lines) {
      // Regex for standard format: [2024-07-09 10:25:32] [LEVEL] Message
      const logRegex = /^\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\]\s+\[(.*?)\]\s+(.*)$/;
      const now = Date.now();

      logsData.lines.forEach((line) => {
        const match = line.match(logRegex);
        if (!match) return;
        const [_, dateStr, level, msg] = match;
        
        // Parse UTC or local timestamp based on typical log formats
        const ts = new Date(dateStr.replace(" ", "T") + "Z").getTime();
        if (isNaN(ts)) return;

        // Filter based on range
        const msInHour = 60 * 60 * 1000;
        const msInDay = 24 * msInHour;
        let cutoff = 0;
        let bucketKey = "";

        if (range === "24h") {
          cutoff = now - msInDay;
          // Bucket by hour
          bucketKey = dateStr.slice(0, 13) + ":00"; // YYYY-MM-DD HH:00
        } else if (range === "7d") {
          cutoff = now - 7 * msInDay;
          // Bucket by day
          bucketKey = dateStr.slice(0, 10); // YYYY-MM-DD
        } else if (range === "30d") {
          cutoff = now - 30 * msInDay;
          bucketKey = dateStr.slice(0, 10);
        } else {
          // Lifetime: bucket by day (could be week if needed)
          bucketKey = dateStr.slice(0, 10);
        }

        if (ts < cutoff) return;

        if (!timelineMap.has(bucketKey)) {
          timelineMap.set(bucketKey, { sent: 0, failed: 0, flood: 0, limited: 0 });
        }
        const b = timelineMap.get(bucketKey)!;

        const lowerMsg = msg.toLowerCase();
        
        // Success
        if (level === "SUCCESS" || lowerMsg.includes("success")) {
          b.sent++;
        } 
        // Flood
        else if (level === "WARNING" && (lowerMsg.includes("flood") || lowerMsg.includes("wait"))) {
          b.flood++;
          b.limited++;
          const reason = normalizeFailureReason(msg);
          failureMap.set(reason, (failureMap.get(reason) || 0) + 1);
        }
        // Failure
        else if (level === "ERROR" || level === "FAILED" || lowerMsg.includes("failed")) {
          b.failed++;
          const reason = normalizeFailureReason(msg);
          failureMap.set(reason, (failureMap.get(reason) || 0) + 1);
        }
      });
    }

    const timeline = Array.from(timelineMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, data]) => {
        const tTotal = data.sent + data.failed;
        return {
          bucket,
          sent: data.sent,
          failed: data.failed,
          flood: data.flood,
          limited: data.limited,
          successRate: tTotal > 0 ? Math.round((data.sent / tTotal) * 100) : 0,
        };
      });

    const failureReasons = Array.from(failureMap.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    return {
      timeline,
      sessions,
      failureReasons,
      delivery: {
        sent,
        failed,
        flood: failureReasons.find(f => f.reason === "FloodWait")?.count || 0,
        successRate,
        failureRate,
      },
      cycle: {
        cycleSec,
        gapSec,
        lastCycleAt,
        nextCycleAt,
        status: isRunning ? "running" : "stopped",
      },
      isLoading,
      isError,
    };
  }, [stats, overview, logsData, statsLoading, overviewLoading, logsLoading, statsError, overviewError, range, botConfig]);

  return analytics;
}
