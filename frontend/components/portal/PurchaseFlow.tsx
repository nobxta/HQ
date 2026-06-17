"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import {
  X, ArrowLeft, ArrowRight, Check, CheckCheck, Search, Copy, Clock,
  AlertTriangle, Loader2, Tag, ChevronRight, Sparkles, Wallet,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const TG = "#2AABEE";

/* Plan passed in from the pricing section */
export interface PurchasePlan {
  id: string;
  label: string;
  mode: "starter" | "enterprise";
  billing: "week" | "month";
  price: number;
  reach: string;
  posts: string;
  replacements: string;
  durationDays: number;
}

interface CryptoCurrency {
  code: string; symbol: string; name: string; network: string;
  logo: string; price_usd: number; is_stablecoin: boolean;
}

interface OrderData {
  order_id: string; plan_name: string; amount_usd: number; base_amount_usd: number;
  coupon: string; coupon_percent: number; pay_address: string; pay_amount: number;
  pay_currency: string; invoice_expires_at: string; queued: boolean; display_name: string;
}

interface StatusData {
  status: string; payment_confirmed: boolean; amount_received: number; pay_amount: number;
  underpaid: boolean; tx_hash: string; queued: boolean;
  creation: { state: string; percent: number }; access_token: string;
  bot_username: string; bot_name: string;
}

type Step = "details" | "checkout" | "crypto" | "review" | "pay" | "creating";

const TOP_COINS = ["BTC", "ETH", "XMR", "LTC", "SOL", "USDT_TRC20"];

/* Built-in coin list so the picker always works, even before/without the backend.
   Real logos come from a public icon CDN keyed by symbol (with a colored fallback). */
const FALLBACK_COINS: CryptoCurrency[] = [
  { code: "BTC", symbol: "BTC", name: "Bitcoin", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "ETH", symbol: "ETH", name: "Ethereum", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "XMR", symbol: "XMR", name: "Monero", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "LTC", symbol: "LTC", name: "Litecoin", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "SOL", symbol: "SOL", name: "Solana", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "USDT_TRC20", symbol: "USDT", name: "Tether", network: "TRC-20", logo: "", price_usd: 1, is_stablecoin: true },
  { code: "TRX", symbol: "TRX", name: "TRON", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "BNB", symbol: "BNB", name: "BNB", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "DOGE", symbol: "DOGE", name: "Dogecoin", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "XRP", symbol: "XRP", name: "Ripple", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "TON", symbol: "TON", name: "Toncoin", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "ADA", symbol: "ADA", name: "Cardano", network: "", logo: "", price_usd: 0, is_stablecoin: false },
  { code: "USDC_ERC20", symbol: "USDC", name: "USD Coin", network: "ERC-20", logo: "", price_usd: 1, is_stablecoin: true },
  { code: "USDT_BEP20", symbol: "USDT", name: "Tether", network: "BEP-20", logo: "", price_usd: 1, is_stablecoin: true },
  { code: "USDT_ERC20", symbol: "USDT", name: "Tether", network: "ERC-20", logo: "", price_usd: 1, is_stablecoin: true },
];

/* Brand colors for the fallback badge */
const COIN_COLORS: Record<string, string> = {
  BTC: "#F7931A", ETH: "#627EEA", XMR: "#FF6600", LTC: "#345D9D", SOL: "#9945FF",
  USDT: "#26A17B", USDC: "#2775CA", TRX: "#EF0027", BNB: "#F3BA2F", DOGE: "#C2A633",
  XRP: "#23292F", TON: "#0098EA", ADA: "#0033AD",
};

const CREATION_STEPS = [
  "Creating log group",
  "Setting up accounts",
  "Configuring groups",
  "Finalizing schedule",
  "Your login is ready",
];

