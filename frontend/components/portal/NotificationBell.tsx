"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { Bell, X, Check, CheckCheck, ArrowRightLeft, Clock, AlertTriangle, Info, ChevronRight } from "lucide-react";
import portalApi, { getPortalSession } from "@/lib/portal-api";

type Notification = {
  id: string;
  title: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  icon?: string;
  ts: number;
  read: boolean;
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() / 1000) - ts);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const TYPE_STYLES = {
  success: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    dot: "bg-emerald-400",
    icon: "text-emerald-400",
    title: "text-emerald-300",
  },
  warning: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    dot: "bg-amber-400",
    icon: "text-amber-400",
    title: "text-amber-300",
  },
  error: {
    bg: "bg-red-500/10",
    border: "border-red-500/20",
    dot: "bg-red-400",
    icon: "text-red-400",
    title: "text-red-300",
  },
  info: {
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    dot: "bg-blue-400",
    icon: "text-blue-400",
    title: "text-blue-300",
  },
};

function NotifIcon({ type, icon }: { type: string; icon?: string }) {
  const cls = `h-4 w-4 ${TYPE_STYLES[type as keyof typeof TYPE_STYLES]?.icon || "text-dark-400"}`;
  if (icon === "swap") return <ArrowRightLeft className={cls} />;
  if (icon === "clock") return <Clock className={cls} />;
  if (icon === "alert") return <AlertTriangle className={cls} />;
  if (type === "success") return <Check className={cls} />;
  if (type === "warning") return <Clock className={cls} />;
  if (type === "error") return <AlertTriangle className={cls} />;
  return <Info className={cls} />;
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const fetchNotifications = useCallback(async () => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) return;
    try {
      const { data } = await portalApi.get(
        `/api/portal/bot/${s.bot_name}/notifications?telegram_id=${s.telegram_id}`
      );
      setNotifications(data.notifications || []);
      setUnread(data.unread_count || 0);
    } catch {
      // silent
    }
  }, []);

  // Poll every 10 seconds
  useEffect(() => {
    fetchNotifications();
    const iv = setInterval(fetchNotifications, 10000);
    return () => clearInterval(iv);
  }, [fetchNotifications]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const markAllRead = async () => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) return;
    setLoading(true);
    try {
      await portalApi.post(
        `/api/portal/bot/${s.bot_name}/notifications/read?telegram_id=${s.telegram_id}`
      );
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnread(0);
    } catch { /* silent */ }
    setLoading(false);
  };

  const dismiss = async (id: string) => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) return;
    try {
      await portalApi.post(
        `/api/portal/bot/${s.bot_name}/notifications/${id}/dismiss?telegram_id=${s.telegram_id}`
      );
      setNotifications(prev => prev.filter(n => n.id !== id));
      setUnread(prev => Math.max(0, prev - 1));
    } catch { /* silent */ }
  };

  const togglePanel = () => {
    setOpen(prev => !prev);
    // Auto-mark as read when opening
    if (!open && unread > 0) {
      setTimeout(markAllRead, 1500);
    }
  };

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={btnRef}
        onClick={togglePanel}
        className={`relative p-2 rounded-xl transition-all duration-200 ${
          open
            ? "bg-accent/15 text-accent"
            : unread > 0
            ? "text-dark-200 hover:text-white hover:bg-dark-800"
            : "text-dark-500 hover:text-dark-300 hover:bg-dark-800/50"
        }`}
      >
        <Bell className={`h-5 w-5 ${unread > 0 ? "animate-[wiggle_0.5s_ease-in-out]" : ""}`} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4.5 w-4.5 items-center justify-center">
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-30 animate-ping" />
            <span className="relative flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white shadow-lg shadow-red-500/30">
              {unread > 9 ? "9+" : unread}
            </span>
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-80 sm:w-96 rounded-2xl border border-dark-700/50 bg-dark-900 shadow-2xl shadow-black/40 overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800/50 bg-dark-850/50">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-bold text-dark-100">Notifications</h3>
              {unread > 0 && (
                <span className="text-[9px] font-bold bg-accent/20 text-accent rounded-full px-1.5 py-0.5">
                  {unread} new
                </span>
              )}
            </div>
            {notifications.length > 0 && (
              <button
                onClick={markAllRead}
                disabled={loading || unread === 0}
                className="text-[10px] font-semibold text-dark-500 hover:text-accent disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                <CheckCheck className="h-3 w-3" />
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-[400px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <div className="h-12 w-12 rounded-full bg-dark-800/50 flex items-center justify-center mb-3">
                  <Bell className="h-6 w-6 text-dark-700" />
                </div>
                <p className="text-sm font-medium text-dark-400">No notifications yet</p>
                <p className="text-[10px] text-dark-600 mt-1">
                  You&apos;ll see alerts when sessions are replaced, queued, or need attention.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-dark-800/30">
                {notifications.map((n) => {
                  const style = TYPE_STYLES[n.type] || TYPE_STYLES.info;
                  return (
                    <div
                      key={n.id}
                      className={`group relative px-4 py-3 transition-colors ${
                        n.read
                          ? "hover:bg-dark-800/20"
                          : `${style.bg} hover:bg-dark-800/30`
                      }`}
                    >
                      <div className="flex gap-3">
                        {/* Icon */}
                        <div className={`shrink-0 h-8 w-8 rounded-lg ${style.bg} border ${style.border} flex items-center justify-center mt-0.5`}>
                          <NotifIcon type={n.type} icon={n.icon} />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`text-[12px] font-bold ${n.read ? "text-dark-300" : style.title}`}>
                              {n.title}
                            </p>
                            <div className="flex items-center gap-1 shrink-0">
                              {!n.read && (
                                <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                              )}
                              <span className="text-[9px] text-dark-600 whitespace-nowrap">
                                {timeAgo(n.ts)}
                              </span>
                            </div>
                          </div>
                          <p className={`text-[11px] mt-0.5 leading-relaxed ${
                            n.read ? "text-dark-500" : "text-dark-300"
                          }`}>
                            {n.message}
                          </p>
                        </div>

                        {/* Dismiss */}
                        <button
                          onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
                          className="shrink-0 opacity-0 group-hover:opacity-100 text-dark-600 hover:text-dark-300 p-1 transition-all"
                          title="Dismiss"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          {notifications.length > 5 && (
            <div className="px-4 py-2.5 border-t border-dark-800/50 bg-dark-850/30">
              <p className="text-[10px] text-dark-600 text-center">
                Showing {notifications.length} notification{notifications.length !== 1 ? "s" : ""}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
