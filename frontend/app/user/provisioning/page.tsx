"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import portalApi, { setPortalSession } from "@/lib/portal-api";
import {
  Send, Bell, Check, Clock, Server, Lock, RefreshCw, Loader2,
  Crown, Mail, AtSign, Hash, ShieldCheck, MessageCircle, ChevronRight, FileText,
} from "lucide-react";

const TELEGRAM_SUPPORT_URL = "https://t.me/hqadz_support";
const TELEGRAM_CHANNEL_URL = "https://t.me/hqadz";

interface ProvData {
  provisioning?: boolean; queued?: boolean; creation_step?: string; bot_name?: string;
  order_id?: string; plan_name?: string; plan_mode?: string; amount_usd?: number;
  duration_days?: number; created_at?: string; paid_at?: string; pay_source?: string;
  pay_currency?: string; ref_email?: string; ref_username?: string; notify_telegram_id?: number;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch { return "—"; }
}

export default function ProvisioningPage() {
  const router = useRouter();
  const [data, setData] = useState<ProvData>({});
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeRef = useRef<string>("");

  // contact form
  const [email, setEmail] = useState("");
  const [tgUser, setTgUser] = useState("");
  const [tgId, setTgId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const poll = useCallback(async (code: string) => {
    try {
      const { data: d } = await portalApi.post("/api/portal/unified-login", { code });
      if (d.role === "user" && !d.provisioning) {
        setPortalSession({
          access_token: d.access_token, refresh_token: d.refresh_token,
          bot_name: d.bot_name, telegram_id: d.telegram_id,
        });
        try { localStorage.removeItem("portal_provisioning"); } catch {}
        if (pollRef.current) clearInterval(pollRef.current);
        router.replace("/user/dashboard");
        return;
      }
      setData(d);
    } catch { /* keep waiting */ }
  }, [router]);

  useEffect(() => {
    let code = "";
    try {
      const raw = localStorage.getItem("portal_provisioning");
      if (raw) { const p = JSON.parse(raw); code = p.code || ""; }
    } catch { /* ignore */ }
    if (!code) { router.replace("/login"); return; }
    codeRef.current = code;
    poll(code);
    pollRef.current = setInterval(() => poll(code), 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [router, poll]);

  // hydrate contact fields once data arrives (don't clobber active typing)
  useEffect(() => {
    if (data.ref_email && !email) setEmail(data.ref_email);
    if (data.ref_username && !tgUser) setTgUser(data.ref_username);
    if (data.notify_telegram_id && !tgId) setTgId(String(data.notify_telegram_id));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const manualRefresh = async () => {
    setRefreshing(true);
    await poll(codeRef.current);
    setTimeout(() => setRefreshing(false), 600);
  };

  const saveDetails = async () => {
    if (!data.order_id) return;
    setSaving(true);
    try {
      await portalApi.post(`/api/portal/purchase/${data.order_id}/contact`, {
        email: email.trim() || null,
        telegram_username: tgUser.trim() || null,
        telegram_id: tgId.trim() ? Number(tgId.trim()) : null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch { /* silent */ }
    setSaving(false);
  };

  const queued = !!data.queued;
  const period = (data.duration_days || 0) >= 30 ? "month" : "week";
  const planName = data.plan_name || "AdBot Plan";
  const steps = [
    { label: "Payment Confirmed", icon: Check, state: "done" },
    { label: "Resources Reserved", icon: Server, state: "done" },
    { label: "Preparing AdBot", icon: RefreshCw, state: "active" },
    { label: "Access Ready", icon: Lock, state: "todo" },
  ];

  const fieldCls = "w-full rounded-xl border border-[#1c2333] bg-[#070b14] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5a6377] outline-none focus:border-[#3BA8FF]/50 transition-colors";

  return (
    <div className="min-h-screen bg-[#070b14] font-sans text-white">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-[#1c2333] bg-[#070b14]/90 backdrop-blur">
        <div className="mx-auto max-w-[1280px] px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#3BA8FF]/12">
              <Send className="h-5 w-5 text-[#3BA8FF]" />
            </span>
            <span className="text-[18px] font-semibold tracking-tight">AdBot</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/[0.04] transition-colors">
              <Bell className="h-[18px] w-[18px] text-[#8b94a8]" />
            </span>
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#3BA8FF] text-[13px] font-semibold">U</span>
              <span className="text-[14px] text-[#c9d1e0] hidden sm:block">User</span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-5 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-5 items-start">

          {/* ─── LEFT: Plan + Order ─── */}
          <div className="space-y-5 pf-fade-up">
            {/* Plan Details */}
            <section className="rounded-2xl border border-[#1c2333] bg-[#0a0f1c] overflow-hidden">
              <div className="px-5 py-4 border-b border-[#1c2333]">
                <h2 className="text-[15px] font-semibold">Plan Details</h2>
              </div>
              <div className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Crown className="h-5 w-5 text-[#F5B638]" />
                    <span className="text-[18px] font-semibold">{planName}</span>
                  </div>
                  <span className="text-[11px] font-semibold text-[#3BA8FF] bg-[#3BA8FF]/10 px-2.5 py-1 rounded-full">
                    {queued ? "Reserved" : "Active"}
                  </span>
                </div>
                <p className="mt-3 text-[26px] font-bold">
                  ${(data.amount_usd || 0).toFixed(0)}
                  <span className="text-[14px] font-medium text-[#8b94a8]"> / {period}</span>
                </p>

                <div className="mt-5 space-y-px">
                  <PlanRow icon={Clock} label="Validity" value={data.duration_days ? `${data.duration_days} Days` : "—"} />
                  <PlanRow icon={ShieldCheck} label="Plan Tier" value={data.plan_mode ? cap(data.plan_mode) : "Standard"} />
                  <PlanRow icon={Send} label="Bot Name" value={data.bot_name || "—"} />
                  <PlanRow icon={Crown} label="Support" value="Priority" />
                </div>
              </div>
            </section>

            {/* Order Information */}
            <section className="rounded-2xl border border-[#1c2333] bg-[#0a0f1c] overflow-hidden">
              <div className="px-5 py-4 border-b border-[#1c2333]">
                <h2 className="text-[15px] font-semibold">Order Information</h2>
              </div>
              <div className="p-5 space-y-3.5">
                <InfoRow label="Order ID" value={data.order_id ? `#${data.order_id}` : "—"} mono />
                <InfoRow label="Order Date" value={fmtDate(data.created_at)} />
                <InfoRow label="Payment" value={data.pay_source ? cap(data.pay_source) : "Crypto"} />
                <InfoRow label="Amount" value={`$${(data.amount_usd || 0).toFixed(2)}`} />
              </div>
              <div className="px-5 pb-5">
                <button className="w-full flex items-center justify-between rounded-xl border border-[#1c2333] bg-[#0d1322] px-4 py-3 text-[13px] font-medium text-[#c9d1e0] hover:border-[#3BA8FF]/40 transition-colors">
                  <span className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#8b94a8]" /> View Invoices</span>
                  <ChevronRight className="h-4 w-4 text-[#5a6377]" />
                </button>
              </div>
            </section>
          </div>

          {/* ─── MIDDLE: Status ─── */}
          <div className="space-y-5 pf-fade-up" style={{ animationDelay: "80ms" }}>
            <section className="rounded-2xl border border-[#1c2333] bg-[#0a0f1c] p-7 text-center">
              <div className="flex justify-center mb-5">
                <div className="provision-ring">
                  <div className="provision-ring-spin" />
                  <Send className="provision-ring-icon h-6 w-6 text-[#3BA8FF]" />
                </div>
              </div>
              <h1 className="text-[26px] font-semibold tracking-tight">
                {queued ? "Your AdBot is reserved" : "Your AdBot is being created"}
              </h1>
              <p className="mt-2 text-[14px] text-[#8b94a8] max-w-[420px] mx-auto leading-relaxed">
                {queued
                  ? "We'll create your AdBot automatically when resources become available."
                  : "Your AdBot is being set up. We'll take you to your dashboard the moment it's ready."}
              </p>

              {/* Current status */}
              <div className="mt-6 rounded-2xl border border-[#1c2333] bg-[#070b14] p-5 text-left">
                <p className="text-[11px] uppercase tracking-wider text-[#5a6377] mb-2.5">Current Status</p>
                <div className="flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#3BA8FF] active-dot" />
                  <span className="text-[15px] font-medium text-white">
                    {data.creation_step || (queued ? "Waiting for available resources" : "Preparing your AdBot")}
                  </span>
                </div>
                <p className="text-[12px] text-[#5a6377] mt-1.5 pl-5">No action required from you.</p>
              </div>

              {/* Step timeline (horizontal) */}
              <div className="mt-4 rounded-2xl border border-[#1c2333] bg-[#070b14] p-5">
                <div className="flex items-start justify-between gap-2">
                  {steps.map((s, i) => (
                    <div key={s.label} className="relative flex-1 flex flex-col items-center text-center">
                      {i < steps.length - 1 && (
                        <span className={`absolute top-5 left-1/2 w-full h-px ${s.state === "done" ? "bg-[#22C55E]/40" : "bg-[#1c2333]"}`} />
                      )}
                      <span className={`relative z-10 flex h-10 w-10 items-center justify-center rounded-full border ${
                        s.state === "done" ? "bg-[#22C55E]/12 border-[#22C55E]/50 text-[#22C55E]"
                          : s.state === "active" ? "bg-[#3BA8FF]/12 border-[#3BA8FF] text-[#3BA8FF] pulsing-step"
                          : "bg-[#0a0f1c] border-[#2a3346] text-[#5a6377]"}`}>
                        <s.icon className={`h-[18px] w-[18px] ${s.state === "active" ? "animate-spin" : ""}`} style={s.state === "active" ? { animationDuration: "2.5s" } : undefined} />
                      </span>
                      <span className={`mt-2.5 text-[12px] font-medium leading-tight ${s.state === "todo" ? "text-[#5a6377]" : "text-white"}`}>
                        {s.label}
                      </span>
                      {s.state === "done" && <Check className="h-3.5 w-3.5 text-[#22C55E] mt-1" strokeWidth={3} />}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Estimate + notify */}
            <section className="rounded-2xl border border-[#1c2333] bg-[#0a0f1c] p-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3.5 sm:pr-4 sm:border-r border-[#1c2333]">
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[#3BA8FF]/12">
                    <Clock className="h-5 w-5 text-[#3BA8FF]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <p className="text-[12px] text-[#8b94a8]">Estimated Time</p>
                    <p className="text-[16px] font-semibold leading-tight mt-0.5">10–60 min</p>
                  </div>
                </div>
                <div className="flex items-center gap-3.5">
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[#3BA8FF]/12">
                    <Bell className="h-5 w-5 text-[#3BA8FF]" strokeWidth={1.75} />
                  </span>
                  <div>
                    <p className="text-[12px] text-[#8b94a8]">You&apos;ll be notified</p>
                    <p className="text-[16px] font-semibold leading-tight mt-0.5">automatically</p>
                  </div>
                </div>
              </div>
            </section>

            <button onClick={manualRefresh} disabled={refreshing}
              className="w-full inline-flex items-center justify-center gap-2.5 text-[15px] font-semibold text-white h-13 py-3.5 rounded-2xl transition-all active:scale-[0.99] hover:shadow-[0_8px_30px_rgba(59,168,255,0.35)] disabled:opacity-70"
              style={{ background: "linear-gradient(135deg, #3BA8FF 0%, #2B7FE0 100%)" }}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh Status
            </button>

            <p className="text-center text-[12.5px] text-[#5a6377]">
              You can close this page — we&apos;ll notify you when it&apos;s ready.
            </p>
          </div>

          {/* ─── RIGHT: Important Details + Help ─── */}
          <div className="space-y-5 pf-fade-up" style={{ animationDelay: "160ms" }}>
            <section className="rounded-2xl border border-[#1c2333] bg-[#0a0f1c] overflow-hidden">
              <div className="px-5 py-4 border-b border-[#1c2333]">
                <h2 className="text-[15px] font-semibold">Important Details</h2>
              </div>
              <div className="p-5">
                <p className="text-[13px] text-[#8b94a8] leading-relaxed">
                  Add your contact so we can notify you the moment your AdBot is ready.
                </p>

                <div className="mt-4 space-y-4">
                  <div>
                    <label className="text-[12px] font-medium text-[#c9d1e0] block mb-1.5">Email Address</label>
                    <div className="relative">
                      <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@example.com" className={fieldCls + " pr-9"} />
                      <Mail className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5a6377]" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[12px] font-medium text-[#c9d1e0] block mb-1.5">Telegram Username</label>
                    <div className="relative">
                      <input value={tgUser} onChange={e => setTgUser(e.target.value)} placeholder="@username" className={fieldCls + " pr-9"} />
                      <AtSign className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5a6377]" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[12px] font-medium text-[#c9d1e0] block mb-1.5">Telegram User ID</label>
                    <div className="relative">
                      <input value={tgId} onChange={e => setTgId(e.target.value)} inputMode="numeric" placeholder="123456789" className={fieldCls + " pr-9"} />
                      <Hash className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5a6377]" />
                    </div>
                  </div>
                </div>

                <button onClick={saveDetails} disabled={saving || !data.order_id}
                  className="mt-5 w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-white h-11 rounded-xl transition-all active:scale-[0.99] disabled:opacity-60"
                  style={{ background: saved ? "#22C55E" : "linear-gradient(135deg, #3BA8FF 0%, #2B7FE0 100%)" }}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
                  {saved ? "Saved" : "Save Details"}
                </button>

                <p className="mt-3 flex items-center justify-center gap-1.5 text-[11.5px] text-[#5a6377]">
                  <Lock className="h-3 w-3" /> Your information is secure and private.
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-[#1c2333] bg-[#0a0f1c] overflow-hidden">
              <div className="px-5 py-4 border-b border-[#1c2333]">
                <h2 className="text-[15px] font-semibold">Need Help?</h2>
              </div>
              <div className="p-5">
                <p className="text-[13px] text-[#8b94a8] leading-relaxed">
                  Our support team is here if you have questions.
                </p>
                <div className="mt-4 space-y-2.5">
                  <a href={TELEGRAM_CHANNEL_URL} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-xl border border-[#1c2333] bg-[#0d1322] px-4 py-3 text-[13px] font-medium text-[#c9d1e0] hover:border-[#3BA8FF]/40 transition-colors">
                    <span className="flex items-center gap-2.5"><Send className="h-4 w-4 text-[#3BA8FF]" /> Join Telegram Channel</span>
                    <ChevronRight className="h-4 w-4 text-[#5a6377]" />
                  </a>
                  <a href={TELEGRAM_SUPPORT_URL} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-xl border border-[#1c2333] bg-[#0d1322] px-4 py-3 text-[13px] font-medium text-[#c9d1e0] hover:border-[#3BA8FF]/40 transition-colors">
                    <span className="flex items-center gap-2.5"><MessageCircle className="h-4 w-4 text-[#3BA8FF]" /> Contact Support</span>
                    <ChevronRight className="h-4 w-4 text-[#5a6377]" />
                  </a>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>

      <style jsx global>{`
        .provision-ring { position: relative; width: 72px; height: 72px; border-radius: 9999px;
          display: flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at center, rgba(59,168,255,0.10), transparent 70%);
          animation: ring-halo 2s ease-in-out infinite; }
        .provision-ring-spin { position: absolute; inset: 0; border-radius: 9999px;
          border: 2px solid rgba(59,168,255,0.15); border-top-color: #3BA8FF; border-right-color: rgba(59,168,255,0.55);
          animation: ring-spin 6s linear infinite; }
        .provision-ring-icon { position: relative; z-index: 1; }
        @keyframes ring-spin { to { transform: rotate(360deg); } }
        @keyframes ring-halo { 0%, 100% { box-shadow: 0 0 0 0 rgba(59,168,255,0.0); } 50% { box-shadow: 0 0 24px 2px rgba(59,168,255,0.22); } }
        @keyframes active-dot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } }
        .active-dot { animation: active-dot-pulse 1.6s ease-in-out infinite; }
        @keyframes step-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(59,168,255,0.6); } 50% { box-shadow: 0 0 0 6px rgba(59,168,255,0); } }
        .pulsing-step { animation: step-pulse 2s ease-in-out infinite; }
        @keyframes pf-fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .pf-fade-up { animation: pf-fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
        .h-13 { height: 3.25rem; }
      `}</style>
    </div>
  );
}

function cap(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function PlanRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-[#1c2333] last:border-0">
      <span className="flex items-center gap-2.5 text-[13px] text-[#8b94a8]">
        <Icon className="h-4 w-4 text-[#5a6377]" /> {label}
      </span>
      <span className="text-[13px] font-medium text-white">{value}</span>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-[#8b94a8]">{label}</span>
      <span className={`text-[13px] font-medium text-white ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
