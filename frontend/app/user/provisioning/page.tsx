"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import portalApi, { setPortalSession } from "@/lib/portal-api";
import BrandMark from "@/components/BrandMark";
import {
  Send, Bell, Check, Clock, Server, Lock, RefreshCw, Loader2,
  Mail, AtSign, Hash, MessageCircle, ChevronRight, X as XIcon,
} from "lucide-react";

const TG = "#2AABEE";
const TELEGRAM_SUPPORT_URL = "https://t.me/hqadz_support";
const TELEGRAM_CHANNEL_URL = "https://t.me/hqadz";

/* Per-tier reach — mirrors the landing pricing page so the provisioning card
   shows the exact same numbers the buyer chose. */
const PLAN_META: Record<string, { reach: string }> = {
  bronze:  { reach: "~15K" },
  silver:  { reach: "~30K" },
  gold:    { reach: "~50K" },
  diamond: { reach: "~90K" },
  basic:   { reach: "~120K" },
  pro:     { reach: "~300K" },
  elite:   { reach: "~600K" },
};

/* Tier → account / replacement counts (mirrors data/plans.json). Lets the page
   show full plan details from the saved checkout even before the API echoes
   them back. */
const ACCOUNTS_BY_TIER: Record<string, number> = { bronze: 2, silver: 4, gold: 6, diamond: 10, basic: 5, pro: 12, elite: 20 };
const REPL_BY_TIER: Record<string, number> = { bronze: 1, silver: 2, gold: 3, diamond: 4, basic: 2, pro: 4, elite: -1 };

interface ProvData {
  provisioning?: boolean; queued?: boolean; creation_step?: string; bot_name?: string;
  order_id?: string; plan_id?: string; plan_name?: string; plan_mode?: string; accounts?: number;
  free_replacements?: number; billing?: string;
  amount_usd?: number; duration_days?: number; created_at?: string; paid_at?: string; pay_source?: string;
  pay_currency?: string; ref_name?: string; ref_email?: string; ref_username?: string; notify_telegram_id?: number;
}

function fmtDate(iso?: string) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch { return ""; }
}

