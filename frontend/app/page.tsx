"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import {
  Send, Check, CheckCheck, Menu, X, ArrowRight, Plus,
  User, Building2, Gem, Star, Zap, ShieldCheck,
  Clock, Lock, Users, Activity, Bot, BarChart3, MessageCircle, RotateCw,
  Rocket, Crown,
} from "lucide-react";
import { motion } from "framer-motion";
import axios from "axios";
import PurchaseFlow, { PurchasePlan } from "@/components/portal/PurchaseFlow";
import BrandMark from "@/components/BrandMark";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const TG = "#2AABEE";

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.unobserve(el); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

/* Number that pulses when its value changes */
function Tick({ value, className = "" }: { value: string; className?: string }) {
  return <span key={value} className={`num-pulse tabular-nums inline-block ${className}`}>{value}</span>;
}

/* Fixed-locale number formatting — avoids SSR/client hydration mismatch */
function fmt(n: number) {
  return n.toLocaleString("en-US");
}

/* Compact number: 4800 → 4.8K, 12000 → 12K */
function fmtK(n: number) {
  if (n >= 1000) {
    const k = n / 1000;
    return (Number.isInteger(k) ? k.toString() : k.toFixed(1)) + "K";
  }
  return String(n);
}

/* Count-up that eases to its target whenever the value changes */
function useCountUp(target: number, duration = 550) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function AnimatedPrice({ value, className = "" }: { value: number; className?: string }) {
  const v = useCountUp(value);
  return <span className={`tabular-nums ${className}`}>{v.toLocaleString()}</span>;
}

const GROUPS = [
  { name: "Crypto Signals VIP", members: "12.4K" },
  { name: "NFT Traders Hub", members: "8.9K" },
  { name: "Forex Masters", members: "21.0K" },
  { name: "Airdrop Alerts", members: "15.3K" },
  { name: "DeFi Lounge", members: "6.7K" },
];

const AD_TEXT = "VIP signals — 40% off this week";

