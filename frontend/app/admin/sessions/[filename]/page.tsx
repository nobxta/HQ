"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import api from "@/lib/api";
import toast from "react-hot-toast";
import {
  ArrowLeft, Send, User, MessageCircle,
  Phone, AtSign, Shield, Edit3, Camera, Trash2,
  Lock, Eye, Users, PhoneForwarded, Image as ImageIcon,
  Loader2, CheckCheck, Clock, Globe, Smartphone,
  LogOut, X, Star, Hash, Search, Settings, RefreshCw,
} from "lucide-react";

// ── Types ──
type Profile = {
  user_id: number; first_name: string; last_name: string;
  username: string; phone: string; bio: string;
  premium: boolean; restricted: boolean; avatar: string | null;
};
type ChatItem = {
  id: number; name: string; type: string; unread_count: number;
  last_message: string; last_date: string | null; pinned: boolean; muted: boolean;
};
type Message = {
  id: number; text: string; date: string | null; out: boolean;
  sender_id: number; sender_name: string; reply_to: number | null;
  media_type: string | null; edited: boolean;
};
type Privacy = Record<string, string>;
type ActiveSession = {
  hash: string; device: string; platform: string; system_version: string;
  app_name: string; app_version: string; date_active: string | null;
  ip: string; country: string; current: boolean;
};

// ── Telegram-style avatar colors ──
const AVATAR_COLORS = [
  "from-red-500 to-rose-600", "from-orange-500 to-amber-600",
  "from-emerald-500 to-green-600", "from-cyan-500 to-teal-600",
  "from-blue-500 to-indigo-600", "from-violet-500 to-purple-600",
  "from-pink-500 to-fuchsia-600", "from-yellow-500 to-orange-500",
];
function avatarColor(id: number) {
  return AVATAR_COLORS[Math.abs(id) % AVATAR_COLORS.length];
}

// ── LocalStorage cache helpers ──
function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    // Cache valid for 10 minutes
    if (Date.now() - ts > 600_000) return null;
    return data as T;
  } catch { return null; }
}
function cacheSet(key: string, data: any) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

// ── Skeleton components ──
function ChatSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 animate-pulse">
      <div className="h-[52px] w-[52px] rounded-full bg-[#2a2a3a] shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="flex justify-between">
          <div className="h-3.5 w-28 bg-[#2a2a3a] rounded" />
          <div className="h-3 w-12 bg-[#2a2a3a] rounded" />
        </div>
        <div className="h-3 w-48 bg-[#2a2a3a] rounded" />
      </div>
    </div>
  );
}

function MessageSkeleton({ out }: { out: boolean }) {
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"} animate-pulse`}>
      <div className={`rounded-2xl px-4 py-3 space-y-2 ${out ? "bg-[#1a2a3a]" : "bg-[#2a2a3a]"}`}
        style={{ width: `${Math.random() * 30 + 25}%` }}>
        <div className="h-3 w-full bg-white/5 rounded" />
        <div className="h-3 w-2/3 bg-white/5 rounded" />
      </div>
    </div>
  );
}

