"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Camera, CheckCircle2, Copy, KeyRound, Link2, Loader2,
  MessageCircle, Pencil, RefreshCw, Save, UserRound, Users, X,
} from "lucide-react";
import toast from "react-hot-toast";
import api from "@/lib/api";
import type { SessionOverviewItem } from "@/lib/types";

type Section = "home" | "profile" | "join" | "code" | "chats";
type Profile = {
  user_id: number; first_name: string; last_name: string; username: string;
  phone: string; bio: string; avatar: string | null;
};
type Chat = { id: number; name: string; type: string; unread_count: number };

const inputClass = "w-full rounded-lg border border-dark-700 bg-dark-900 px-3 py-2 text-sm text-dark-100 placeholder:text-dark-600 focus:border-accent/50 focus:outline-none";

export default function SessionManagePanel({ session, onClose }: { session: SessionOverviewItem; onClose: () => void }) {
  const base = `/api/session-client/${encodeURIComponent(session.filename)}`;
  const [section, setSection] = useState<Section>("home");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState({ first_name: "", last_name: "", username: "", bio: "" });
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [codeStatus, setCodeStatus] = useState<"idle" | "waiting" | "received" | "expired">("idle");
  const [phone, setPhone] = useState(session.phone || "");
  const [code, setCode] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);

  const loadProfile = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`${base}/profile`);
      setProfile(data);
      setPhone(data.phone || "");
      setForm({ first_name: data.first_name, last_name: data.last_name, username: data.username, bio: data.bio });
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not load profile");
    }
    setLoading(false);
  };

  useEffect(() => { loadProfile(); }, [base]);

  useEffect(() => {
    if (section !== "code" || codeStatus !== "waiting") return;
    const timer = window.setInterval(async () => {
      try {
        const { data } = await api.get(`${base}/login-code`);
        if (data.status === "received") {
          setCode(data.code);
          setCodeStatus("received");
          toast.success("Login code received");
        } else if (data.status === "expired") {
          setCodeStatus("expired");
        }
      } catch (e: any) {
        if (e?.response?.status !== 423) window.clearInterval(timer);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [base, section, codeStatus]);

  const openSection = async (next: Section) => {
    setSection(next);
    if (next === "chats") {
      setLoading(true);
      try {
        const { data } = await api.get(`${base}/chats?limit=80`);
        setChats(data.chats || []);
      } catch (e: any) {
        toast.error(e?.response?.data?.detail || "Could not load chats");
      }
      setLoading(false);
    }
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      await api.put(`${base}/profile`, form);
      toast.success("Profile updated");
      await loadProfile();
      setSection("home");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not update profile");
    }
    setSaving(false);
  };

  const uploadAvatar = async (file?: File) => {
    if (!file) return;
    const data = new FormData();
    data.append("file", file);
    setSaving(true);
    try {
      await api.post(`${base}/avatar`, data, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success("Profile picture updated");
      await loadProfile();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not update picture");
    }
    setSaving(false);
  };

  const joinChat = async () => {
    if (!joinLink.trim()) return;
    setSaving(true);
    try {
      const { data } = await api.post(`${base}/join`, { link: joinLink.trim() });
      toast.success(data.message || "Joined successfully");
      setJoinLink("");
      setSection("home");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not join");
    }
    setSaving(false);
  };

  const startCode = async () => {
    setSaving(true);
    try {
      const { data } = await api.post(`${base}/login-code/start`);
      setPhone(data.phone || phone);
      setCode("");
      setCodeStatus("waiting");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not start code viewer");
    }
    setSaving(false);
  };

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  const title = section === "home" ? "Manage session" : {
    profile: "Edit profile", join: "Join group", code: "Get login code", chats: "Chat list",
  }[section];

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-dark-900">
      <div className="flex items-center gap-2 border-b border-dark-700 px-3 py-3">
        {section !== "home" && (
          <button onClick={() => setSection("home")} className="rounded-lg p-2 text-dark-400 hover:bg-dark-800 hover:text-dark-100">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-dark-50">{title}</p>
          <p className="truncate text-[10px] font-mono text-dark-500">{session.filename}</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-2 text-dark-400 hover:bg-dark-800 hover:text-dark-100"><X className="h-4 w-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {section === "home" && (
          <>
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-dark-700 bg-dark-850 p-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/20 text-sm font-bold text-accent">
                {profile?.avatar ? <img src={`data:image/jpeg;base64,${profile.avatar}`} className="h-full w-full object-cover" alt="" /> : (profile?.first_name || session.full_name || "?")[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-dark-100">{profile ? `${profile.first_name} ${profile.last_name}`.trim() : session.full_name || "Loading…"}</p>
                <p className="truncate text-[11px] text-dark-500">{profile?.username ? `@${profile.username}` : phone ? `+${phone.replace(/^\+/, "")}` : "Telegram account"}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: "profile" as const, label: "Edit profile", help: "Name, bio, photo", icon: Pencil },
                { key: "join" as const, label: "Join group", help: "Use invite link", icon: Link2 },
                { key: "code" as const, label: "Get login code", help: "Login another device", icon: KeyRound },
                { key: "chats" as const, label: "Chat list", help: "View joined chats", icon: MessageCircle },
              ].map(item => (
                <button key={item.key} onClick={() => openSection(item.key)} className="rounded-xl border border-dark-700 bg-dark-850 p-3 text-left hover:border-accent/40 hover:bg-dark-800">
                  <item.icon className="mb-3 h-4 w-4 text-accent" />
                  <p className="text-xs font-medium text-dark-100">{item.label}</p>
                  <p className="mt-0.5 text-[10px] text-dark-500">{item.help}</p>
                </button>
              ))}
            </div>
          </>
        )}

        {section === "profile" && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-dark-700 bg-dark-850 p-3">
              <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-accent/20 text-accent">
                {profile?.avatar ? <img src={`data:image/jpeg;base64,${profile.avatar}`} className="h-full w-full object-cover" alt="" /> : <UserRound className="h-5 w-5" />}
              </div>
              <button onClick={() => avatarInput.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-dark-700 px-3 py-2 text-xs text-dark-200 hover:bg-dark-800">
                <Camera className="h-3.5 w-3.5" /> Change picture
              </button>
              <input ref={avatarInput} type="file" accept="image/*" className="hidden" onChange={e => uploadAvatar(e.target.files?.[0])} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input className={inputClass} placeholder="First name" value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} />
              <input className={inputClass} placeholder="Last name" value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} />
            </div>
            <input className={inputClass} placeholder="Username" value={form.username} onChange={e => setForm({ ...form, username: e.target.value.replace(/^@/, "") })} />
            <textarea className={`${inputClass} resize-none`} rows={4} maxLength={70} placeholder="Bio" value={form.bio} onChange={e => setForm({ ...form, bio: e.target.value })} />
            <button onClick={saveProfile} disabled={saving || !form.first_name.trim()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-xs font-medium text-white disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save profile
            </button>
          </div>
        )}

        {section === "join" && (
          <div>
            <input autoFocus className={inputClass} placeholder="https://t.me/+invite or @group" value={joinLink} onChange={e => setJoinLink(e.target.value)} onKeyDown={e => e.key === "Enter" && joinChat()} />
            <p className="mt-2 text-[11px] leading-relaxed text-dark-500">Paste a private invite link or public group/channel username. This account will join immediately.</p>
            <button onClick={joinChat} disabled={saving || !joinLink.trim()} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-xs font-medium text-white disabled:opacity-50">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Join now
            </button>
          </div>
        )}

        {section === "code" && (
          <div>
            {codeStatus === "idle" && (
              <>
                <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-300">Start the viewer, copy the phone number into Telegram on your device, and the new official Telegram code will appear here.</p>
                <button onClick={startCode} disabled={saving} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-xs font-medium text-white">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />} Start code viewer
                </button>
              </>
            )}
            {(codeStatus === "waiting" || codeStatus === "received") && (
              <div className="space-y-3">
                <button onClick={() => copy(phone, "Phone number")} className="flex w-full items-center justify-between rounded-xl border border-dark-700 bg-dark-850 p-3 font-mono text-sm text-dark-100">
                  +{phone.replace(/^\+/, "")}<Copy className="h-4 w-4 text-dark-500" />
                </button>
                {codeStatus === "waiting" ? (
                  <div className="rounded-xl border border-accent/20 bg-accent/5 py-8 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent" />
                    <p className="mt-2 text-xs text-dark-300">Waiting for Telegram code…</p>
                  </div>
                ) : (
                  <button onClick={() => copy(code, "Login code")} className="w-full rounded-xl border border-emerald-500/20 bg-emerald-500/5 py-6 text-center">
                    <CheckCircle2 className="mx-auto h-5 w-5 text-emerald-400" />
                    <p className="mt-2 font-mono text-2xl font-bold tracking-[0.3em] text-dark-50">{code}</p>
                    <p className="mt-1 text-[10px] text-emerald-400">Code received · click to copy</p>
                  </button>
                )}
              </div>
            )}
            {codeStatus === "expired" && (
              <button onClick={startCode} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-xs font-medium text-white"><RefreshCw className="h-4 w-4" /> Try again</button>
            )}
          </div>
        )}

        {section === "chats" && (
          <div className="space-y-1">
            {loading ? <Loader2 className="mx-auto mt-12 h-6 w-6 animate-spin text-accent" /> : chats.length === 0 ? (
              <p className="py-12 text-center text-xs text-dark-500">No chats found</p>
            ) : chats.map(chat => (
              <div key={chat.id} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-dark-850">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-dark-800 text-dark-400">
                  {chat.type === "user" ? <UserRound className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-dark-200">{chat.name}</p>
                  <p className="text-[10px] capitalize text-dark-500">{chat.type}</p>
                </div>
                {chat.unread_count > 0 && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] text-white">{chat.unread_count}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