export default function PurchaseFlow({ plan, onClose }: { plan: PurchasePlan; onClose: () => void }) {
  const [step, setStep] = useState<Step>("details");

  // reference details
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tgUser, setTgUser] = useState("");
  const [tgId, setTgId] = useState("");
  const [addDetails, setAddDetails] = useState<boolean | null>(null);

  // coupon
  const [coupon, setCoupon] = useState("");
  const [couponPct, setCouponPct] = useState(0);
  const [couponMsg, setCouponMsg] = useState("");
  const [checkingCoupon, setCheckingCoupon] = useState(false);

  // crypto
  const [currencies, setCurrencies] = useState<CryptoCurrency[]>([]);
  const [loadingCur, setLoadingCur] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CryptoCurrency | null>(null);

  // order / payment
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<OrderData | null>(null);
  const [orderErr, setOrderErr] = useState("");
  const [status, setStatus] = useState<StatusData | null>(null);
  const [copied, setCopied] = useState<"addr" | "amt" | "tok" | null>(null);
  const [timeLeft, setTimeLeft] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // creation progress animation
  const [progressIdx, setProgressIdx] = useState(0);

  const price = couponPct > 0 ? +(plan.price * (1 - couponPct / 100)).toFixed(2) : plan.price;
  const per = plan.billing === "month" ? "mo" : "wk";

  /* lock body scroll */
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  /* fetch currencies when entering crypto step */
  const fetchCurrencies = useCallback(async () => {
    if (currencies.length) return;
    setLoadingCur(true);
    try {
      const r = await axios.get(`${API}/api/portal/crypto/currencies`);
      setCurrencies(r.data?.currencies || []);
    } catch { /* still allow */ }
    setLoadingCur(false);
  }, [currencies.length]);

  useEffect(() => { if (step === "crypto") fetchCurrencies(); }, [step, fetchCurrencies]);

  /* coupon */
  const applyCoupon = useCallback(async () => {
    const code = coupon.trim();
    if (!code) { setCouponPct(0); setCouponMsg(""); return; }
    setCheckingCoupon(true);
    try {
      const r = await axios.post(`${API}/api/portal/coupon/validate`, { code });
      if (r.data?.valid) { setCouponPct(r.data.percent); setCouponMsg(`-${r.data.percent}% applied`); }
      else { setCouponPct(0); setCouponMsg("Invalid coupon"); }
    } catch { setCouponPct(0); setCouponMsg("Could not validate"); }
    setCheckingCoupon(false);
  }, [coupon]);

  /* create order + invoice */
  const createOrder = useCallback(async () => {
    if (!selected) return;
    setCreating(true);
    setOrderErr("");
    try {
      const r = await axios.post(`${API}/api/portal/purchase/create`, {
        plan_id: plan.id,
        plan_mode: plan.mode,
        billing: plan.billing,
        currency: selected.code,
        coupon: coupon.trim() || null,
        reference: {
          name: name.trim() || null,
          email: email.trim() || null,
          telegram_username: tgUser.trim() || null,
          telegram_id: tgId.trim() ? Number(tgId.trim()) : null,
        },
      }, { timeout: 30000 });
      setOrder(r.data);
      setStep("pay");
      startPolling(r.data.order_id);
    } catch (e: any) {
      // Surface the real cause so it's debuggable instead of a generic message.
      let msg: string;
      if (e?.response) {
        // Server responded with an error status
        const d = e.response.data?.detail;
        msg = (typeof d === "string" ? d : JSON.stringify(d)) || `Server error (${e.response.status}). Try another coin.`;
      } else if (e?.request) {
        msg = `Can't reach the API at ${API}. Is the backend running? (${e.code || e.message || "network error"})`;
      } else {
        msg = e?.message || "Could not create the order.";
      }
      // eslint-disable-next-line no-console
      console.error("[purchase/create] failed:", { API, status: e?.response?.status, data: e?.response?.data, message: e?.message });
      setOrderErr(msg);
    }
    setCreating(false);
  }, [selected, plan, coupon, name, email, tgUser, tgId]);

  /* poll status */
  const startPolling = useCallback((orderId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      try {
        const r = await axios.get(`${API}/api/portal/purchase/${orderId}/status`);
        setStatus(r.data);
        if (r.data?.payment_confirmed) {
          setStep("creating");
          if (pollRef.current) clearInterval(pollRef.current);
          // keep polling slower for creation completion + access token
          pollRef.current = setInterval(async () => {
            try {
              const r2 = await axios.get(`${API}/api/portal/purchase/${orderId}/status`);
              setStatus(r2.data);
              if (r2.data?.status === "completed" || r2.data?.access_token) {
                if (pollRef.current) clearInterval(pollRef.current);
              }
            } catch { /* silent */ }
          }, 5000);
        }
      } catch { /* silent */ }
    };
    poll();
    pollRef.current = setInterval(poll, 15000);
  }, []);

  /* countdown */
  useEffect(() => {
    if (!order?.invoice_expires_at) return;
    const tick = () => {
      const diff = Math.max(0, Math.floor((new Date(order.invoice_expires_at).getTime() - Date.now()) / 1000));
      if (diff <= 0) { setTimeLeft("Expired"); return; }
      const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60;
      setTimeLeft(`${h > 0 ? h + "h " : ""}${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [order?.invoice_expires_at]);

  /* creation progress animation */
  useEffect(() => {
    if (step !== "creating") return;
    setProgressIdx(0);
    const iv = setInterval(() => setProgressIdx(i => Math.min(i + 1, CREATION_STEPS.length - 1)), 1400);
    return () => clearInterval(iv);
  }, [step]);

  const done = status?.status === "completed" || !!status?.access_token;
  const queued = status?.queued;

  const copy = (text: string, what: "addr" | "amt" | "tok") => {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1800);
  };

  // Always have coins to show: use backend list when present, else the built-in fallback.
  const allCoins = currencies.length ? currencies : FALLBACK_COINS;
  const filtered = allCoins.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q) ||
           c.code.toLowerCase().includes(q) || (c.network || "").toLowerCase().includes(q);
  });
  const topList = allCoins.filter(c => TOP_COINS.includes(c.code))
    .sort((a, b) => TOP_COINS.indexOf(a.code) - TOP_COINS.indexOf(b.code));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 font-body" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="relative w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl border border-[#1f1f22] bg-[#0a0a0a] shadow-2xl pf-scroll">

        {/* header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-[#1f1f22] bg-[#0a0a0a]/95 backdrop-blur">
          <div className="flex items-center gap-2.5">
            {step !== "details" && step !== "creating" && (
              <button onClick={() => setStep(step === "checkout" ? "details" : step === "crypto" ? "checkout" : step === "review" ? "crypto" : "review")} className="text-[#8b8b93] hover:text-white transition-colors" aria-label="Back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <div>
              <p className="text-[14px] font-semibold text-white leading-tight">{plan.label} plan</p>
              <p className="text-[11px] text-[#5d5d66] leading-tight">${price}/{per} · {plan.durationDays} days</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#8b8b93] hover:text-white transition-colors" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* step indicator */}
        {step !== "creating" && (
          <div className="flex items-center gap-1.5 px-5 pt-4">
            {(["details", "checkout", "crypto", "review", "pay"] as Step[]).map((s, i) => {
              const order_ = ["details", "checkout", "crypto", "review", "pay"];
              const cur = order_.indexOf(step);
              const on = i <= cur;
              return <div key={s} className="h-0.5 flex-1 rounded-full transition-colors duration-300" style={{ background: on ? TG : "#1f1f22" }} />;
            })}
          </div>
        )}

        <div className="p-5">
          {/* ── STEP: details ── */}
          {step === "details" && (
            <div className="space-y-5">
              <div>
                <h3 className="text-[18px] font-semibold text-white">Add your details?</h3>
                <p className="text-[13px] text-[#8b8b93] mt-1">Optional — for your receipt and support reference. You can skip it.</p>
              </div>

              <div>
                <label className="text-[11px] text-[#8b8b93] block mb-1.5">What can we call you?</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Alex"
                  className="w-full rounded-lg border border-[#1f1f22] bg-[#101012] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors" />
              </div>

              {addDetails && (
                <div className="space-y-3 pt-1">
                  <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="Email (optional)"
                    className="w-full rounded-lg border border-[#1f1f22] bg-[#101012] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors" />
                  <input value={tgUser} onChange={e => setTgUser(e.target.value)} placeholder="Telegram username (optional)"
                    className="w-full rounded-lg border border-[#1f1f22] bg-[#101012] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors" />
                  <input value={tgId} onChange={e => setTgId(e.target.value)} inputMode="numeric" placeholder="Telegram user ID (optional)"
                    className="w-full rounded-lg border border-[#1f1f22] bg-[#101012] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors" />
                </div>
              )}

              {!addDetails && (
                <button onClick={() => setAddDetails(true)} className="text-[12px] text-[#8b8b93] hover:text-white flex items-center gap-1.5 transition-colors">
                  + Add email / Telegram reference
                </button>
              )}

              <button onClick={() => setStep("checkout")}
                className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-medium text-white py-3 rounded-lg transition-opacity hover:opacity-90" style={{ background: TG }}>
                Continue <ArrowRight className="w-4 h-4" />
              </button>
              <p className="text-[11px] text-[#5d5d66] text-center">No name? We&apos;ll assign a reference like <span className="text-[#8b8b93]">USER-ID</span> automatically.</p>
            </div>
          )}

          {/* ── STEP: checkout ── */}
          {step === "checkout" && (
            <div className="space-y-5">
              <h3 className="text-[18px] font-semibold text-white">Order summary</h3>

              <div className="rounded-lg border border-[#1f1f22] bg-[#101012] divide-y divide-[#1f1f22]">
                <Row label={`${plan.label} — ${plan.durationDays} days`} value={`$${plan.price.toFixed(2)}`} />
                <Row label="Reach / day" value={plan.reach} muted />
                <Row label="Posts / day" value={plan.posts} muted />
                <Row label="Replacements" value={plan.replacements} muted />
                {couponPct > 0 && <Row label={`Coupon ${coupon.toUpperCase()}`} value={`-${couponPct}%`} accent />}
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px] font-semibold text-white">Total</span>
                  <span className="text-[18px] font-semibold text-white tabular-nums">${price.toFixed(2)}</span>
                </div>
              </div>

              {/* coupon */}
              <div>
                <label className="text-[11px] text-[#8b8b93] block mb-1.5">Have a coupon?</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5d5d66]" />
                    <input value={coupon} onChange={e => { setCoupon(e.target.value); setCouponMsg(""); }} placeholder="Enter code"
                      className="w-full rounded-lg border border-[#1f1f22] bg-[#101012] pl-9 pr-3 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors uppercase" />
                  </div>
                  <button onClick={applyCoupon} disabled={checkingCoupon}
                    className="px-4 rounded-lg border border-[#1f1f22] text-[12px] font-medium text-[#c9c9cf] hover:text-white hover:border-[#3d3d44] transition-colors disabled:opacity-50">
                    {checkingCoupon ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Apply"}
                  </button>
                </div>
                {couponMsg && <p className={`text-[11px] mt-1.5 ${couponPct > 0 ? "text-emerald-400" : "text-[#8b8b93]"}`}>{couponMsg}</p>}
              </div>

              {/* details recap + edit */}
              <div className="rounded-lg border border-[#1f1f22] bg-[#101012] px-4 py-3 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-[11px] text-[#5d5d66]">Reference</p>
                  <p className="text-[13px] text-white truncate">{name || tgUser || email || "Auto (USER-ID)"}</p>
                </div>
                <button onClick={() => setStep("details")} className="text-[12px] text-[#8b8b93] hover:text-white flex items-center gap-1 transition-colors flex-shrink-0">
                  Edit <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <button onClick={() => setStep("crypto")}
                className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-medium text-white py-3 rounded-lg transition-opacity hover:opacity-90" style={{ background: TG }}>
                <Wallet className="w-4 h-4" /> Choose crypto
              </button>
            </div>
          )}

          {/* ── STEP: crypto ── */}
          {step === "crypto" && (
            <div className="space-y-4">
              <h3 className="text-[18px] font-semibold text-white">Choose how to pay</h3>

              <>
                {!search && topList.length > 0 && (
                  <div>
                    <p className="text-[10px] text-[#5d5d66] uppercase tracking-wider mb-2 flex items-center gap-2">
                      Popular {loadingCur && <Loader2 className="w-3 h-3 animate-spin" style={{ color: TG }} />}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {topList.map(c => <CoinTile key={c.code} c={c} onClick={() => { setSelected(c); setStep("review"); }} />)}
                    </div>
                  </div>
                )}

                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#5d5d66]" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all coins…"
                    className="w-full rounded-lg border border-[#1f1f22] bg-[#101012] pl-9 pr-3 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#2AABEE]/50 transition-colors" />
                </div>

                <div className="max-h-[300px] overflow-y-auto -mx-1 px-1 space-y-1.5 pf-scroll">
                  <p className="text-[10px] text-[#5d5d66] uppercase tracking-wider mb-1 px-1">{search ? "Results" : "All coins"}</p>
                  {filtered.map(c => (
                    <button key={c.code} onClick={() => { setSelected(c); setStep("review"); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[#1f1f22] bg-[#101012] hover:border-[#3d3d44] hover:bg-[#141417] transition-colors text-left">
                      <CoinLogo c={c} size={28} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] text-white truncate">{c.name} <span className="text-[#5d5d66]">{c.symbol}</span></p>
                        {c.network && <p className="text-[10px] text-[#5d5d66]">{c.network}</p>}
                      </div>
                      <ChevronRight className="w-4 h-4 text-[#3d3d44]" />
                    </button>
                  ))}
                  {search && filtered.length === 0 && <p className="text-center text-[12px] text-[#5d5d66] py-6">No coins match “{search}”.</p>}
                </div>
              </>
            </div>
          )}

          {/* ── STEP: review ── */}
          {step === "review" && selected && (
            <div className="space-y-5">
              <h3 className="text-[18px] font-semibold text-white">Review &amp; pay</h3>

              <div className="rounded-lg border border-[#1f1f22] bg-[#101012] divide-y divide-[#1f1f22]">
                <Row label="Plan" value={`${plan.label} (${plan.mode})`} />
                <Row label="Validity" value={`${plan.durationDays} days`} muted />
                <Row label="Reference" value={name || tgUser || email || "Auto (USER-ID)"} muted />
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[12px] text-[#8b8b93]">Pay with</span>
                  <span className="flex items-center gap-2 text-[13px] text-white">
                    <CoinLogo c={selected} size={20} /> {selected.symbol}{selected.network ? ` · ${selected.network}` : ""}
                  </span>
                </div>
                {couponPct > 0 && <Row label={`Coupon ${coupon.toUpperCase()}`} value={`-${couponPct}%`} accent />}
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-[13px] font-semibold text-white">Total</span>
                  <span className="text-[18px] font-semibold text-white tabular-nums">${price.toFixed(2)}</span>
                </div>
              </div>

              {orderErr && (
                <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5">
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-[12px] text-red-400">{orderErr}</p>
                </div>
              )}

              <button onClick={createOrder} disabled={creating}
                className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-medium text-white py-3 rounded-lg transition-opacity hover:opacity-90 disabled:opacity-60" style={{ background: TG }}>
                {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating invoice…</> : <>Pay ${price.toFixed(2)} <ArrowRight className="w-4 h-4" /></>}
              </button>
            </div>
          )}

          {/* ── STEP: pay ── */}
          {step === "pay" && order && selected && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[18px] font-semibold text-white">Send payment</h3>
                <span className={`flex items-center gap-1.5 text-[12px] font-medium tabular-nums ${timeLeft === "Expired" ? "text-red-400" : ""}`} style={timeLeft !== "Expired" ? { color: TG } : undefined}>
                  <Clock className="w-3.5 h-3.5" /> {timeLeft || "—"}
                </span>
              </div>

              {/* QR */}
              <div className="flex justify-center">
                <div className="rounded-xl bg-white p-3">
                  <img
                    alt="Payment QR"
                    width={170} height={170}
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=170x170&margin=0&data=${encodeURIComponent(order.pay_address)}`}
                  />
                </div>
              </div>

              {/* amount */}
              <div className="rounded-lg border border-[#1f1f22] bg-[#101012] p-4 space-y-3">
                <div>
                  <p className="text-[10px] text-[#5d5d66] uppercase tracking-wider mb-1">Send exactly</p>
                  <div className="flex items-center justify-between">
                    <span className="text-[18px] font-semibold text-white tabular-nums">{order.pay_amount} <span className="text-[13px] text-[#8b8b93]">{order.pay_currency}</span></span>
                    <button onClick={() => copy(String(order.pay_amount), "amt")} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium" style={{ background: "rgba(42,171,238,0.12)", color: TG }}>
                      {copied === "amt" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {copied === "amt" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
                <div className="border-t border-[#1f1f22] pt-3">
                  <p className="text-[10px] text-[#5d5d66] uppercase tracking-wider mb-1">To address {selected.network ? `(${selected.network})` : ""}</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 text-[11px] text-white font-mono break-all bg-[#0a0a0a] rounded px-2.5 py-2 border border-[#1f1f22]">{order.pay_address}</code>
                    <button onClick={() => copy(order.pay_address, "addr")} className="flex-shrink-0 flex items-center gap-1 px-2.5 py-2 rounded text-[11px] font-medium" style={{ background: "rgba(42,171,238,0.12)", color: TG }}>
                      {copied === "addr" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* warning */}
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/[0.07] border border-amber-500/15 px-3 py-2.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-400/90 leading-relaxed">
                  Send the <strong>exact</strong> amount{selected.network ? <> on the <strong>{selected.network}</strong> network</> : null}. Underpayment delays detection.
                </p>
              </div>

              {/* status */}
              <div className="rounded-lg border border-[#1f1f22] bg-[#101012] px-4 py-3 flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: TG }} />
                <div className="flex-1">
                  <p className="text-[12px] text-white">Waiting for payment…</p>
                  <p className="text-[11px] text-[#5d5d66]">
                    {status?.underpaid
                      ? `Received ${status.amount_received} ${order.pay_currency} — please send the rest.`
                      : status?.amount_received
                      ? `Received ${status.amount_received} ${order.pay_currency} — confirming…`
                      : "Detected automatically once it lands."}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── STEP: creating ── */}
          {step === "creating" && (
            <div className="space-y-5 py-2">
              {!done ? (
                <>
                  <div className="text-center">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: "rgba(42,171,238,0.12)" }}>
                      <Sparkles className="w-6 h-6" style={{ color: TG }} />
                    </div>
                    <h3 className="text-[18px] font-semibold text-white">Payment confirmed</h3>
                    <p className="text-[13px] text-[#8b8b93] mt-1">
                      {queued ? "You're in the queue — we'll provision your bot shortly." : "Creating your AdBot · est. ~1 min"}
                    </p>
                  </div>

                  {queued ? (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-[12px] text-amber-400">
                      All bots are currently assigned. Your AdBot creation is queued and will start automatically once a slot frees up.
                    </div>
                  ) : (
                    <div className="rounded-lg border border-[#1f1f22] bg-[#101012] p-4 space-y-2.5">
                      {CREATION_STEPS.map((s, i) => {
                        const state = i < progressIdx ? "done" : i === progressIdx ? "active" : "todo";
                        return (
                          <div key={s} className="flex items-center gap-2.5">
                            {state === "done" ? <CheckCheck className="w-4 h-4" style={{ color: TG }} />
                              : state === "active" ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: TG }} />
                              : <span className="w-4 h-4 rounded-full border border-[#1f1f22] inline-block" />}
                            <span className={`text-[13px] ${state === "todo" ? "text-[#5d5d66]" : "text-white"}`}>{s}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center space-y-4">
                  <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto" style={{ background: "rgba(42,171,238,0.12)" }}>
                    <Check className="w-7 h-7" style={{ color: TG }} />
                  </div>
                  <div>
                    <h3 className="text-[20px] font-semibold text-white">Your AdBot is ready</h3>
                    <p className="text-[13px] text-[#8b8b93] mt-1">Use the access token below to log into your dashboard.</p>
                  </div>
                  {status?.access_token && (
                    <div className="rounded-lg border border-[#1f1f22] bg-[#101012] p-4">
                      <p className="text-[10px] text-[#5d5d66] uppercase tracking-wider mb-1.5">Access token</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-[14px] font-mono text-white break-all">{status.access_token}</code>
                        <button onClick={() => copy(status.access_token, "tok")} className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium" style={{ background: "rgba(42,171,238,0.12)", color: TG }}>
                          {copied === "tok" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>
                  )}
                  <a href="/user/login" className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-medium text-white py-3 rounded-lg transition-opacity hover:opacity-90" style={{ background: TG }}>
                    Open dashboard <ArrowRight className="w-4 h-4" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <style jsx global>{`
        .pf-scroll::-webkit-scrollbar { width: 5px; }
        .pf-scroll::-webkit-scrollbar-thumb { background: #27272a; border-radius: 9999px; }
      `}</style>
    </div>
  );
}

/* ── sub-components ── */
function Row({ label, value, muted, accent }: { label: string; value: string; muted?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-[12px] text-[#8b8b93]">{label}</span>
      <span className="text-[13px] tabular-nums" style={accent ? { color: TG } : { color: muted ? "#c9c9cf" : "#fff" }}>{value}</span>
    </div>
  );
}

function CoinLogo({ c, size }: { c: CryptoCurrency; size: number }) {
  const [failed, setFailed] = useState(false);
  const apiLogo = c.logo?.startsWith("/coin-img/") ? `${API}${c.logo}` : c.logo;
  // Public colored crypto-icon CDN keyed by lowercase symbol; reliable without backend.
  const cdn = `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/${c.symbol.toLowerCase()}.png`;
  const src = apiLogo || cdn;
  if (failed || !src) {
    const color = COIN_COLORS[c.symbol] || TG;
    return (
      <span className="rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
        style={{ width: size, height: size, background: `${color}22`, color }}>
        {c.symbol.slice(0, 3)}
      </span>
    );
  }
  return (
    <img src={src} alt={c.symbol} width={size} height={size} onError={() => setFailed(true)}
      className="rounded-full flex-shrink-0" style={{ width: size, height: size }} />
  );
}

function CoinTile({ c, onClick }: { c: CryptoCurrency; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 p-3 rounded-lg border border-[#1f1f22] bg-[#101012] hover:border-[#3d3d44] hover:bg-[#141417] transition-colors">
      <CoinLogo c={c} size={28} />
      <span className="text-[11px] font-medium text-white">{c.symbol}</span>
      {c.network && <span className="text-[9px] text-[#5d5d66] -mt-1">{c.network}</span>}
    </button>
  );
}