/* ─── Hero simulation: ad → bots → groups → results ─── */
function HeroSim() {
  const [tick, setTick] = useState(0);
  const [delivered, setDelivered] = useState(2841);

  useEffect(() => {
    const t = setInterval(() => {
      setTick(x => x + 1);
      setDelivered(d => d + 1);
    }, 1700);
    return () => clearInterval(t);
  }, []);

  const active = tick % GROUPS.length;
  const queued = GROUPS.slice(0, 4).filter((_, i) => !(i < active || active >= 4)).length;

  return (
    <div className="rounded-lg border border-[#1f1f22] bg-[#0e0e10] overflow-hidden select-none">
      {/* status bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1f1f22]">
        <span className="flex items-center gap-2 text-[11px] text-[#8b8b93]">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ background: TG }} />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: TG }} />
          </span>
          Campaign live
        </span>
        <span className="text-[11px] text-[#5d5d66]">Posting bots active</span>
      </div>

      <div className="p-4">
        {/* your ad */}
        <div className="rounded-md bg-[#16161a] border border-[#1f1f22] px-3.5 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[9px] text-[#5d5d66] uppercase tracking-wider mb-1">Your ad</p>
            <p className="text-[12px] text-[#e4e4e7] truncate">{AD_TEXT} → <span style={{ color: TG }}>t.me/you</span></p>
          </div>
          <Send className="w-3.5 h-3.5 flex-shrink-0" style={{ color: TG }} />
        </div>

        {/* flow: ad → bots */}
        <div className="relative h-5 w-px mx-auto bg-[#1f1f22] overflow-hidden">
          <span className="flow-dot absolute left-1/2 -translate-x-1/2 w-1 h-1 rounded-full" style={{ background: TG }} />
        </div>

        {/* bot pool */}
        <div className="rounded-md bg-[#16161a] border border-[#1f1f22] px-3.5 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {[...Array(6)].map((_, i) => (
              <span key={i} className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${i === active % 6 ? "" : "bg-[#2c2c31]"}`} style={i === active % 6 ? { background: TG } : undefined} />
            ))}
          </div>
          <p className="text-[10px] text-[#5d5d66]">6 bots distributing</p>
        </div>

        {/* flow: bots → groups */}
        <div className="relative h-5 w-px mx-auto bg-[#1f1f22] overflow-hidden">
          <span className="flow-dot absolute left-1/2 -translate-x-1/2 w-1 h-1 rounded-full" style={{ background: TG, animationDelay: "0.6s" }} />
        </div>

        {/* groups receiving */}
        <div className="rounded-md bg-[#16161a] border border-[#1f1f22] divide-y divide-[#1f1f22]">
          {GROUPS.slice(0, 4).map((g, i) => {
            const isActive = i === active;
            const done = i < active || active >= 4;
            return (
              <div key={g.name} className={`flex items-center justify-between px-3.5 py-2 transition-colors duration-300 ${isActive ? "bg-[#1a1a1f]" : ""}`}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-5 h-5 rounded-full bg-[#26262b] flex items-center justify-center text-[8px] font-medium text-[#8b8b93] flex-shrink-0">
                    {g.name[0]}
                  </div>
                  <span className={`text-[11px] truncate transition-colors duration-300 ${isActive ? "text-white" : "text-[#8b8b93]"}`}>{g.name}</span>
                  <span className="text-[9px] text-[#5d5d66] flex-shrink-0">{g.members}</span>
                </div>
                {isActive ? (
                  <span key={tick} className="msg-in"><CheckCheck className="w-3.5 h-3.5" style={{ color: TG }} /></span>
                ) : done ? (
                  <CheckCheck className="w-3.5 h-3.5 text-[#3d3d44]" />
                ) : (
                  <span className="text-[9px] text-[#3d3d44]">queued</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* results */}
      <div className="grid grid-cols-3 divide-x divide-[#1f1f22] border-t border-[#1f1f22]">
        {[
          { label: "Delivered", value: fmt(delivered), icon: CheckCheck },
          { label: "Active bots", value: "6", icon: Users },
          { label: "Queued", value: String(queued), icon: Clock },
        ].map((s) => (
          <div key={s.label} className="px-3.5 py-3 text-center">
            <p className="text-[9px] text-[#5d5d66] uppercase tracking-wider mb-1 flex items-center justify-center gap-1">
              <s.icon className="w-2.5 h-2.5" />{s.label}
            </p>
            <Tick value={s.value} className="text-[14px] font-semibold text-white" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Workflow: animated pipeline ─── */
const FLOW_STEPS = [
  { title: "Pick a plan", sub: "Pay in crypto" },
  { title: "Paste your ad", sub: "Text, links, media" },
  { title: "Select targets", sub: "Groups by niche" },
  { title: "Launch", sub: "One click" },
  { title: "Track delivery", sub: "Live ticks" },
];

function Workflow({ visible }: { visible: boolean }) {
  const [activeStep, setActiveStep] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setActiveStep(s => (s + 1) % FLOW_STEPS.length), 2000);
    return () => clearInterval(t);
  }, [visible]);

  return (
    <div>
      {/* desktop: horizontal */}
      <div className="hidden md:block">
        <div className="relative flex justify-between">
          {/* track */}
          <div className="absolute top-[15px] left-[10%] right-[10%] h-px bg-[#1f1f22]">
            <div
              className="h-px transition-all duration-700 ease-out"
              style={{ background: TG, width: `${(activeStep / (FLOW_STEPS.length - 1)) * 100}%` }}
            />
          </div>
          {FLOW_STEPS.map((s, i) => {
            const on = i <= activeStep;
            return (
              <div key={i} className="relative flex flex-col items-center w-1/5">
                <div
                  className={`w-[30px] h-[30px] rounded-full border flex items-center justify-center text-[11px] font-medium transition-all duration-500 bg-[#0a0a0a] z-10 ${
                    on ? "text-white" : "text-[#5d5d66] border-[#1f1f22]"
                  }`}
                  style={on ? { borderColor: TG, color: i === activeStep ? "#fff" : TG, background: i === activeStep ? TG : "#0a0a0a" } : undefined}
                >
                  {i < activeStep ? <Check className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <p className={`mt-3 text-[13px] font-medium transition-colors duration-500 ${on ? "text-white" : "text-[#5d5d66]"}`}>{s.title}</p>
                <p className="text-[11px] text-[#5d5d66] mt-0.5">{s.sub}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* mobile: vertical */}
      <div className="md:hidden space-y-0">
        {FLOW_STEPS.map((s, i) => {
          const on = i <= activeStep;
          return (
            <div key={i} className="flex gap-4">
              <div className="flex flex-col items-center">
                <div
                  className={`w-7 h-7 rounded-full border flex items-center justify-center text-[11px] font-medium transition-all duration-500 flex-shrink-0 ${
                    on ? "text-white" : "text-[#5d5d66] border-[#1f1f22]"
                  }`}
                  style={on ? { borderColor: TG, background: i === activeStep ? TG : "transparent", color: i === activeStep ? "#fff" : TG } : undefined}
                >
                  {i < activeStep ? <Check className="w-3 h-3" /> : i + 1}
                </div>
                {i < FLOW_STEPS.length - 1 && <div className="w-px flex-1 my-1 bg-[#1f1f22]" />}
              </div>
              <div className="pb-6">
                <p className={`text-[14px] font-medium transition-colors duration-500 ${on ? "text-white" : "text-[#5d5d66]"}`}>{s.title}</p>
                <p className="text-[12px] text-[#5d5d66] mt-0.5">{s.sub}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Live campaign monitor ─── */
function SignalBars({ active }: { active: boolean }) {
  const c = active ? TG : "#34d399";
  return (
    <span className="inline-flex items-end gap-[2px] h-3.5" aria-hidden>
      {[5, 8, 11, 14].map((h, i) => (
        <span key={i} className="w-[2px] rounded-sm" style={{ height: h, background: c, opacity: active && i === 3 ? 0.45 : 0.9 }} />
      ))}
    </span>
  );
}

function CampaignMonitor({ visible }: { visible: boolean }) {
  const [sent, setSent] = useState(1204);
  const [delivered, setDelivered] = useState(1189);
  const [failed, setFailed] = useState(15);
  const [feed, setFeed] = useState<{ id: number; group: string; time: string }[]>([
    { id: 1, group: "Crypto Signals VIP", time: "just now" },
    { id: 2, group: "NFT Traders Hub", time: "2s ago" },
    { id: 3, group: "Solana Alpha Calls", time: "3s ago" },
    { id: 4, group: "Forex Masters", time: "4s ago" },
    { id: 5, group: "BTC India Lounge", time: "5s ago" },
    { id: 6, group: "DeFi Community", time: "6s ago" },
    { id: 7, group: "Airdrop Hunters", time: "7s ago" },
  ]);
  const idRef = useRef(8);

  const BOTS = [1, 2, 3, 4, 5];
  const [posting, setPosting] = useState<number>(2); // which bot is currently posting

  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => {
      setSent(s => s + 1 + Math.floor(Math.random() * 3));
      setDelivered(d => d + 1 + Math.floor(Math.random() * 3));
      setFailed(f => f + (Math.random() > 0.85 ? 1 : 0));
      setPosting(() => Math.floor(Math.random() * BOTS.length) + 1);
      setFeed(f => [
        { id: idRef.current++, group: GROUPS[Math.floor(Math.random() * GROUPS.length)].name, time: "just now" },
        ...f.slice(0, 6).map(x => ({ ...x, time: x.time === "just now" ? "2s ago" : x.time })),
      ]);
    }, 2000);
    return () => clearInterval(t);
  }, [visible]);

  const card = "rounded-xl border border-[#1f1f22] bg-[#0e0e10] overflow-hidden";
  const head = "flex items-center justify-between px-4 py-3 border-b border-[#1f1f22]";

  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-3 gap-4">

        {/* ── Live Delivery Feed ── */}
        <div className={card}>
          <div className={head}>
            <span className="flex items-center gap-2 text-[13px] font-medium text-white">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live Delivery Feed
            </span>
          </div>
          <div className="px-4 py-2.5">
            {feed.map((f) => (
              <div key={f.id} className="msg-in flex items-center justify-between gap-3 py-[7px]">
                <span className="flex items-center gap-2 text-[12px] text-[#8b8b93] min-w-0">
                  <Send className="w-3.5 h-3.5 flex-shrink-0" style={{ color: TG }} />
                  <span className="flex-shrink-0">Ad delivered to</span>
                  <span className="text-[#e6e6ea] font-medium truncate">{f.group}</span>
                </span>
                <span className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-[11px] text-[#5d5d66]">{f.time}</span>
                  <Check className="w-3 h-3 text-emerald-500" />
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Posting Bots ── */}
        <div className={card}>
          <div className={head}>
            <span className="flex items-center gap-2 text-[13px] font-medium text-white">
              <Users className="w-4 h-4" style={{ color: TG }} />
              Posting Bots
            </span>
            <span className="text-[11px] text-[#8b8b93] tabular-nums">{BOTS.length} / {BOTS.length} online</span>
          </div>
          <div className="px-4 py-2.5 divide-y divide-[#161618]">
            {BOTS.map((n) => {
              const isPosting = posting === n;
              return (
                <div key={n} className="flex items-center justify-between gap-3 py-[9px]">
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#161618] border border-[#1f1f22]">
                      <User className="w-3.5 h-3.5 text-[#8b8b93]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium text-[#e6e6ea] leading-tight">Bot {n}</span>
                      <span className="block text-[11px] text-[#5d5d66] leading-tight">Managed by HQAdz</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[11px] font-medium" style={{ color: isPosting ? TG : "#34d399" }}>
                      {isPosting ? "Posting" : "Ready"}
                    </span>
                    <SignalBars active={isPosting} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Campaign Overview ── */}
        <div className={card}>
          <div className={head}>
            <span className="flex items-center gap-2 text-[13px] font-medium text-white">
              <Activity className="w-4 h-4" style={{ color: TG }} />
              Campaign Overview
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-[#8b8b93]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Example
            </span>
          </div>
          <div className="grid grid-cols-2">
            {[
              { label: "Active Bots", value: "6" },
              { label: "Posts Sent Today", value: fmt(sent) },
              { label: "Delivered", value: fmt(delivered) },
              { label: "Failed", value: fmt(failed) },
            ].map((s, i) => (
              <div key={s.label} className={`px-4 py-4 ${i % 2 === 0 ? "border-r border-[#1f1f22]" : ""} ${i < 2 ? "border-b border-[#1f1f22]" : ""}`}>
                <p className="text-[10px] text-[#5d5d66] uppercase tracking-wider mb-1.5">{s.label}</p>
                <Tick value={s.value} className="text-xl md:text-2xl font-semibold text-white tracking-tight" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Trust badges ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 rounded-xl border border-[#1f1f22] bg-[#0e0e10] divide-x divide-y md:divide-y-0 divide-[#1f1f22] overflow-hidden">
        {[
          { icon: ShieldCheck, title: "Managed Posting Bots", sub: "We handle the bots for you." },
          { icon: Lock, title: "Your Data is Safe", sub: "Encrypted & private." },
          { icon: Zap, title: "Reliable Delivery", sub: "Bots work together to post." },
          { icon: Clock, title: "Live Delivery Tracking", sub: "Every post logged as it lands." },
        ].map((b) => (
          <div key={b.title} className="flex items-center gap-3 px-4 py-4">
            <b.icon className="w-5 h-5 flex-shrink-0" style={{ color: TG }} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-white leading-tight">{b.title}</span>
              <span className="block text-[11px] text-[#5d5d66] leading-tight mt-0.5">{b.sub}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Ops transparency ─── */
function OpsBoard({ visible }: { visible: boolean }) {
  const rows = [
    { label: "Posting bots", value: "Managed for you", status: "ok" },
    { label: "Bot health checks", value: "Ongoing", status: "ok" },
    { label: "Free replacements", value: "Included in every plan", status: "ok" },
    { label: "Delivery tracking", value: "Live in your dashboard", status: "ok" },
    { label: "Crypto payments", value: "Accepted", status: "ok" },
  ];

  return (
    <div className="rounded-lg border border-[#1f1f22] bg-[#0e0e10] divide-y divide-[#1f1f22]">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between px-5 py-3.5">
          <span className="text-[13px] text-[#8b8b93]">{r.label}</span>
          <span className="flex items-center gap-2.5">
            <Tick value={r.value} className="text-[13px] font-medium text-white" />
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          </span>
        </div>
      ))}
    </div>
  );
}

interface Plan { id: string; sessions: number; price_week: number; price_month: number; free_replacements: number; cycle?: number; gap?: number }
interface Plans { starter: Plan[]; enterprise: Plan[] }

const PLAN_META: Record<string, { rec: string; icon: typeof Gem }> = {
  bronze:  { rec: "Testing the waters", icon: Zap },
  silver:  { rec: "Built for solo sellers", icon: Gem },
  gold:    { rec: "Growing channels", icon: Star },
  diamond: { rec: "Power sellers", icon: Crown },
  basic:   { rec: "For small teams", icon: Building2 },
  pro:     { rec: "For growing agencies", icon: Rocket },
  elite:   { rec: "For large scale teams", icon: Crown },
};

const FAQS = [
  { q: "Do I need my own Telegram accounts?", a: "No. HQAdz provides and manages the posting bots included in your plan. You just provide the ad." },
  { q: "How quickly can a campaign start?", a: "Most orders are prepared within 1–12 hours after your payment is confirmed, depending on current bot availability." },
  { q: "What happens if a posting bot stops working?", a: "The bot is checked, and if it's eligible, it's replaced from the free allowance included with your plan so your campaign keeps running." },
  { q: "Can I choose specific groups?", a: "Yes. Use the HQAdz group list or add your own groups and manage your target list directly from the dashboard." },
  { q: "How is delivery tracked?", a: "Every delivery attempt is logged as it happens, with per-group details in your dashboard. The preview above reflects the real interface." },
  { q: "Do you guarantee sales, members, or views?", a: "No. HQAdz provides the posting service described in your plan. Results depend on your ad, offer, and audience — we don't guarantee outcomes." },
  { q: "Do I get any bonus rewards?", a: "Occasionally. HQAdz may run promotions offering bonus days, extra replacements, or other account rewards. These vary and aren't part of every order." },
];

export default function LandingPage() {
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [plans, setPlans] = useState<Plans | null>(null);
  const [planTab, setPlanTab] = useState<"starter" | "enterprise">("starter");
  const [billing, setBilling] = useState<"week" | "month">("month");
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [buyPlan, setBuyPlan] = useState<PurchasePlan | null>(null);
  const [resumeOrder, setResumeOrder] = useState<any>(null);

  // Mobile in-section plan navigation
  const [activePlanId, setActivePlanId] = useState<string>("");
  const [showStickyNav, setShowStickyNav] = useState(false);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const NAV_OFFSET = 56; // fixed navbar height (h-14)

  const scrollToPlan = (id: string) => {
    const el = cardRefs.current[id];
    if (!el) return;
    const stickyH = stickyRef.current?.offsetHeight ?? 92;
    const y = window.scrollY + el.getBoundingClientRect().top - NAV_OFFSET - stickyH - 12;
    window.scrollTo({ top: y, behavior: "smooth" });
  };

  // Resume an in-progress payment after a page refresh
  useEffect(() => {
    try {
      const saved = localStorage.getItem("hqadz_pending_purchase");
      if (saved) {
        const p = JSON.parse(saved);
        if (p?.order?.order_id && p?.plan && p?.currency) {
          setResumeOrder({ order: p.order, currency: p.currency, billing: p.billing });
          setBuyPlan(p.plan);
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    axios.get(`${API}/api/portal/plans`).then(r => setPlans(r.data)).catch(() => {
      setPlans({
        starter: [
          { id: "bronze", sessions: 2, price_week: 10, price_month: 30, free_replacements: 1 },
          { id: "silver", sessions: 4, price_week: 18, price_month: 55, free_replacements: 2 },
          { id: "gold", sessions: 6, price_week: 25, price_month: 80, free_replacements: 3 },
          { id: "diamond", sessions: 10, price_week: 40, price_month: 130, free_replacements: 4 },
        ],
        enterprise: [
          { id: "basic", sessions: 5, cycle: 900, gap: 5, price_week: 60, price_month: 199, free_replacements: 2 },
          { id: "pro", sessions: 12, cycle: 420, gap: 5, price_week: 160, price_month: 420, free_replacements: 4 },
          { id: "elite", sessions: 20, cycle: 120, gap: 5, price_week: 280, price_month: 699, free_replacements: -1 },
        ],
      });
    });
  }, []);

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 32);
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  // Track the plan card currently in view and show the sticky nav only while
  // scrolling within the cards range (mobile only — desktop shows all at once).
  useEffect(() => {
    const tabPlans = plans ? plans[planTab] : [];
    if (!tabPlans.length) return;
    setActivePlanId(prev => (tabPlans.some(p => p.id === prev) ? prev : tabPlans[0].id));
    const measure = () => {
      const grid = gridRef.current;
      if (!grid) return;
      const gr = grid.getBoundingClientRect();
      const within = gr.top <= NAV_OFFSET + 8 && gr.bottom >= NAV_OFFSET + 120;
      setShowStickyNav(within && window.innerWidth < 768);
      if (!within) return;
      const line = NAV_OFFSET + 140;
      let active = tabPlans[0].id;
      for (const p of tabPlans) {
        const el = cardRefs.current[p.id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) active = p.id;
        else break;
      }
      setActivePlanId(active);
    };
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure, { passive: true });
    measure();
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [plans, planTab]);

  const hero = useInView(0.05);
  const how = useInView(0.2);
  const live = useInView(0.15);
  const trust = useInView(0.15);
  const pricingRef = useInView(0.05);
  const faqRef = useInView(0.1);
  const ctaRef = useInView(0.1);

  const activePlans = plans ? plans[planTab] : [];
  const maxSave = Math.max(0, ...activePlans.map(p => {
    const w4 = p.price_week * 4;
    return w4 > 0 ? Math.round(((w4 - p.price_month) / w4) * 100) : 0;
  }));
  const tierLabel: Record<string, string> = {
    bronze: "Bronze", silver: "Silver", gold: "Gold", diamond: "Diamond",
    basic: "Basic", pro: "Pro", elite: "Elite",
  };
  const popularIds = new Set(["gold", "pro"]);

  const reveal = (visible: boolean, delay = 0) => ({
    className: `transition-all duration-700 ease-out ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-5"}`,
    style: delay ? { transitionDelay: `${delay}ms` } : undefined,
  });

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] antialiased font-body">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "HQAdz",
            "url": "https://hqadz.io",
            "logo": "https://hqadz.io/icon.png"
          })
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": "HQAdz",
            "url": "https://hqadz.io"
          })
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": "HQAdz",
            "applicationCategory": "BusinessApplication",
            "operatingSystem": "Web",
            "url": "https://hqadz.io",
            "description": "HQAdz.io is a Telegram advertising platform for managing posting bots, live delivery tracking, custom group targeting, and crypto payments from one dashboard."
          })
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": FAQS.map(faq => ({
              "@type": "Question",
              "name": faq.q,
              "acceptedAnswer": {
                "@type": "Answer",
                "text": faq.a
              }
            }))
          })
        }}
      />

      {/* ── Nav ── */}
      <nav className={`fixed top-0 inset-x-0 z-50 transition-all duration-400 ${
        scrolled ? "bg-[#0a0a0a]/85 backdrop-blur-lg border-b border-[#1f1f22]" : ""
      }`}>
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <BrandMark height={22} />
          </Link>

          <div className="hidden md:flex items-center gap-0.5">
            {[["How it works", "#how-it-works"], ["Live", "#live"], ["Pricing", "#pricing"], ["FAQ", "#faq"]].map(([l, h]) => (
              <a key={l} href={h} className="text-[13px] text-[#8b8b93] hover:text-white px-3 py-1.5 transition-colors duration-150">
                {l}
              </a>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-2">
            <Link href="/user/login" className="text-[13px] text-[#8b8b93] hover:text-white px-3 py-1.5 transition-colors duration-150">
              Log in
            </Link>
            <Link href="/user/login" className="text-[13px] font-medium text-white px-3.5 py-1.5 rounded-md transition-opacity duration-150 hover:opacity-90" style={{ background: TG }}>
              Start advertising
            </Link>
          </div>

          <button onClick={() => setMobileMenu(!mobileMenu)} className="md:hidden text-white p-2 -mr-2" aria-label="Toggle menu">
            {mobileMenu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {mobileMenu && (
          <div className="md:hidden bg-[#0a0a0a] border-b border-[#1f1f22] px-6 pb-4">
            {[["How it works", "#how-it-works"], ["Live", "#live"], ["Pricing", "#pricing"], ["FAQ", "#faq"]].map(([l, h]) => (
              <a key={l} href={h} onClick={() => setMobileMenu(false)} className="block py-2.5 text-[#8b8b93] text-[13px]">
                {l}
              </a>
            ))}
            <div className="mt-3 flex gap-2">
              <Link href="/user/login" className="flex-1 text-center text-[13px] text-[#8b8b93] border border-[#1f1f22] py-2 rounded-md">Log in</Link>
              <Link href="/user/login" className="flex-1 text-center text-[13px] font-medium text-white py-2 rounded-md" style={{ background: TG }}>Start advertising</Link>
            </div>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section className="pt-28 md:pt-36 pb-16 md:pb-24">
        <div ref={hero.ref} className="max-w-5xl mx-auto px-6">
          <div className="grid lg:grid-cols-[1fr_440px] gap-12 lg:gap-14 items-center">
            <div>
              <h1 className={`text-[42px] sm:text-[52px] md:text-[60px] font-semibold text-white leading-[1.04] tracking-[-0.03em] ${reveal(hero.visible).className}`}>
                Stop trusting promises.<br />
                <span style={{ color: TG }}>Start tracking every post.</span>
              </h1>
              <p className={`mt-6 text-[15px] md:text-base text-[#8b8b93] max-w-sm leading-relaxed ${reveal(hero.visible, 120).className}`} style={reveal(hero.visible, 120).style}>
                HQAdz is a Telegram advertising platform where you launch campaigns, manage your posting bots, choose your groups, and track every delivery from your dashboard or Telegram control bot.
              </p>
              <div className={`mt-8 flex items-center gap-4 ${reveal(hero.visible, 220).className}`} style={reveal(hero.visible, 220).style}>
                <Link href="/user/login" className="inline-flex items-center gap-2 text-[14px] font-medium text-white px-5 py-2.5 rounded-md transition-all duration-150 hover:opacity-90 hover:translate-y-[-1px]" style={{ background: TG }}>
                  Start advertising
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <a href="#how-it-works" className="text-[14px] text-[#8b8b93] hover:text-white transition-colors duration-150">
                  See how it works
                </a>
              </div>
              <p className={`mt-8 text-[12px] text-[#5d5d66] ${reveal(hero.visible, 320).className}`} style={reveal(hero.visible, 320).style}>
                Managed posting bots · Live delivery tracking · Free replacements · Custom group lists
              </p>
            </div>

            <div className={reveal(hero.visible, 250).className} style={reveal(hero.visible, 250).style}>
              <HeroSim />
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works" className="py-16 md:py-24 border-t border-[#1f1f22]">
        <div ref={how.ref} className="max-w-5xl mx-auto px-6">
          <div className={`mb-14 ${reveal(how.visible).className}`}>
            <h2 className="text-[28px] md:text-4xl font-semibold text-white tracking-[-0.02em]">
              From payment to promotion.
            </h2>
            <p className="mt-3 text-[14px] text-[#8b8b93] max-w-md">
              Most orders are prepared within 1–12 hours after confirmed payment, depending on bot availability.
            </p>
          </div>
          <div className={reveal(how.visible, 150).className} style={reveal(how.visible, 150).style}>
            <Workflow visible={how.visible} />
          </div>
        </div>
      </section>

      {/* ── Live campaign monitor ── */}
      <section id="live" className="py-16 md:py-24 border-t border-[#1f1f22]">
        <div ref={live.ref} className="max-w-5xl mx-auto px-6">
          <div className={`mb-10 flex flex-col md:flex-row md:items-end md:justify-between gap-4 ${reveal(live.visible).className}`}>
            <h2 className="text-[28px] md:text-4xl font-semibold text-white tracking-[-0.02em]">
              Watch it work.
            </h2>
            <p className="text-[14px] text-[#8b8b93] max-w-xs md:text-right">
              A preview of the live delivery tracking inside your dashboard.
            </p>
          </div>
          <div className={reveal(live.visible, 150).className} style={reveal(live.visible, 150).style}>
            <CampaignMonitor visible={live.visible} />
          </div>
        </div>
      </section>

      {/* ── Trust / ops ── */}
      <section className="py-16 md:py-24 border-t border-[#1f1f22]">
        <div ref={trust.ref} className="max-w-5xl mx-auto px-6">
          <div className="grid md:grid-cols-[1fr_1.2fr] gap-10 md:gap-16 items-center">
            <div className={reveal(trust.visible).className}>
              <h2 className="text-[28px] md:text-4xl font-semibold text-white tracking-[-0.02em]">
                We manage the posting bots.
              </h2>
              <p className="mt-4 text-[14px] text-[#8b8b93] leading-relaxed max-w-sm">
                Every posting bot is checked before assignment and monitored while your campaign runs. If an eligible bot stops working, it&apos;s replaced under your plan&apos;s allowance.
              </p>
              <p className="mt-6 text-[13px]">
                <a href="#faq" className="inline-flex items-center gap-1.5 transition-colors duration-150 hover:text-white" style={{ color: TG }}>
                  What happens if a posting bot stops working? <ArrowRight className="w-3.5 h-3.5" />
                </a>
              </p>
            </div>
            <div className={reveal(trust.visible, 150).className} style={reveal(trust.visible, 150).style}>
              <OpsBoard visible={trust.visible} />
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="relative py-20 md:py-28 border-t border-[#1f1f22]">
        <div ref={pricingRef.ref} className="relative z-10 max-w-7xl mx-auto px-6">

          {/* Eyebrow + heading + supporting text */}
          <div className={`text-center max-w-2xl mx-auto ${reveal(pricingRef.visible).className}`}>
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#5d5d66]">Pricing</p>
            <h2 className="mt-3 text-[30px] sm:text-[38px] md:text-[46px] lg:text-[50px] font-semibold text-white tracking-[-0.02em] leading-[1.05]">
              Simple pricing built to scale.
            </h2>
            <p className="mt-4 text-[14px] md:text-[15px] text-[#8b8b93] leading-relaxed">
              Choose the number of bot accounts you need. Upgrade anytime as your campaigns grow.
            </p>
          </div>

          {/* Selectors — plan family + billing */}
          <div className={`mt-8 flex flex-col items-center gap-3 ${reveal(pricingRef.visible, 80).className}`} style={reveal(pricingRef.visible, 80).style}>
            {/* plan family */}
            <div className="relative inline-flex rounded-full border border-[#1f1f22] bg-[#0e0e10] p-1">
              {([
                { id: "starter", icon: User, name: "Starter" },
                { id: "enterprise", icon: Building2, name: "Enterprise" },
              ] as const).map((t) => {
                const on = planTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setPlanTab(t.id)}
                    className={`relative z-10 flex items-center gap-2 h-[42px] px-6 rounded-full text-[13.5px] font-medium transition-colors duration-200 cursor-pointer ${on ? "text-white" : "text-[#8b8b93] hover:text-white"}`}
                  >
                    {on && (
                      <motion.span
                        layoutId="segPill"
                        className="absolute inset-0 rounded-full"
                        style={{ background: TG }}
                        transition={{ type: "spring", stiffness: 480, damping: 34 }}
                      />
                    )}
                    <t.icon className="relative w-4 h-4" />
                    <span className="relative">{t.name}</span>
                  </button>
                );
              })}
            </div>

            {/* billing */}
            <div className="relative inline-flex rounded-full border border-[#1f1f22] bg-[#0e0e10] p-1">
              {([
                { id: "week", name: "Weekly" },
                { id: "month", name: "Monthly" },
              ] as const).map((t) => {
                const on = billing === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setBilling(t.id)}
                    className={`relative z-10 flex items-center gap-1.5 h-8 px-4 rounded-full text-[12.5px] font-medium transition-colors duration-200 cursor-pointer ${on ? "text-white" : "text-[#8b8b93] hover:text-white"}`}
                  >
                    {on && (
                      <motion.span
                        layoutId="billPill"
                        className="absolute inset-0 rounded-full"
                        style={{ background: "rgba(255,255,255,0.08)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                        transition={{ type: "spring", stiffness: 480, damping: 34 }}
                      />
                    )}
                    <span className="relative">{t.name}</span>
                    {t.id === "month" && maxSave > 0 && (
                      <span className="relative text-[10px] font-semibold" style={{ color: on ? TG : "#5d5d66" }}>−{maxSave}%</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Plan cards */}
          <div
            ref={gridRef}
            className={`grid grid-cols-1 sm:grid-cols-2 gap-5 mt-12 ${
              activePlans.length === 3 ? "lg:grid-cols-3 lg:max-w-5xl lg:mx-auto" : "lg:grid-cols-4"
            } ${reveal(pricingRef.visible, 160).className}`}
            style={reveal(pricingRef.visible, 160).style}
          >
            {activePlans.map((plan) => {
              const label = tierLabel[plan.id] || plan.id;
              const isPopular = popularIds.has(plan.id);
              const meta = PLAN_META[plan.id] || { rec: "—", icon: Gem };
              const TierIcon = meta.icon;
              const dailyPosts = plan.sessions * 1200;
              const weekly4 = plan.price_week * 4;
              const savePct = weekly4 > 0 ? Math.round(((weekly4 - plan.price_month) / weekly4) * 100) : 0;
              const price = billing === "month" ? plan.price_month : plan.price_week;

              const openBuy = () => {
                try { localStorage.removeItem("hqadz_pending_purchase"); } catch {}
                setResumeOrder(null);
                setBuyPlan({
                  id: plan.id,
                  label,
                  mode: planTab,
                  priceWeek: plan.price_week,
                  priceMonth: plan.price_month,
                  posts: dailyPosts.toLocaleString(),
                  replacements: plan.free_replacements === -1 ? "Unlimited" : `${plan.free_replacements} free`,
                  billingPreselect: billing,
                });
              };

              const isActiveMobile = showStickyNav && activePlanId === plan.id;
              return (
                <div
                  key={plan.id}
                  ref={(el) => { cardRefs.current[plan.id] = el; }}
                  className={`snap-card group/card relative transition-transform duration-300 hover:-translate-y-1 ${isPopular ? "lg:z-10" : ""}`}
                >
                  <div
                    className={`relative flex flex-col h-full rounded-2xl border overflow-hidden transition-colors duration-300 ${
                      isPopular ? "" : "border-[#1f1f22] group-hover/card:border-[#2e2e34]"
                    }`}
                    style={
                      isPopular
                        ? { borderColor: "rgba(42,171,238,0.55)", background: "#0c1015", boxShadow: "0 20px 60px -34px rgba(42,171,238,0.45)" }
                        : isActiveMobile
                          ? { background: "#0d0d10", borderColor: "rgba(42,171,238,0.45)", boxShadow: "0 0 0 1px rgba(42,171,238,0.28)" }
                          : { background: "#0d0d10" }
                    }
                  >
                    {/* ── Header — icon tile + name + tagline ── */}
                    <div className="flex items-center gap-3 px-5 pt-5 pb-1">
                      <span
                        className="grid place-content-center w-9 h-9 rounded-xl flex-shrink-0"
                        style={isPopular
                          ? { background: "rgba(42,171,238,0.14)", boxShadow: "inset 0 0 0 1px rgba(42,171,238,0.28)" }
                          : { background: "rgba(255,255,255,0.05)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
                      >
                        <TierIcon className="w-[18px] h-[18px]" style={{ color: isPopular ? TG : "#a1a1aa" }} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[17px] font-semibold text-white leading-tight">{label}</p>
                        <p className="text-[11.5px] text-[#8b8b93] leading-tight mt-0.5">{meta.rec}</p>
                      </div>
                      {isPopular && (
                        <span className="ml-auto self-start flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-white pl-1.5 pr-2 py-1 rounded-full" style={{ background: TG }}>
                          <Star className="w-2.5 h-2.5 fill-white" /> Popular
                        </span>
                      )}
                    </div>

                    {/* ── Price — single selected billing ── */}
                    <div className="px-5 pt-4 pb-4">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[34px] font-bold text-white leading-none tracking-[-0.02em]">$<AnimatedPrice value={price} /></span>
                        <span className="text-[13px] text-[#8b8b93]">/{billing === "month" ? "month" : "week"}</span>
                        {billing === "month" && savePct > 0 && (
                          <span className="ml-1 text-[11px] font-medium text-[#8b8b93]">save {savePct}%</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[12px] text-[#5d5d66]">
                        {billing === "month" ? `or $${plan.price_week} billed weekly` : `or $${plan.price_month} billed monthly`}
                      </p>
                    </div>

                    {/* ── Body ── */}
                    <div className="flex flex-col flex-1 px-5 pb-5">
                      {/* stats */}
                      <div className="grid grid-cols-2 rounded-xl border border-[#1f1f22] bg-white/[0.015] divide-x divide-[#1f1f22]">
                        <div className="flex items-center gap-2.5 px-3.5 py-3">
                          <span className="grid place-content-center w-9 h-9 rounded-lg flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }}>
                            <Bot className="w-[18px] h-[18px]" style={{ color: "#a1a1aa" }} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-[18px] font-semibold text-white leading-none tabular-nums">{plan.sessions}</p>
                            <p className="text-[11px] text-[#8b8b93] mt-1">Bot Accounts</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2.5 px-3.5 py-3">
                          <span className="grid place-content-center w-9 h-9 rounded-lg flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }}>
                            <BarChart3 className="w-[18px] h-[18px]" style={{ color: "#a1a1aa" }} />
                          </span>
                          <div className="min-w-0">
                            <p className="text-[18px] font-semibold text-white leading-none tabular-nums">{fmtK(dailyPosts)}</p>
                            <p className="text-[11px] text-[#8b8b93] mt-1">Posts / Day</p>
                          </div>
                        </div>
                      </div>

                      {/* differentiators — left-aligned rows */}
                      <div className="mt-3 space-y-2.5">
                        {[
                          plan.free_replacements === -1 ? "Unlimited bot replacements" : `${plan.free_replacements} free bot replacement${plan.free_replacements !== 1 ? "s" : ""}`,
                          "Custom auto replies",
                          "Custom target groups",
                          ...(planTab === "enterprise" ? ["Priority support"] : []),
                        ].map((label, j) => (
                          <div key={j} className="flex items-center gap-2.5">
                            <span className="grid place-content-center w-5 h-5 rounded-full flex-shrink-0" style={{ background: "rgba(255,255,255,0.06)" }}>
                              <Check className="w-3 h-3" style={{ color: "#a1a1aa" }} />
                            </span>
                            <span className="text-[13px] text-[#c9c9cf] leading-tight">{label}</span>
                          </div>
                        ))}
                      </div>

                      {/* CTA */}
                      <button
                        onClick={openBuy}
                        className={`group/btn mt-6 w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold h-12 rounded-xl border transition-all duration-200 cursor-pointer ${
                          isPopular
                            ? "text-white hover:brightness-110"
                            : "text-[#e4e4e7] bg-white/[0.02] border-[#26262b] hover:bg-white/[0.05] hover:border-[#33333a]"
                        }`}
                        style={isPopular ? { background: TG, borderColor: TG } : undefined}
                      >
                        Choose {label}
                        <ArrowRight className="w-4 h-4 transition-transform duration-150 group-hover/btn:translate-x-0.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Mobile in-section sticky nav (only within the cards range) ── */}
          <div
            ref={stickyRef}
            className={`md:hidden fixed top-14 inset-x-0 z-40 transition-all duration-300 ${showStickyNav ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2 pointer-events-none"}`}
          >
            <div className="bg-[#0a0a0a]/85 backdrop-blur-lg border-b border-[#1f1f22] px-4 py-1.5 space-y-1.5">
              {/* plan family — sliding pill */}
              <div className="relative flex rounded-full border border-[#1f1f22] bg-[#0e0e10] p-0.5">
                {(["starter", "enterprise"] as const).map((t) => {
                  const on = planTab === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setPlanTab(t)}
                      className={`relative z-10 flex-1 h-8 rounded-full text-[12.5px] font-medium capitalize transition-colors ${on ? "text-white" : "text-[#8b8b93]"}`}
                    >
                      {on && <motion.span layoutId="stickySegPill" className="absolute inset-0 rounded-full" style={{ background: TG }} transition={{ type: "spring", stiffness: 480, damping: 34 }} />}
                      <span className="relative">{t}</span>
                    </button>
                  );
                })}
              </div>
              {/* plan tabs — sliding pill doubles as a progress indicator */}
              <div className="flex gap-1.5 overflow-x-auto plan-scroll">
                {activePlans.map((p) => {
                  const on = activePlanId === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => scrollToPlan(p.id)}
                      className={`relative z-10 flex flex-shrink-0 items-center gap-1.5 h-8 px-3.5 rounded-full text-[12px] font-medium transition-colors ${on ? "text-white" : "text-[#8b8b93]"}`}
                      style={on ? undefined : { background: "#141417" }}
                    >
                      {on && <motion.span layoutId="stickyPlanPill" className="absolute inset-0 rounded-full" style={{ background: TG }} transition={{ type: "spring", stiffness: 480, damping: 34 }} />}
                      {on && <span className="relative w-1.5 h-1.5 rounded-full bg-white" />}
                      <span className="relative">{tierLabel[p.id] || p.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Trust bar — one unified panel with hairline dividers (1px gap over divider bg) */}
          <div className={`mt-10 rounded-2xl border border-[#1f1f22] overflow-hidden grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-[#1f1f22] ${reveal(pricingRef.visible, 280).className}`} style={reveal(pricingRef.visible, 280).style}>
            {[
              { icon: Zap, title: "Instant Setup", sub: "Ready in seconds" },
              { icon: RotateCw, title: "Free Replacements", sub: "Included with your plan" },
              { icon: Lock, title: "Secure Payments", sub: "Safe crypto checkout" },
              { icon: Gem, title: "Premium Accounts", sub: "High-quality bot accounts" },
              { icon: MessageCircle, title: "24/7 Support", sub: "We're here when needed" },
            ].map((t, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 px-4 py-4 bg-[#0d0d10] ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}
              >
                <span className="grid place-content-center w-9 h-9 rounded-lg flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }}>
                  <t.icon className="w-[18px] h-[18px]" style={{ color: "#a1a1aa" }} />
                </span>
                <div className="min-w-0">
                  <p className="text-[12.5px] font-semibold text-white leading-tight">{t.title}</p>
                  <p className="text-[11px] text-[#8b8b93] leading-snug mt-0.5">{t.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="py-16 md:py-24 border-t border-[#1f1f22]">
        <div ref={faqRef.ref} className="max-w-3xl mx-auto px-6">
          <h2 className={`text-[28px] md:text-4xl font-semibold text-white tracking-[-0.02em] mb-10 ${reveal(faqRef.visible).className}`}>
            Before you ask.
          </h2>

          <div className="divide-y divide-[#1f1f22]">
            {FAQS.map((f, i) => {
              const open = openFaq === i;
              return (
                <div key={i} className={reveal(faqRef.visible, 60 * i).className} style={reveal(faqRef.visible, 60 * i).style}>
                  <button
                    onClick={() => setOpenFaq(open ? null : i)}
                    className="w-full flex items-center justify-between gap-4 py-4 text-left cursor-pointer group"
                    aria-expanded={open}
                  >
                    <span className={`text-[14px] font-medium transition-colors duration-200 ${open ? "text-white" : "text-[#c9c9cf] group-hover:text-white"}`}>
                      {f.q}
                    </span>
                    <Plus className={`w-4 h-4 flex-shrink-0 transition-transform duration-300 ${open ? "rotate-45 text-white" : "text-[#5d5d66]"}`} />
                  </button>
                  <div className={`grid transition-all duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                    <div className="overflow-hidden">
                      <p className="text-[13px] text-[#8b8b93] leading-relaxed pb-5 pr-8">{f.a}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-20 md:py-28 border-t border-[#1f1f22]">
        <div ref={ctaRef.ref} className={`max-w-5xl mx-auto px-6 text-center ${reveal(ctaRef.visible).className}`}>
          <h2 className="text-[32px] md:text-5xl font-semibold text-white tracking-[-0.03em] leading-[1.1]">
            Your advertising shouldn&apos;t<br />depend on promises.
          </h2>
          <Link href="/user/login" className="mt-9 inline-flex items-center gap-2 text-[14px] font-medium text-white px-7 py-3 rounded-md transition-all duration-150 hover:opacity-90 hover:translate-y-[-1px]" style={{ background: TG }}>
            Start advertising
            <ArrowRight className="w-4 h-4" />
          </Link>
          <p className="mt-5 text-[12px] text-[#5d5d66]">You provide the ad. HQAdz handles the posting.</p>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-[#1f1f22]">
        <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-6">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="flex items-center gap-2">
              <BrandMark height={18} />
              <span className="text-[12px] text-[#5d5d66] ml-3">© 2025</span>
            </div>
            <div className="flex items-center gap-5 text-[12px] text-[#5d5d66]">
              <a href="#pricing" className="hover:text-white transition-colors duration-150">Pricing</a>
              <Link href="/faq" className="hover:text-white transition-colors duration-150">FAQ</Link>
              <Link href="/terms" className="hover:text-white transition-colors duration-150">Terms</Link>
              <Link href="/privacy-policy" className="hover:text-white transition-colors duration-150">Privacy</Link>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Operational
              </span>
            </div>
          </div>
          <nav aria-label="Site pages" className="flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[#5d5d66]">
            <Link href="/telegram-adbot" className="hover:text-white transition-colors duration-150">Telegram AdBot</Link>
            <Link href="/features" className="hover:text-white transition-colors duration-150">Features</Link>
            <Link href="/why-hqadz" className="hover:text-white transition-colors duration-150">Why HQAdz</Link>
            <Link href="/pricing" className="hover:text-white transition-colors duration-150">Pricing</Link>
            <Link href="/how-it-works" className="hover:text-white transition-colors duration-150">How it works</Link>
            <Link href="/faq" className="hover:text-white transition-colors duration-150">FAQ</Link>
            <Link href="/telegram-session-management" className="hover:text-white transition-colors duration-150">Session management</Link>
            <Link href="/telegram-adbot-dashboard" className="hover:text-white transition-colors duration-150">Dashboard</Link>
            <Link href="/contact" className="hover:text-white transition-colors duration-150">Contact</Link>
          </nav>
        </div>
      </footer>

      {buyPlan && <PurchaseFlow plan={buyPlan} resume={resumeOrder} onClose={() => { setBuyPlan(null); setResumeOrder(null); }} />}

      <style jsx global>{`
        @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap");

        .font-body {
          font-family: "Inter", system-ui, -apple-system, sans-serif;
          font-feature-settings: "cv11", "ss01";
        }

        ::selection {
          background: rgba(42, 171, 238, 0.25);
          color: #fff;
        }

        .plan-scroll::-webkit-scrollbar { height: 0; display: none; }
        .plan-scroll { -ms-overflow-style: none; scrollbar-width: none; }

        /* Mobile: gently snap between plan cards (only near a card, not elsewhere) */
        @media (max-width: 767px) {
          html { scroll-snap-type: y proximity; }
          .snap-card { scroll-snap-align: start; scroll-margin-top: 140px; }
        }

        /* Message / feed item entrance */
        @keyframes msgIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .msg-in {
          animation: msgIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        /* Number pulse on update */
        @keyframes numPulse {
          0% { opacity: 0.4; transform: translateY(3px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .num-pulse {
          animation: numPulse 0.4s ease-out both;
        }

        /* Dot flowing down a connector line */
        @keyframes flowDot {
          0% { top: -10%; opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { top: 110%; opacity: 0; }
        }
        .flow-dot {
          animation: flowDot 1.4s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .msg-in, .num-pulse, .flow-dot {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
