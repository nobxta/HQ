"use client";
import { useState, useEffect } from "react";
import { usePortalBot } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { Link2, Plus, Trash2, Save, Type } from "lucide-react";
import toast from "react-hot-toast";

export default function UserCampaignPage() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const session = getPortalSession();

  const [messageMode, setMessageMode] = useState<"text" | "link">("link");
  const [messageText, setMessageText] = useState("");
  const [postLinks, setPostLinks] = useState<string[]>([]);
  const [newLink, setNewLink] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (bot) {
      setMessageMode(bot.message_mode || "link");
      setMessageText(bot.message_text || "");
      setPostLinks(bot.post_links || []);
    }
  }, [bot]);

  if (isLoading) return <PageSkeleton />;
  if (!bot) return <div className="text-center py-20 text-dark-400">Bot not found</div>;

  const addLink = () => {
    const link = newLink.trim();
    if (!link) return;
    if (postLinks.length >= 10) { toast.error("Max 10 links"); return; }
    setPostLinks([...postLinks, link]);
    setNewLink("");
  };

  const removeLink = (i: number) => {
    setPostLinks(postLinks.filter((_, idx) => idx !== i));
  };

  const saveMessage = async () => {
    setSaving(true);
    try {
      await portalApi.patch(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/message?telegram_id=${session?.telegram_id}`,
        { message_text: messageText, message_mode: messageMode }
      );
      toast.success("Message settings saved");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSaving(false);
  };

  const saveLinks = async () => {
    setSaving(true);
    try {
      await portalApi.put(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/links?telegram_id=${session?.telegram_id}`,
        { post_links: postLinks }
      );
      toast.success("Campaign links saved");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">
      <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Campaign</h1>

      {/* Message Mode */}
      <Card>
        <CardHeader><CardTitle>Message Mode</CardTitle></CardHeader>
        <div className="space-y-4">
          <p className="text-xs text-dark-500">
            <strong>Link mode</strong> forwards a message from your channel.{" "}
            <strong>Text mode</strong> posts custom text.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMessageMode("link")}
              className={`rounded-lg border p-3 sm:p-4 text-center transition-all ${
                messageMode === "link"
                  ? "border-accent bg-accent/5 text-accent"
                  : "border-dark-700 bg-dark-800 text-dark-400 hover:border-dark-600"
              }`}
            >
              <Link2 className="h-5 w-5 mx-auto mb-1.5" />
              <p className="text-sm font-medium">Link Mode</p>
              <p className="text-[10px] sm:text-xs mt-0.5 opacity-70">Forward from channel</p>
            </button>
            <button
              onClick={() => setMessageMode("text")}
              className={`rounded-lg border p-3 sm:p-4 text-center transition-all ${
                messageMode === "text"
                  ? "border-accent bg-accent/5 text-accent"
                  : "border-dark-700 bg-dark-800 text-dark-400 hover:border-dark-600"
              }`}
            >
              <Type className="h-5 w-5 mx-auto mb-1.5" />
              <p className="text-sm font-medium">Text Mode</p>
              <p className="text-[10px] sm:text-xs mt-0.5 opacity-70">Custom text message</p>
            </button>
          </div>
        </div>
      </Card>

      {/* Text Message */}
      {messageMode === "text" && (
        <Card>
          <CardHeader><CardTitle>Custom Text Message</CardTitle></CardHeader>
          <div className="space-y-3">
            <textarea
              className="w-full h-32 sm:h-36 rounded-lg border border-dark-600 bg-dark-950 px-3 sm:px-4 py-3 text-sm text-dark-200 font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Enter your post message (max 500 chars)..."
              maxLength={500}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-dark-500">{messageText.length}/500</span>
              <Button onClick={saveMessage} loading={saving} size="sm">
                <Save className="h-4 w-4" /> Save
              </Button>
            </div>
          </div>
        </Card>
      )}

      {messageMode !== (bot.message_mode || "link") && (
        <div className="flex justify-end">
          <Button onClick={saveMessage} loading={saving} size="sm">
            <Save className="h-4 w-4" /> Save Mode
          </Button>
        </div>
      )}

      {/* Post Links */}
      <Card>
        <CardHeader>
          <CardTitle>Post Links ({postLinks.length}/10)</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <p className="text-xs text-dark-500">
            Add Telegram message links. The bot randomly picks one per cycle and forwards it.
          </p>

          {postLinks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-dark-600 p-5 sm:p-6 text-center">
              <Link2 className="h-6 w-6 mx-auto text-dark-500 mb-2" />
              <p className="text-sm text-dark-400">No links added yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {postLinks.map((link, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-dark-800 px-3 py-2">
                  <Link2 className="h-3.5 w-3.5 text-accent shrink-0" />
                  <span className="flex-1 text-xs sm:text-sm text-dark-300 font-mono truncate">{link}</span>
                  <button onClick={() => removeLink(i)} className="text-dark-500 hover:text-danger transition-colors shrink-0 p-1">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              className="flex-1 min-w-0 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="t.me/c/123456/789"
              value={newLink}
              onChange={(e) => setNewLink(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addLink()}
            />
            <Button variant="secondary" size="sm" onClick={addLink} className="shrink-0">
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex justify-end">
            <Button onClick={saveLinks} loading={saving}>
              <Save className="h-4 w-4" /> Save Links
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