export default function ProvisioningPage() {
  const router = useRouter();
  const [data, setData] = useState<ProvData>({});
  const [loaded, setLoaded] = useState(false);
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
      // Merge backend fields over the seeded purchase data — only override with
      // non-empty values so old API responses don't blank out known details.
      setData(prev => {
        const merged: ProvData = { ...prev };
        (Object.keys(d) as (keyof ProvData)[]).forEach((k) => {
          const v = d[k];
          if (v !== undefined && v !== null && v !== "" && v !== 0) (merged as any)[k] = v;
        });
        // these flags should always reflect the latest poll
        merged.provisioning = d.provisioning;
        merged.queued = d.queued;
        merged.creation_step = d.creation_step ?? prev.creation_step;
        return merged;
      });
      setLoaded(true);
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

    // Seed plan/order details from the purchase the user just completed (saved by
    // the checkout flow). This makes the page show real data immediately, even
    // before the API echoes it back.
    try {
      const raw = localStorage.getItem("hqadz_pending_purchase");
      if (raw) {
        const { order, plan } = JSON.parse(raw) || {};
        const seed: ProvData = {};
        const tier = (plan?.id || order?.plan_id || "").toLowerCase();
        if (plan?.label || order?.plan_name) seed.plan_name = `${plan?.label || order?.plan_name} Plan`.replace(/\s*Plan\s*Plan$/i, " Plan");
        if (tier) seed.plan_id = tier;
        if (tier && ACCOUNTS_BY_TIER[tier]) seed.accounts = ACCOUNTS_BY_TIER[tier];
        if (tier && tier in REPL_BY_TIER) seed.free_replacements = REPL_BY_TIER[tier];
        if (order?.amount_usd ?? plan?.price) seed.amount_usd = Number(order?.amount_usd ?? plan?.price) || 0;
        if (plan?.durationDays) seed.duration_days = Number(plan.durationDays) || 0;
        if (plan?.billing) seed.billing = plan.billing;
        if (plan?.mode) seed.plan_mode = plan.mode;
        if (order?.order_id) seed.order_id = order.order_id;
        if (order?.pay_currency) seed.pay_currency = order.pay_currency;
        if (typeof order?.queued === "boolean") seed.queued = order.queued;
        if (Object.keys(seed).length) { setData(seed); setLoaded(true); }
      }
    } catch { /* ignore */ }

    poll(code);
    pollRef.current = setInterval(() => poll(code), 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [router, poll]);

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
  const hasOrder = !!data.order_id;
  const billing = data.billing || ((data.duration_days || 0) >= 30 ? "month" : "week");
  const interval = billing === "month" ? "Monthly" : billing === "week" ? "Weekly" : "—";
  const period = billing === "month" ? "month" : "week";
  const userName = (data.ref_name || "").trim();
  const initial = (userName || "U").charAt(0).toUpperCase();

  // Derived plan features — matches the landing pricing card. We resolve the tier
  // from plan_id/plan_name (the API returns these straight from the order) and
  // derive counts from the tier so the card fills in even if the server-side
  // plan lookup didn't populate accounts/replacements.
  const planId = (data.plan_id || data.plan_name || "").toLowerCase().split(/\s+/)[0];
  const accounts = data.accounts || ACCOUNTS_BY_TIER[planId] || 0;
  // Prefer the API value (incl. -1 = unlimited); fall back to the tier map when it's missing/0.
  const repl = data.free_replacements && data.free_replacements !== 0
    ? data.free_replacements
    : (planId in REPL_BY_TIER ? REPL_BY_TIER[planId] : 0);
  const meta = PLAN_META[planId];
  // Capacity model: 100 target groups, where 2 accounts cover all 100 every hour
  // (50 groups/account/hour). Over a full day that's accounts × 50 × 24 = accounts × 1,200.
  const dayPosts = accounts ? (accounts * 1200).toLocaleString() : "—";
  const reach = meta?.reach || "—";
  const replText = repl === -1 ? "Unlimited replacements" : `${repl ?? 0} free replacement${repl === 1 ? "" : "s"}`;
  const hasPriority = /gold|diamond/.test(planId) || (data.plan_mode || "").toLowerCase() === "enterprise";
  const features: { text: string; ok: boolean }[] = [
    { text: `${accounts} bots posting for you`, ok: true },
    { text: `${dayPosts} posts / day`, ok: true },
    { text: replText, ok: true },
    { text: "Priority support", ok: hasPriority },
    { text: "Real-time delivery tracking", ok: true },
    { text: "20+ crypto coins accepted", ok: true },
  ];
  const steps = [
    { label: "Payment Confirmed", icon: Check, state: "done" },
    { label: "Resources Reserved", icon: Server, state: "done" },
    { label: "Preparing AdBot", icon: RefreshCw, state: "active" },
    { label: "Access Ready", icon: Lock, state: "todo" },
  ];

  const card = "rounded-lg border border-[#1f1f22] bg-[#0e0e10]";
  const fieldCls = "w-full rounded-md border border-[#1f1f22] bg-[#16161a] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors";
  // muted skeleton bar while the first poll resolves
  const Skel = ({ w = "3rem" }: { w?: string }) => (
    <span className="inline-block h-3.5 rounded bg-[#1f1f22] animate-pulse align-middle" style={{ width: w }} />
  );

  return (
    <div className="min-h-screen bg-[#0a0a0a] font-sans text-white">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-[#1f1f22] bg-[#0a0a0a]/90 backdrop-blur">
        <div className="mx-auto max-w-[1280px] px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandMark height={32} />
          </div>
          <div className="flex items-center gap-4">
            <Bell className="h-[18px] w-[18px] text-[#8b8b93]" />
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full text-[13px] font-semibold text-white" style={{ background: TG }}>{initial}</span>
              {userName
                ? <span className="text-[14px] text-[#c9c9cf] hidden sm:block max-w-[160px] truncate">{userName}</span>
                : <span className="inline-block h-3.5 w-16 rounded bg-[#1f1f22] animate-pulse hidden sm:block" />}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-5 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px] gap-5 items-start">

          {/* ─── LEFT: Plan + Order ─── */}
          <div className="space-y-5">
            {/* Plan Details */}
            <section className={card + " overflow-hidden"}>
              <div className="px-5 py-4 border-b border-[#1f1f22]">
                <h2 className="text-[15px] font-semibold">Plan Details</h2>
              </div>
              <div className="p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[18px] font-semibold">{loaded ? (data.plan_name || "AdBot Plan") : <Skel w="6rem" />}</span>
                  <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full" style={{ color: TG, background: "rgba(42,171,238,0.12)" }}>
                    {queued ? "Reserved" : "Active"}
                  </span>
                </div>
                {loaded && (data.amount_usd || 0) > 0 ? (
                  <>
                    <p className="mt-3 text-[26px] font-bold">
                      ${(data.amount_usd || 0).toFixed(0)}
                      <span className="text-[14px] font-medium text-[#8b8b93]"> / {period}</span>
                    </p>
                    <p className="text-[12px] text-[#5d5d66] mt-0.5">Billed {period === "month" ? "monthly" : "weekly"}</p>
                  </>
                ) : !loaded ? (
                  <p className="mt-3"><Skel w="5rem" /></p>
                ) : null}

                {/* Reach per day */}
                <div className="mt-5 flex items-center justify-between border-t border-[#1f1f22] pt-4">
                  <span className="text-[10px] uppercase tracking-wider text-[#5d5d66]">Reach per day</span>
                  {loaded ? <span className="text-[18px] font-semibold text-white tracking-tight">{reach}</span> : <Skel w="3rem" />}
                </div>

                {/* Feature checklist — mirrors the landing pricing card */}
                <ul className="mt-4 space-y-2.5">
                  {loaded ? features.map((f, i) => (
                    <li key={i} className="flex items-center gap-2.5">
                      <span className="grid place-content-center w-4 h-4 rounded-full flex-shrink-0"
                        style={{ background: f.ok ? "rgba(42,171,238,0.14)" : "rgba(255,255,255,0.05)" }}>
                        {f.ok
                          ? <Check className="w-2.5 h-2.5" style={{ color: TG }} strokeWidth={3} />
                          : <XIcon className="w-2.5 h-2.5 text-[#5d5d66]" strokeWidth={3} />}
                      </span>
                      <span className={`text-[12px] ${f.ok ? "text-[#c9c9cf]" : "text-[#5d5d66] line-through"}`}>{f.text}</span>
                    </li>
                  )) : [0,1,2,3,4,5].map(i => (
                    <li key={i} className="flex items-center gap-2.5">
                      <span className="w-4 h-4 rounded-full bg-[#1f1f22] animate-pulse flex-shrink-0" />
                      <span className="h-3 w-32 rounded bg-[#1f1f22] animate-pulse" />
                    </li>
                  ))}
                </ul>

                {/* Interval + validity */}
                <div className="mt-5 grid grid-cols-2 gap-3 border-t border-[#1f1f22] pt-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#5d5d66]">Interval</p>
                    {loaded ? <p className="text-[13px] font-medium text-white mt-0.5">{interval}</p> : <p className="mt-1"><Skel w="3rem" /></p>}
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-[#5d5d66]">Validity</p>
                    {loaded ? <p className="text-[13px] font-medium text-white mt-0.5">{data.duration_days ? `${data.duration_days} Days` : "—"}</p> : <p className="mt-1"><Skel w="3rem" /></p>}
                  </div>
                </div>
              </div>
            </section>

            {/* Order Information */}
            <section className={card + " overflow-hidden"}>
              <div className="px-5 py-4 border-b border-[#1f1f22]">
                <h2 className="text-[15px] font-semibold">Order Information</h2>
              </div>
              <div className="p-5">
                <div className="rounded-md bg-[#16161a] border border-[#1f1f22] divide-y divide-[#1f1f22] px-4">
                  <InfoRow label="Order ID" value={loaded ? (data.order_id ? `#${data.order_id}` : "—") : null} mono />
                  <InfoRow label="Order Date" value={loaded ? (fmtDate(data.created_at) || "—") : null} />
                  <InfoRow label="Amount" value={loaded ? `$${(data.amount_usd || 0).toFixed(2)}` : null} />
                </div>
              </div>
            </section>
          </div>

          {/* ─── MIDDLE: Status ─── */}
          <div className="space-y-5">
            <section className={card + " p-7 text-center"}>
              <div className="flex justify-center mb-5">
                <div className="provision-ring">
                  <div className="provision-ring-spin" />
                  <Send className="provision-ring-icon h-6 w-6" style={{ color: TG }} />
                </div>
              </div>
              <h1 className="text-[26px] font-semibold tracking-tight">
                {queued ? "Your AdBot is reserved" : "Your AdBot is being created"}
              </h1>
              <p className="mt-2 text-[14px] text-[#8b8b93] max-w-[420px] mx-auto leading-relaxed">
                {queued
                  ? "We'll create your AdBot automatically when resources become available."
                  : "Your AdBot is being set up. We'll take you to your dashboard the moment it's ready."}
              </p>

              {/* Current status */}
              <div className="mt-6 rounded-md border border-[#1f1f22] bg-[#16161a] p-5 text-left">
                <p className="text-[11px] uppercase tracking-wider text-[#5d5d66] mb-2.5">Current Status</p>
                <div className="flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full active-dot" style={{ background: TG }} />
                  <span className="text-[15px] font-medium text-white">
                    {data.creation_step || (queued ? "Waiting for available resources" : "Preparing your AdBot")}
                  </span>
                </div>
                <p className="text-[12px] text-[#5d5d66] mt-1.5 pl-5">No action required from you.</p>
              </div>

              {/* Step timeline (horizontal) */}
              <div className="mt-4 rounded-md border border-[#1f1f22] bg-[#16161a] p-5">
                <div className="flex items-start justify-between gap-2">
                  {steps.map((s, i) => (
                    <div key={s.label} className="relative flex-1 flex flex-col items-center text-center">
                      {i < steps.length - 1 && (
                        <span className={`absolute top-5 left-1/2 w-full h-px ${s.state === "done" ? "bg-[#2AABEE]/40" : "bg-[#1f1f22]"}`} />
                      )}
                      <span className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border"
                        style={
                          s.state === "done" ? { background: "rgba(42,171,238,0.12)", borderColor: "rgba(42,171,238,0.5)", color: TG }
                          : s.state === "active" ? { background: "rgba(42,171,238,0.12)", borderColor: TG, color: TG }
                          : { background: "#0e0e10", borderColor: "#3d3d44", color: "#5d5d66" }}>
                        <s.icon className={`h-[18px] w-[18px] ${s.state === "active" ? "animate-spin" : ""}`} style={s.state === "active" ? { animationDuration: "2.5s" } : undefined} />
                      </span>
                      <span className={`mt-2.5 text-[12px] font-medium leading-tight ${s.state === "todo" ? "text-[#5d5d66]" : "text-white"}`}>
                        {s.label}
                      </span>
                      {s.state === "done" && <Check className="h-3.5 w-3.5 mt-1" strokeWidth={3} style={{ color: TG }} />}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Estimate + notify */}
            <section className={card + " p-5"}>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3.5 sm:pr-4 sm:border-r border-[#1f1f22]">
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(42,171,238,0.12)" }}>
                    <Clock className="h-5 w-5" style={{ color: TG }} strokeWidth={1.75} />
                  </span>
                  <div>
                    <p className="text-[12px] text-[#8b8b93]">Estimated Time</p>
                    <p className="text-[16px] font-semibold leading-tight mt-0.5">10 min – 12 hrs</p>
                  </div>
                </div>
                <div className="flex items-center gap-3.5">
                  <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(42,171,238,0.12)" }}>
                    <Bell className="h-5 w-5" style={{ color: TG }} strokeWidth={1.75} />
                  </span>
                  <div>
                    <p className="text-[12px] text-[#8b8b93]">You&apos;ll be notified</p>
                    <p className="text-[16px] font-semibold leading-tight mt-0.5">automatically</p>
                  </div>
                </div>
              </div>
            </section>

            <button onClick={manualRefresh} disabled={refreshing}
              className="w-full inline-flex items-center justify-center gap-2.5 text-[15px] font-semibold text-white py-3.5 rounded-lg transition-opacity hover:opacity-90 active:scale-[0.99] disabled:opacity-70"
              style={{ background: TG }}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh Status
            </button>

            <p className="text-center text-[12.5px] text-[#5d5d66]">
              You can close this page — we&apos;ll notify you when it&apos;s ready.
            </p>
          </div>

          {/* ─── RIGHT: Important Details + Help ─── */}
          <div className="space-y-5">
            <section className={card + " overflow-hidden"}>
              <div className="px-5 py-4 border-b border-[#1f1f22]">
                <h2 className="text-[15px] font-semibold">Important Details</h2>
              </div>
              <div className="p-5">
                <p className="text-[13px] text-[#8b8b93] leading-relaxed">
                  Help us know you better so we can reach you easily and notify you the moment your AdBot is ready.
                </p>

                <div className="mt-4 space-y-4">
                  <div>
                    <label className="text-[12px] font-medium text-[#c9c9cf] block mb-1.5">Email Address</label>
                    <div className="relative">
                      <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="you@example.com" className={fieldCls + " pr-9"} />
                      <Mail className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5d5d66]" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[12px] font-medium text-[#c9c9cf] block mb-1.5">Telegram Username</label>
                    <div className="relative">
                      <input value={tgUser} onChange={e => setTgUser(e.target.value)} placeholder="@username" className={fieldCls + " pr-9"} />
                      <AtSign className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5d5d66]" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[12px] font-medium text-[#c9c9cf] block mb-1.5">Telegram User ID</label>
                    <div className="relative">
                      <input value={tgId} onChange={e => setTgId(e.target.value)} inputMode="numeric" placeholder="123456789" className={fieldCls + " pr-9"} />
                      <Hash className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#5d5d66]" />
                    </div>
                  </div>
                </div>

                <button onClick={saveDetails} disabled={saving || !hasOrder}
                  className="mt-5 w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-white py-2.5 rounded-md transition-opacity hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
                  style={{ background: saved ? "#22C55E" : TG }}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
                  {saved ? "Saved" : "Save Details"}
                </button>

                <p className="mt-3 flex items-center justify-center gap-1.5 text-[11.5px] text-[#5d5d66]">
                  <Lock className="h-3 w-3" /> Your information is secure and private.
                </p>
              </div>
            </section>

            <section className={card + " overflow-hidden"}>
              <div className="px-5 py-4 border-b border-[#1f1f22]">
                <h2 className="text-[15px] font-semibold">Need Help?</h2>
              </div>
              <div className="p-5">
                <p className="text-[13px] text-[#8b8b93] leading-relaxed">
                  Our support team is here if you have questions.
                </p>
                <div className="mt-4 space-y-2.5">
                  <a href={TELEGRAM_CHANNEL_URL} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-md border border-[#1f1f22] bg-[#16161a] px-4 py-3 text-[13px] font-medium text-[#c9c9cf] hover:border-[#3d3d44] transition-colors">
                    <span className="flex items-center gap-2.5"><Send className="h-4 w-4" style={{ color: TG }} /> Join Telegram Channel</span>
                    <ChevronRight className="h-4 w-4 text-[#5d5d66]" />
                  </a>
                  <a href={TELEGRAM_SUPPORT_URL} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-md border border-[#1f1f22] bg-[#16161a] px-4 py-3 text-[13px] font-medium text-[#c9c9cf] hover:border-[#3d3d44] transition-colors">
                    <span className="flex items-center gap-2.5"><MessageCircle className="h-4 w-4" style={{ color: TG }} /> Contact Support</span>
                    <ChevronRight className="h-4 w-4 text-[#5d5d66]" />
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
          background: radial-gradient(circle at center, rgba(42,171,238,0.10), transparent 70%);
          animation: ring-halo 2s ease-in-out infinite; }
        .provision-ring-spin { position: absolute; inset: 0; border-radius: 9999px;
          border: 2px solid rgba(42,171,238,0.15); border-top-color: #2AABEE; border-right-color: rgba(42,171,238,0.55);
          animation: ring-spin 6s linear infinite; }
        .provision-ring-icon { position: relative; z-index: 1; }
        @keyframes ring-spin { to { transform: rotate(360deg); } }
        @keyframes ring-halo { 0%, 100% { box-shadow: 0 0 0 0 rgba(42,171,238,0.0); } 50% { box-shadow: 0 0 24px 2px rgba(42,171,238,0.22); } }
        @keyframes active-dot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } }
        .active-dot { animation: active-dot-pulse 1.6s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

function cap(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function InfoRow({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px] text-[#8b8b93]">{label}</span>
      {value === null
        ? <span className="inline-block h-3.5 w-16 rounded bg-[#1f1f22] animate-pulse" />
        : <span className={`text-[13px] font-medium text-white ${mono ? "font-mono" : ""}`}>{value}</span>}
    </div>
  );
}
