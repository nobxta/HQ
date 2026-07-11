"use client";
import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { usePortalBot } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { MessageSquare, Save, Inbox, ExternalLink } from "lucide-react";
import toast from "react-hot-toast";

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface DmMsg {
  id: string; ts: number; session_file?: string; account_username?: string;
  sender_id?: number; sender_name?: string; sender_username?: string;
  text?: string; media_type?: string; caption?: string;
}

export default function UserAutoReplyPage() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const session = getPortalSession();

  const [enabled, setEnabled] = useState(true);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [account, setAccount] = useState("");

  const defaultMsg = bot?.dm_autoreply_default || "";
  const footer = bot?.dm_autoreply_footer || "";

  useEffect(() => {
    if (bot?.dm_autoreply) {
      setEnabled(bot.dm_autoreply.enabled ?? true);
      setMessage(bot.dm_autoreply.message || "");
    }
  }, [bot]);

  const inboxUrl = bot
    ? `/api/portal/bot/${encodeURIComponent(bot.name)}/dm-inbox?telegram_id=${session?.telegram_id}${account ? `&account=${encodeURIComponent(account)}` : ""}`
    : null;
  const { data: inbox } = useSWR<{ messages: DmMsg[]; accounts: string[]; unread_count: number }>(
    inboxUrl,
    (url: string) => portalApi.get(url).then((r) => r.data),
    { refreshInterval: 12000 }
  );

  // Live preview mirrors the backend: (custom or default) + blank line + locked footer.
  const previewBody = (message.trim() || defaultMsg);
  const finalPreview = footer && !previewBody.includes(footer) ? `${previewBody}\n\n${footer}` : previewBody;

  const save = useCallback(async () => {
    if (!bot) return;
    setSaving(true);
    try {
      await portalApi.put(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/autoreply?telegram_id=${session?.telegram_id}`,
        { enabled, message }
      );
      toast.success("Auto-reply saved");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSaving(false);
  }, [bot, enabled, message, session?.telegram_id, mutate]);

  if (isLoading) return <PageSkeleton />;
  if (!bot) return <div className="text-center py-20 text-dark-400">Bot not found</div>;

  const messages = inbox?.messages || [];

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Auto Reply</h1>
        <p className="text-sm text-dark-400 mt-1">Replies sent automatically when someone DMs one of your posting accounts (while the AdBot is running).</p>
      </div>

      {/* Config */}
      <Card>
        <CardHeader>
          <CardTitle><MessageSquare className="h-4 w-4 inline mr-2" />Auto Reply Message</CardTitle>
          <button
            onClick={() => setEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? "bg-accent" : "bg-dark-600"}`}
            role="switch" aria-checked={enabled}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </CardHeader>
        <div className="space-y-4">
          <p className="text-xs">
            Status: <span className={enabled ? "text-success font-semibold" : "text-dark-400 font-semibold"}>{enabled ? "ON" : "OFF"}</span>
            {!enabled && <span className="text-dark-500"> — no automatic replies are sent. Your message is kept for when you turn it back on.</span>}
          </p>

          <div>
            <label className="block text-sm font-medium text-dark-300 mb-1.5">Your message {message.trim() ? "" : "(leave blank to use the default)"}</label>
            <textarea
              className="w-full h-28 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2.5 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none disabled:opacity-50"
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 500))}
              disabled={!enabled}
              placeholder={defaultMsg}
              maxLength={500}
            />
            <div className="text-xs text-dark-500 mt-1">{message.length}/500</div>
          </div>

          {/* Final preview */}
          <div>
            <p className="text-sm font-medium text-dark-300 mb-1.5">Final reply preview</p>
            <div className="rounded-lg border border-dark-700 bg-dark-900 px-3 py-3 text-sm text-dark-200 whitespace-pre-wrap">
              {finalPreview}
            </div>
            <p className="text-[11px] text-dark-500 mt-1">The HQAdz line is always added automatically and can't be removed.</p>
          </div>

          <div className="flex justify-end">
            <Button onClick={save} loading={saving} size="sm"><Save className="h-4 w-4" /> Save</Button>
          </div>
        </div>
      </Card>

      {/* Inbox */}
      <Card>
        <CardHeader>
          <CardTitle><Inbox className="h-4 w-4 inline mr-2" />Messages Received ({messages.length})</CardTitle>
          {(inbox?.accounts?.length || 0) > 0 && (
            <select value={account} onChange={(e) => setAccount(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-2.5 py-1.5 text-xs text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
              <option value="">All accounts</option>
              {inbox!.accounts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
        </CardHeader>
        {messages.length === 0 ? (
          <div className="text-center py-10 text-dark-500 text-sm">No messages yet.</div>
        ) : (
          <div className="divide-y divide-dark-800/50">
            {messages.map((m) => (
              <div key={m.id} className="py-3 flex gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-dark-100">{m.sender_name || "Unknown"}</span>
                    {m.sender_username && <span className="text-xs text-dark-500">@{m.sender_username}</span>}
                    {m.sender_id ? (
                      <a href={`tg://user?id=${m.sender_id}`} className="inline-flex items-center gap-1 rounded-md bg-accent/10 text-accent px-2 py-0.5 text-[11px] hover:bg-accent/20 transition-colors" title="Open sender profile">
                        ID {m.sender_id} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
                  <p className="text-sm text-dark-300 mt-0.5 break-words">
                    {m.media_type ? <span><span className="text-dark-500">[{m.media_type}]</span> {m.caption || ""}</span> : (m.text || "—")}
                  </p>
                  <p className="text-[11px] text-dark-500 mt-1">
                    to {m.account_username ? `@${m.account_username}` : (m.session_file || "account")} · {timeAgo(m.ts)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