// ── Time formatter ──
function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff < 7 * 86400_000)
    return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullTime(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Right panel content type ──
type RightPanel = "none" | "profile" | "privacy" | "devices";

export default function SessionClientPage() {
  const params = useParams();
  const router = useRouter();
  const filename = decodeURIComponent(params.filename as string);
  const base = `/api/session-client/${encodeURIComponent(filename)}`;
  const cachePrefix = `sc_${filename}_`;

  // Core state
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [activeChat, setActiveChat] = useState<ChatItem | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [searchQuery, setSearchQuery] = useState("");

  // Loading states
  const [connectingProfile, setConnectingProfile] = useState(true);
  const [loadingChats, setLoadingChats] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Message input
  const [msgInput, setMsgInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const msgInputRef = useRef<HTMLInputElement>(null);

  // Profile edit
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ first_name: "", last_name: "", bio: "", username: "" });
  const [saving, setSaving] = useState(false);

  // Privacy & Devices
  const [privacy, setPrivacy] = useState<Privacy>({});
  const [loadingPrivacy, setLoadingPrivacy] = useState(false);
  const [devices, setDevices] = useState<ActiveSession[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const avatarRef = useRef<HTMLInputElement>(null);

  // ── Load: show localStorage cache instantly → single /init API call ──
  useEffect(() => {
    // 1. Show cached data from localStorage INSTANTLY (0ms)
    const cachedProfile = cacheGet<Profile>(cachePrefix + "profile");
    const cachedChats = cacheGet<ChatItem[]>(cachePrefix + "chats");
    if (cachedProfile) {
      setProfile(cachedProfile);
      setEditForm({
        first_name: cachedProfile.first_name, last_name: cachedProfile.last_name,
        bio: cachedProfile.bio, username: cachedProfile.username,
      });
      setConnectingProfile(false);
    }
    if (cachedChats) {
      setChats(cachedChats);
      setLoadingChats(false);
    }

    // 2. Single /init call gets profile+chats from server (uses server cache if warm)
    loadInit(!cachedProfile, !cachedChats);
  }, []);

  const loadInit = async (showProfileLoader = true, showChatsLoader = true) => {
    if (showProfileLoader) setConnectingProfile(true);
    if (showChatsLoader) setLoadingChats(true);
    setError(null);
    try {
      const { data } = await api.get(`${base}/init`);
      // Update profile
      setProfile(data.profile);
      setEditForm({
        first_name: data.profile.first_name, last_name: data.profile.last_name,
        bio: data.profile.bio, username: data.profile.username,
      });
      cacheSet(cachePrefix + "profile", data.profile);
      // Update chats
      setChats(data.chats);
      cacheSet(cachePrefix + "chats", data.chats);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || "Failed to connect to session";
      // Only show error page if we have NO cached data at all
      if (!cacheGet<Profile>(cachePrefix + "profile")) setError(msg);
      toast.error(msg);
    }
    setConnectingProfile(false);
    setLoadingChats(false);
  };

  // Standalone refresh functions (used after edits)
  const loadProfile = async () => {
    try {
      const { data } = await api.get(`${base}/profile`);
      setProfile(data);
      setEditForm({ first_name: data.first_name, last_name: data.last_name, bio: data.bio, username: data.username });
      cacheSet(cachePrefix + "profile", data);
    } catch {}
  };

  const loadChats = async () => {
    try {
      const { data } = await api.get(`${base}/chats?limit=80`);
      setChats(data.chats);
      cacheSet(cachePrefix + "chats", data.chats);
    } catch {}
  };

  const openChat = async (chat: ChatItem) => {
    setActiveChat(chat);
    setLoadingMessages(true);
    // Show cached messages instantly
    const cached = cacheGet<Message[]>(cachePrefix + "msgs_" + chat.id);
    if (cached) {
      setMessages(cached);
      setLoadingMessages(false);
      setTimeout(() => messagesEnd.current?.scrollIntoView({ behavior: "auto" }), 50);
    }
    try {
      const { data } = await api.get(`${base}/chat/${chat.id}/messages?limit=50`);
      setMessages(data.messages);
      cacheSet(cachePrefix + "msgs_" + chat.id, data.messages);
      setTimeout(() => messagesEnd.current?.scrollIntoView({ behavior: cached ? "smooth" : "auto" }), 50);
    } catch { toast.error("Failed to load messages"); }
    setLoadingMessages(false);
    setTimeout(() => msgInputRef.current?.focus(), 100);
  };

  const handleSend = async () => {
    if (!msgInput.trim() || !activeChat) return;
    const text = msgInput;
    setMsgInput("");
    // Optimistic: add message instantly
    const optimistic: Message = {
      id: Date.now(), text, date: new Date().toISOString(), out: true,
      sender_id: profile?.user_id || 0, sender_name: "You",
      reply_to: null, media_type: null, edited: false,
    };
    setMessages(prev => [...prev, optimistic]);
    setTimeout(() => messagesEnd.current?.scrollIntoView({ behavior: "smooth" }), 50);
    setSending(true);
    try {
      const { data } = await api.post(`${base}/chat/${activeChat.id}/send`, { text });
      // Replace optimistic with real
      setMessages(prev => prev.map(m => m.id === optimistic.id ? { ...optimistic, id: data.message_id, date: data.date || optimistic.date } : m));
    } catch (e: any) {
      toast.error("Failed to send");
      setMessages(prev => prev.filter(m => m.id !== optimistic.id));
      setMsgInput(text); // Restore input
    }
    setSending(false);
  };

  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      await api.put(`${base}/profile`, editForm);
      toast.success("Profile updated");
      setEditing(false);
      loadProfile();
    } catch (e: any) { toast.error(e?.response?.data?.detail || "Failed to update"); }
    setSaving(false);
  };

  const loadPrivacy = async () => {
    setLoadingPrivacy(true);
    try {
      const { data } = await api.get(`${base}/privacy`);
      setPrivacy(data.privacy);
    } catch { toast.error("Failed to load privacy"); }
    setLoadingPrivacy(false);
  };
  const updatePrivacy = async (key: string, value: string) => {
    const prev = privacy[key];
    setPrivacy(p => ({ ...p, [key]: value })); // Optimistic
    try {
      await api.put(`${base}/privacy`, { key, value });
      toast.success(`${key.replace(/_/g, " ")} → ${value}`);
    } catch {
      setPrivacy(p => ({ ...p, [key]: prev })); // Revert
      toast.error("Failed to update");
    }
  };
  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      const { data } = await api.get(`${base}/active-sessions`);
      setDevices(data.sessions);
    } catch { toast.error("Failed to load devices"); }
    setLoadingDevices(false);
  };

  const toggleRightPanel = (panel: RightPanel) => {
    if (rightPanel === panel) { setRightPanel("none"); return; }
    setRightPanel(panel);
    if (panel === "privacy" && Object.keys(privacy).length === 0) loadPrivacy();
    if (panel === "devices" && devices.length === 0) loadDevices();
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const form = new FormData(); form.append("file", file);
    try {
      await api.post(`${base}/avatar`, form, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("Avatar updated"); loadProfile();
    } catch { toast.error("Failed to upload avatar"); }
  };
  const deleteAvatar = async () => {
    try { await api.delete(`${base}/avatar`); toast.success("Avatar deleted"); loadProfile(); }
    catch { toast.error("Failed to delete avatar"); }
  };

  // Filter chats by search
  const filteredChats = useMemo(() => {
    if (!searchQuery.trim()) return chats;
    const q = searchQuery.toLowerCase();
    return chats.filter(c => c.name.toLowerCase().includes(q) || c.last_message.toLowerCase().includes(q));
  }, [chats, searchQuery]);

  // ── Error state ──
  if (error && !profile) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0e0e1a]">
        <div className="text-center">
          <div className="h-16 w-16 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <X className="h-8 w-8 text-red-400" />
          </div>
          <p className="text-base font-semibold text-[#e4e4f0] mb-1">Connection Failed</p>
          <p className="text-sm text-[#6b6b80] mb-2 max-w-xs">{error}</p>
          <p className="text-xs text-[#4a4a5a] font-mono mb-6">{filename}</p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => router.push("/admin/sessions")}
              className="px-5 py-2.5 rounded-xl bg-[#1e1e2e] text-[#9a9ab0] text-sm hover:bg-[#2a2a3a] transition">
              <ArrowLeft className="h-4 w-4 inline mr-2" />Back
            </button>
            <button onClick={() => loadInit(true, true)}
              className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-500 transition">
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-[#0e0e1a] overflow-hidden">

      {/* ══════════════ LEFT PANEL — Chat List ══════════════ */}
      <div className={`${activeChat ? "hidden lg:flex" : "flex"} flex-col w-full lg:w-[340px] xl:w-[380px] border-r border-[#1e1e2e] shrink-0`}>
        {/* Header */}
        <div className="shrink-0 px-3 py-2.5 flex items-center gap-2 bg-[#17171f] border-b border-[#1e1e2e]">
          <button onClick={() => router.push("/admin/sessions")}
            className="p-2 rounded-lg text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e] transition">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            {connectingProfile ? (
              <div className="animate-pulse">
                <div className="h-3.5 w-24 bg-[#2a2a3a] rounded mb-1" />
                <div className="h-2.5 w-36 bg-[#2a2a3a] rounded" />
              </div>
            ) : (
              <>
                <p className="text-sm font-semibold text-[#e4e4f0] truncate">
                  {profile?.first_name} {profile?.last_name}
                </p>
                <p className="text-[10px] text-[#6b6b80] font-mono truncate">{filename}</p>
              </>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={() => toggleRightPanel("profile")}
              className={`p-2 rounded-lg transition ${rightPanel === "profile" ? "text-blue-400 bg-blue-500/10" : "text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e]"}`}>
              <User className="h-4.5 w-4.5" />
            </button>
            <button onClick={() => toggleRightPanel("privacy")}
              className={`p-2 rounded-lg transition ${rightPanel === "privacy" ? "text-blue-400 bg-blue-500/10" : "text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e]"}`}>
              <Shield className="h-4.5 w-4.5" />
            </button>
            <button onClick={() => toggleRightPanel("devices")}
              className={`p-2 rounded-lg transition ${rightPanel === "devices" ? "text-blue-400 bg-blue-500/10" : "text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e]"}`}>
              <Smartphone className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 py-2 bg-[#17171f]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#4a4a5a]" />
            <input
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search chats..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#1e1e2e] text-sm text-[#e4e4f0] placeholder:text-[#4a4a5a] focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition"
            />
          </div>
        </div>

        {/* Chat List */}
        <div className="flex-1 overflow-y-auto">
          {loadingChats && chats.length === 0 ? (
            Array.from({ length: 12 }).map((_, i) => <ChatSkeleton key={i} />)
          ) : filteredChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-[#4a4a5a]">
              <MessageCircle className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm">{searchQuery ? "No chats found" : "No chats"}</p>
            </div>
          ) : (
            filteredChats.map(chat => (
              <button key={chat.id} onClick={() => openChat(chat)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 transition-colors ${
                  activeChat?.id === chat.id ? "bg-blue-600/15" : "hover:bg-[#1a1a28]"
                }`}>
                {/* Avatar */}
                <div className={`h-[52px] w-[52px] rounded-full bg-gradient-to-br ${avatarColor(chat.id)} flex items-center justify-center text-white font-semibold text-lg shrink-0 relative`}>
                  {chat.type === "channel" ? (
                    <Globe className="h-5 w-5" />
                  ) : chat.type === "group" ? (
                    <Users className="h-5 w-5" />
                  ) : (
                    chat.name[0]?.toUpperCase() || "?"
                  )}
                  {chat.unread_count > 0 && (
                    <span className="absolute -bottom-0.5 -right-0.5 h-[22px] min-w-[22px] rounded-full bg-blue-500 text-white text-[11px] font-bold flex items-center justify-center px-1 shadow-lg shadow-blue-500/30">
                      {chat.unread_count > 99 ? "99+" : chat.unread_count}
                    </span>
                  )}
                </div>
                {/* Info */}
                <div className="flex-1 min-w-0 text-left">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[13px] font-medium text-[#e4e4f0] truncate">{chat.name}</span>
                    <span className="text-[11px] text-[#6b6b80] shrink-0 ml-2">{formatTime(chat.last_date)}</span>
                  </div>
                  <p className="text-[12px] text-[#6b6b80] truncate leading-relaxed">
                    {chat.last_message || "​"}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ══════════════ CENTER PANEL — Messages ══════════════ */}
      <div className={`${!activeChat ? "hidden lg:flex" : "flex"} flex-1 flex-col min-w-0`}>
        {activeChat ? (
          <>
            {/* Chat header */}
            <div className="shrink-0 px-4 py-2.5 flex items-center gap-3 bg-[#17171f] border-b border-[#1e1e2e]">
              <button onClick={() => setActiveChat(null)} className="lg:hidden p-1.5 rounded-lg text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e] transition">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className={`h-10 w-10 rounded-full bg-gradient-to-br ${avatarColor(activeChat.id)} flex items-center justify-center text-white font-semibold shrink-0`}>
                {activeChat.type === "channel" ? <Globe className="h-4 w-4" />
                  : activeChat.type === "group" ? <Users className="h-4 w-4" />
                  : activeChat.name[0]?.toUpperCase() || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#e4e4f0] truncate">{activeChat.name}</p>
                <p className="text-[11px] text-[#6b6b80]">{activeChat.type}{loadingMessages ? " · loading..." : ""}</p>
              </div>
              <button onClick={() => loadChats()} className="p-2 rounded-lg text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e] transition">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5"
              style={{ background: "linear-gradient(180deg, #0d0d18 0%, #111122 50%, #0d0d18 100%)" }}>
              {loadingMessages && messages.length === 0 ? (
                <div className="space-y-2 py-4">
                  {Array.from({ length: 8 }).map((_, i) => <MessageSkeleton key={i} out={i % 3 === 0} />)}
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-[#4a4a5a]">
                  <MessageCircle className="h-12 w-12 mb-3 opacity-30" />
                  <p className="text-sm">No messages yet</p>
                </div>
              ) : (
                messages.map((m, idx) => {
                  const prevMsg = messages[idx - 1];
                  const showDate = !prevMsg || (m.date && prevMsg.date &&
                    new Date(m.date).toDateString() !== new Date(prevMsg.date).toDateString());
                  const sameSender = prevMsg && prevMsg.out === m.out && prevMsg.sender_id === m.sender_id;

                  return (
                    <div key={m.id}>
                      {showDate && m.date && (
                        <div className="flex justify-center py-3">
                          <span className="text-[11px] text-[#6b6b80] bg-[#1a1a28] px-3 py-1 rounded-full">
                            {new Date(m.date).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}
                          </span>
                        </div>
                      )}
                      <div className={`flex ${m.out ? "justify-end" : "justify-start"} ${sameSender ? "mt-0.5" : "mt-2"}`}>
                        <div className={`max-w-[65%] xl:max-w-[55%] rounded-2xl px-3.5 py-[7px] ${
                          m.out
                            ? "bg-blue-600/20 border border-blue-500/10 rounded-br-md"
                            : "bg-[#1e1e2e] border border-[#2a2a3a] rounded-bl-md"
                        }`}>
                          {!m.out && !sameSender && m.sender_name && (
                            <p className="text-[11px] font-semibold text-blue-400 mb-0.5">{m.sender_name}</p>
                          )}
                          {m.media_type && m.media_type !== "NoneType" && (
                            <div className="flex items-center gap-1.5 text-[11px] text-[#6b6b80] mb-1 bg-[#0e0e1a]/40 rounded-lg px-2 py-1">
                              <ImageIcon className="h-3.5 w-3.5" />
                              <span>{m.media_type}</span>
                            </div>
                          )}
                          {m.text ? (
                            <p className="text-[13.5px] text-[#e4e4f0] whitespace-pre-wrap break-words leading-[1.4]">{m.text}</p>
                          ) : (!m.media_type || m.media_type === "NoneType") ? (
                            <p className="text-[13px] text-[#4a4a5a] italic">Empty message</p>
                          ) : null}
                          <div className="flex items-center justify-end gap-1.5 -mb-0.5 mt-0.5">
                            {m.edited && <span className="text-[10px] text-[#4a4a5a]">edited</span>}
                            <span className="text-[10px] text-[#4a4a5a]">{formatFullTime(m.date)}</span>
                            {m.out && <CheckCheck className="h-3.5 w-3.5 text-blue-400/60" />}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEnd} />
            </div>

            {/* Input */}
            <div className="shrink-0 flex items-center gap-2 px-4 py-3 bg-[#17171f] border-t border-[#1e1e2e]">
              <input ref={msgInputRef}
                value={msgInput} onChange={e => setMsgInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="Write a message..."
                className="flex-1 bg-[#1e1e2e] rounded-xl px-4 py-2.5 text-[13.5px] text-[#e4e4f0] placeholder:text-[#4a4a5a] focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition"
              />
              <button onClick={handleSend} disabled={sending || !msgInput.trim()}
                className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-white hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600 transition shrink-0">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </>
        ) : (
          /* Empty state when no chat selected (desktop) */
          <div className="hidden lg:flex flex-1 flex-col items-center justify-center text-[#4a4a5a]">
            <div className="h-20 w-20 rounded-3xl bg-[#1e1e2e] flex items-center justify-center mb-4">
              <MessageCircle className="h-10 w-10 opacity-40" />
            </div>
            <p className="text-base font-medium text-[#6b6b80]">Select a chat</p>
            <p className="text-sm mt-1">Choose a conversation from the left panel</p>
          </div>
        )}
      </div>

      {/* ══════════════ RIGHT PANEL — Profile / Privacy / Devices ══════════════ */}
      {rightPanel !== "none" && (
        <div className="hidden lg:flex flex-col w-[320px] xl:w-[360px] border-l border-[#1e1e2e] bg-[#14141e] shrink-0">
          {/* Panel header */}
          <div className="shrink-0 px-4 py-3 flex items-center justify-between border-b border-[#1e1e2e] bg-[#17171f]">
            <p className="text-sm font-semibold text-[#e4e4f0]">
              {rightPanel === "profile" ? "Profile" : rightPanel === "privacy" ? "Privacy" : "Devices"}
            </p>
            <button onClick={() => setRightPanel("none")} className="p-1.5 rounded-lg text-[#6b6b80] hover:text-[#e4e4f0] hover:bg-[#1e1e2e] transition">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* ── PROFILE PANEL ── */}
            {rightPanel === "profile" && profile && (
              <div>
                {/* Avatar + name */}
                <div className="flex flex-col items-center pt-6 pb-4 bg-gradient-to-b from-[#1e1e2e]/50 to-transparent">
                  <div className="relative group">
                    <div className={`h-[88px] w-[88px] rounded-full bg-gradient-to-br ${avatarColor(profile.user_id)} flex items-center justify-center text-white text-3xl font-bold overflow-hidden`}>
                      {profile.avatar ? (
                        <img src={`data:image/jpeg;base64,${profile.avatar}`} className="h-full w-full object-cover" />
                      ) : (profile.first_name?.[0] || "?").toUpperCase()}
                    </div>
                    <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                      <button onClick={() => avatarRef.current?.click()} className="text-white p-1.5 rounded-full hover:bg-white/20"><Camera className="h-4 w-4" /></button>
                      {profile.avatar && <button onClick={deleteAvatar} className="text-white p-1.5 rounded-full hover:bg-white/20"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                    <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
                  </div>
                  <h3 className="text-base font-bold text-[#e4e4f0] mt-3">{profile.first_name} {profile.last_name}</h3>
                  {profile.username && <p className="text-sm text-blue-400">@{profile.username}</p>}
                  <div className="flex gap-1.5 mt-1.5">
                    {profile.premium && (
                      <span className="text-[10px] bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Star className="h-3 w-3 fill-current" /> Premium
                      </span>
                    )}
                    {profile.restricted && (
                      <span className="text-[10px] bg-red-500/10 text-red-400 px-2 py-0.5 rounded-full">Restricted</span>
                    )}
                  </div>
                </div>

                {!editing ? (
                  <div className="px-4 space-y-0.5">
                    {[
                      { icon: Phone, label: "Phone", value: profile.phone || "Hidden", mono: true },
                      { icon: AtSign, label: "Username", value: `@${profile.username || "none"}` },
                      { icon: Hash, label: "User ID", value: String(profile.user_id), mono: true },
                    ].map(item => (
                      <div key={item.label} className="flex items-center gap-3 py-3 border-b border-[#1e1e2e]/50">
                        <item.icon className="h-4 w-4 text-[#6b6b80]" />
                        <div>
                          <p className={`text-sm text-[#e4e4f0] ${item.mono ? "font-mono" : ""}`}>{item.value}</p>
                          <p className="text-[10px] text-[#4a4a5a]">{item.label}</p>
                        </div>
                      </div>
                    ))}
                    {profile.bio && (
                      <div className="flex items-start gap-3 py-3 border-b border-[#1e1e2e]/50">
                        <Edit3 className="h-4 w-4 text-[#6b6b80] mt-0.5" />
                        <div>
                          <p className="text-sm text-[#c4c4d0]">{profile.bio}</p>
                          <p className="text-[10px] text-[#4a4a5a]">Bio</p>
                        </div>
                      </div>
                    )}
                    <button onClick={() => setEditing(true)}
                      className="w-full mt-4 py-2.5 rounded-xl bg-blue-600/10 text-blue-400 text-sm font-medium hover:bg-blue-600/20 transition">
                      Edit Profile
                    </button>
                  </div>
                ) : (
                  <div className="px-4 space-y-3 pt-2">
                    {[
                      { key: "first_name" as const, label: "First Name" },
                      { key: "last_name" as const, label: "Last Name" },
                      { key: "username" as const, label: "Username" },
                    ].map(f => (
                      <div key={f.key}>
                        <label className="text-[10px] text-[#6b6b80] uppercase tracking-wider">{f.label}</label>
                        <input value={editForm[f.key]} onChange={e => setEditForm({ ...editForm, [f.key]: e.target.value })}
                          className="w-full mt-1 rounded-lg bg-[#1e1e2e] border border-[#2a2a3a] px-3 py-2 text-sm text-[#e4e4f0] focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
                      </div>
                    ))}
                    <div>
                      <label className="text-[10px] text-[#6b6b80] uppercase tracking-wider">Bio</label>
                      <textarea value={editForm.bio} onChange={e => setEditForm({ ...editForm, bio: e.target.value })}
                        rows={3} maxLength={70}
                        className="w-full mt-1 rounded-lg bg-[#1e1e2e] border border-[#2a2a3a] px-3 py-2 text-sm text-[#e4e4f0] focus:outline-none focus:ring-1 focus:ring-blue-500/30 resize-none" />
                      <p className="text-[10px] text-[#4a4a5a] text-right">{editForm.bio.length}/70</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setEditing(false)}
                        className="flex-1 py-2.5 rounded-xl bg-[#1e1e2e] text-[#9a9ab0] text-sm hover:bg-[#2a2a3a] transition">Cancel</button>
                      <button onClick={handleSaveProfile} disabled={saving}
                        className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-500 transition disabled:opacity-50 flex items-center justify-center gap-2">
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── PRIVACY PANEL ── */}
            {rightPanel === "privacy" && (
              <div className="px-3 py-3">
                {loadingPrivacy ? (
                  <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 text-[#4a4a5a] animate-spin" /></div>
                ) : (
                  <div className="space-y-2">
                    {[
                      { key: "phone_number", label: "Phone Number", desc: "Who sees your phone", icon: Phone },
                      { key: "last_seen", label: "Last Seen", desc: "Who sees your activity", icon: Clock },
                      { key: "profile_photo", label: "Profile Photo", desc: "Who sees your photo", icon: ImageIcon },
                      { key: "group_invite", label: "Group Invites", desc: "Who can add you", icon: Users },
                      { key: "forwarded", label: "Forwarded Messages", desc: "Link to your account", icon: PhoneForwarded },
                      { key: "calls", label: "Calls", desc: "Who can call you", icon: Phone },
                    ].map(item => (
                      <div key={item.key} className="rounded-xl bg-[#1a1a28] border border-[#2a2a3a]/50 p-3">
                        <div className="flex items-center gap-2.5 mb-2.5">
                          <div className="h-7 w-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
                            <item.icon className="h-3.5 w-3.5 text-blue-400" />
                          </div>
                          <div>
                            <p className="text-[12.5px] font-medium text-[#e4e4f0]">{item.label}</p>
                            <p className="text-[10px] text-[#6b6b80]">{item.desc}</p>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          {["everyone", "contacts", "nobody"].map(val => (
                            <button key={val} onClick={() => updatePrivacy(item.key, val)}
                              className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition ${
                                privacy[item.key] === val
                                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                                  : "bg-[#1e1e2e] text-[#6b6b80] hover:text-[#9a9ab0]"
                              }`}>
                              {val}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── DEVICES PANEL ── */}
            {rightPanel === "devices" && (
              <div className="px-3 py-3">
                {loadingDevices ? (
                  <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 text-[#4a4a5a] animate-spin" /></div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] text-[#6b6b80] uppercase tracking-wider font-medium px-1 mb-1">
                      {devices.length} Active Session{devices.length !== 1 ? "s" : ""}
                    </p>
                    {devices.map(d => (
                      <div key={d.hash} className={`rounded-xl border p-3 ${
                        d.current ? "border-blue-500/30 bg-blue-500/5" : "border-[#2a2a3a]/50 bg-[#1a1a28]"
                      }`}>
                        <div className="flex items-center gap-2.5">
                          <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${d.current ? "bg-blue-500/15" : "bg-[#1e1e2e]"}`}>
                            <Smartphone className={`h-4 w-4 ${d.current ? "text-blue-400" : "text-[#6b6b80]"}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[12.5px] font-medium text-[#e4e4f0] truncate">{d.app_name || d.device || "Unknown"}</p>
                              {d.current && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-semibold">YOU</span>}
                            </div>
                            <p className="text-[10px] text-[#6b6b80]">{d.device} · {d.platform}</p>
                            <p className="text-[10px] text-[#4a4a5a]">{d.ip} · {d.country}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
