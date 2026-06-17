"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Modal from "@/components/ui/Modal";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import {
  ArrowLeft, Copy, Check, Loader2, ExternalLink, Clock,
  AlertTriangle, CheckCircle, Search, ChevronRight, XCircle,
} from "lucide-react";

/* ═══════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════ */

interface CryptoCurrency {
  code: string;
  symbol: string;
  name: string;
  network: string;
  logo: string;
  price_usd: number;
  is_stablecoin: boolean;
}

interface InvoiceData {
  payment_id: string;
  pay_address: string;
  pay_amount: number;
  pay_currency: string;
  amount_usd: number;
  invoice_expiry: string;
  invoice_expires_at: string;
  entry_id: string;
}

interface PaymentStatusData {
  status: string;
  payment_confirmed: boolean;
  payment_status?: string;
  amount_received?: number;
  pay_amount?: number;
  tx_hash?: string;
  explorer_link?: string;
  message?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  entryId: string;
  sessionName: string;
  amountUsd: number;
  onPaymentConfirmed: () => void;
}

/* ═══════════════════════════════════════════════════════
   CATEGORY GROUPING
   ═══════════════════════════════════════════════════════ */

const MAIN_COINS = ["BTC", "ETH", "SOL", "BNB", "XMR", "LTC", "TRX", "DOGE", "TON", "ADA", "XRP", "MATIC"];

function groupCurrencies(currencies: CryptoCurrency[]) {
  const main: CryptoCurrency[] = [];
  const usdt: CryptoCurrency[] = [];
  const usdc: CryptoCurrency[] = [];
  for (const c of currencies) {
    if (c.code.startsWith("USDT_")) usdt.push(c);
    else if (c.code.startsWith("USDC_")) usdc.push(c);
    else main.push(c);
  }
  // Sort main by MAIN_COINS order
  main.sort((a, b) => {
    const ai = MAIN_COINS.indexOf(a.code);
    const bi = MAIN_COINS.indexOf(b.code);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return { main, usdt, usdc };
}

/* ═══════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════ */

export default function CryptoPaymentModal({
  open, onClose, entryId, sessionName, amountUsd, onPaymentConfirmed,
}: Props) {
  // Steps: "select" → "paying" → "confirmed"
  const [step, setStep] = useState<"select" | "paying" | "confirmed">("select");
  const [currencies, setCurrencies] = useState<CryptoCurrency[]>([]);
  const [loadingCurrencies, setLoadingCurrencies] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedGroup, setExpandedGroup] = useState<"usdt" | "usdc" | null>(null);

  // Invoice / payment
  const [selectedCurrency, setSelectedCurrency] = useState<CryptoCurrency | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [invoiceError, setInvoiceError] = useState("");
  const [copied, setCopied] = useState<"address" | "amount" | null>(null);

  // Payment polling
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusData | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Timer
  const [timeLeft, setTimeLeft] = useState("");

  // Reset on open
  useEffect(() => {
    if (open) {
      setStep("select");
      setCurrencies([]);
      setSearch("");
      setExpandedGroup(null);
      setSelectedCurrency(null);
      setInvoice(null);
      setInvoiceError("");
      setPaymentStatus(null);
      fetchCurrencies();
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open]);

  /* ── Fetch currencies ── */
  const fetchCurrencies = useCallback(async () => {
    setLoadingCurrencies(true);
    try {
      const r = await portalApi.get("/api/portal/crypto/currencies");
      setCurrencies(r.data?.currencies || []);
    } catch {
      // If CoinGecko fails, still show currencies without logos
    }
    setLoadingCurrencies(false);
  }, []);

  /* ── Create invoice ── */
  const selectCoin = useCallback(async (currency: CryptoCurrency) => {
    const s = getPortalSession();
    if (!s?.bot_name || s?.telegram_id == null) return;

    setSelectedCurrency(currency);
    setCreatingInvoice(true);
    setInvoiceError("");

    try {
      const r = await portalApi.post(
        `/api/portal/bot/${s.bot_name}/replacement/pay?telegram_id=${s.telegram_id}`,
        { entry_id: entryId, currency: currency.code },
        { timeout: 30000 }
      );
      setInvoice(r.data);
      setStep("paying");
      // Start polling
      startPolling();
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || "Failed to create invoice";
      // If already paid, show success state instead of error
      if (detail.includes("already paid") || detail.includes("already been completed")) {
        setStep("confirmed");
        onPaymentConfirmed();
        setCreatingInvoice(false);
        return;
      }
      setInvoiceError(detail);
    }
    setCreatingInvoice(false);
  }, [entryId, onPaymentConfirmed]);

  /* ── Poll payment status ── */
  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const poll = async () => {
      const s = getPortalSession();
      if (!s?.bot_name || s?.telegram_id == null) return;
      try {
        const r = await portalApi.get(
          `/api/portal/bot/${s.bot_name}/replacement/${entryId}/status?telegram_id=${s.telegram_id}`
        );
        setPaymentStatus(r.data);
        if (r.data?.payment_confirmed) {
          if (pollRef.current) clearInterval(pollRef.current);
          setStep("confirmed");
          onPaymentConfirmed();
        }
      } catch { /* silent */ }
    };
    poll(); // immediate first check
    pollRef.current = setInterval(poll, 15000); // then every 15s
  }, [entryId, onPaymentConfirmed]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  /* ── Countdown timer ── */
  useEffect(() => {
    if (!invoice?.invoice_expires_at) return;
    const tick = () => {
      const exp = new Date(invoice.invoice_expires_at).getTime();
      const now = Date.now();
      const diff = Math.max(0, Math.floor((exp - now) / 1000));
      if (diff <= 0) { setTimeLeft("Expired"); return; }
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const sec = diff % 60;
      setTimeLeft(`${h}h ${m.toString().padStart(2, "0")}m ${sec.toString().padStart(2, "0")}s`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [invoice?.invoice_expires_at]);

  /* ── Copy helper ── */
  const copyText = useCallback((text: string, type: "address" | "amount") => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  /* ── Filter currencies ── */
  const filteredCurrencies = currencies.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.name.toLowerCase().includes(q) ||
           c.symbol.toLowerCase().includes(q) ||
           c.code.toLowerCase().includes(q) ||
           (c.network && c.network.toLowerCase().includes(q));
  });
  const groups = groupCurrencies(filteredCurrencies);

  /* ═══════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════ */

  return (
    <Modal open={open} onClose={onClose} title="" size="md">
      {/* ── STEP 1: Select cryptocurrency ── */}
      {step === "select" && (
        <div className="space-y-4">
          {/* Header */}
          <div className="text-center pb-2">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-amber-400/20 to-orange-500/20 border border-amber-500/20 flex items-center justify-center mx-auto mb-3">
              <svg className="h-6 w-6 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v12M9 9h4.5a2.5 2.5 0 010 5H9" />
              </svg>
            </div>
            <h3 className="text-base font-bold text-dark-100">Pay with Crypto</h3>
            <p className="text-[11px] text-dark-500 mt-1">
              Replace <span className="text-dark-300 font-semibold">{sessionName}</span> — <span className="text-amber-400 font-bold">${amountUsd.toFixed(2)}</span>
            </p>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-dark-600" />
            <input
              type="text"
              placeholder="Search coins..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-white/[0.06] bg-dark-800/60 pl-9 pr-3 py-2.5 text-[12px] text-dark-200 placeholder-dark-600 focus:border-accent/40 outline-none transition-colors"
            />
          </div>

          {loadingCurrencies ? (
            <div className="flex flex-col items-center py-10">
              <Loader2 className="h-6 w-6 text-accent animate-spin" />
              <p className="text-[11px] text-dark-500 mt-2">Loading currencies...</p>
            </div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto -mx-1 px-1 space-y-3">
              {/* Main coins grid */}
              {groups.main.length > 0 && (
                <div>
                  <p className="text-[9px] font-bold text-dark-500 uppercase tracking-wider mb-2">Popular</p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {groups.main.map((c) => (
                      <CoinButton key={c.code} coin={c} onClick={() => selectCoin(c)} disabled={creatingInvoice} />
                    ))}
                  </div>
                </div>
              )}

              {/* USDT networks */}
              {groups.usdt.length > 0 && (
                <StablecoinGroup
                  label="USDT" symbol="Tether"
                  coins={groups.usdt}
                  expanded={expandedGroup === "usdt"}
                  onToggle={() => setExpandedGroup(expandedGroup === "usdt" ? null : "usdt")}
                  onSelect={selectCoin}
                  disabled={creatingInvoice}
                  logo={groups.usdt[0]?.logo}
                />
              )}

              {/* USDC networks */}
              {groups.usdc.length > 0 && (
                <StablecoinGroup
                  label="USDC" symbol="USD Coin"
                  coins={groups.usdc}
                  expanded={expandedGroup === "usdc"}
                  onToggle={() => setExpandedGroup(expandedGroup === "usdc" ? null : "usdc")}
                  onSelect={selectCoin}
                  disabled={creatingInvoice}
                  logo={groups.usdc[0]?.logo}
                />
              )}

              {filteredCurrencies.length === 0 && (
                <p className="text-center text-[11px] text-dark-500 py-6">No currencies match your search</p>
              )}
            </div>
          )}

          {/* Invoice creation error */}
          {invoiceError && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2.5 flex items-start gap-2">
              <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-400 font-medium">{invoiceError}</p>
            </div>
          )}

          {/* Creating invoice overlay */}
          {creatingInvoice && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="h-4 w-4 text-accent animate-spin" />
              <p className="text-[11px] text-dark-400">Creating invoice for {selectedCurrency?.name}...</p>
            </div>
          )}
        </div>
      )}

      {/* ── STEP 2: Payment screen ── */}
      {step === "paying" && invoice && selectedCurrency && (
        <div className="space-y-4">
          {/* Back button */}
          <button
            onClick={() => { setStep("select"); setInvoice(null); if (pollRef.current) clearInterval(pollRef.current); }}
            className="flex items-center gap-1.5 text-[11px] text-dark-500 hover:text-dark-300 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Choose different coin
          </button>

          {/* Coin header */}
          <div className="flex items-center gap-3 rounded-xl bg-dark-800/40 border border-white/[0.04] p-3">
            {selectedCurrency.logo ? (
              <img src={selectedCurrency.logo} alt={selectedCurrency.symbol} className="h-10 w-10 rounded-full" />
            ) : (
              <div className="h-10 w-10 rounded-full bg-accent/20 flex items-center justify-center text-accent font-bold text-sm">
                {selectedCurrency.symbol.slice(0, 2)}
              </div>
            )}
            <div>
              <p className="text-[14px] font-bold text-dark-100">
                Send {selectedCurrency.symbol}
                {selectedCurrency.network && (
                  <span className="text-[10px] font-semibold text-dark-500 ml-1.5">({selectedCurrency.network})</span>
                )}
              </p>
              <p className="text-[11px] text-dark-500">
                For: {sessionName} — ${amountUsd.toFixed(2)} USD
              </p>
            </div>
          </div>

          {/* Timer */}
          <div className="flex items-center justify-between rounded-lg bg-amber-500/[0.06] border border-amber-500/15 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[10px] font-semibold text-amber-400">Time remaining</span>
            </div>
            <span className={`text-[12px] font-bold tabular-nums ${timeLeft === "Expired" ? "text-red-400" : "text-amber-300"}`}>
              {timeLeft || "—"}
            </span>
          </div>

          {/* Amount to send */}
          <div className="rounded-xl bg-dark-800/60 border border-white/[0.06] p-4 space-y-3">
            <div>
              <p className="text-[9px] font-bold text-dark-500 uppercase tracking-wider mb-1">Amount to send</p>
              <div className="flex items-center justify-between">
                <span className="text-xl font-bold text-dark-50 tabular-nums">
                  {invoice.pay_amount}
                  <span className="text-sm text-dark-400 font-semibold ml-1.5">{invoice.pay_currency.toUpperCase()}</span>
                </span>
                <button
                  onClick={() => copyText(String(invoice.pay_amount), "amount")}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                >
                  {copied === "amount" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied === "amount" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <div className="border-t border-white/[0.04] pt-3">
              <p className="text-[9px] font-bold text-dark-500 uppercase tracking-wider mb-1">Send to address</p>
              <div className="flex items-start gap-2">
                <code className="flex-1 text-[11px] text-emerald-400 font-mono break-all bg-dark-900/50 rounded-lg px-2.5 py-2 border border-emerald-500/10">
                  {invoice.pay_address}
                </code>
                <button
                  onClick={() => copyText(invoice.pay_address, "address")}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-2 rounded-lg text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors border border-emerald-500/10"
                >
                  {copied === "address" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied === "address" ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          </div>

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/10 px-3 py-2.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[10px] text-amber-400/80 leading-relaxed">
              Send <strong>exactly</strong> the amount shown above. Sending less may result in a failed payment.
              {selectedCurrency.network && (
                <> Make sure you send on the <strong>{selectedCurrency.network}</strong> network.</>
              )}
            </p>
          </div>

          {/* Payment status indicator */}
          <div className="rounded-xl bg-dark-800/30 border border-white/[0.04] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="h-8 w-8 rounded-full bg-accent/10 flex items-center justify-center">
                  <Loader2 className="h-4 w-4 text-accent animate-spin" />
                </div>
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse" />
              </div>
              <div>
                <p className="text-[12px] font-semibold text-dark-200">Waiting for payment...</p>
                <p className="text-[10px] text-dark-500">
                  {paymentStatus?.amount_received && paymentStatus.amount_received > 0
                    ? `Received: ${paymentStatus.amount_received} ${invoice.pay_currency.toUpperCase()} — confirming...`
                    : "We'll detect your payment automatically"}
                </p>
              </div>
            </div>
            {paymentStatus?.tx_hash && (
              <div className="mt-2.5 pt-2.5 border-t border-white/[0.04] flex items-center justify-between">
                <span className="text-[9px] text-dark-500">TX: {paymentStatus.tx_hash.slice(0, 16)}...</span>
                {paymentStatus.explorer_link && (
                  <a
                    href={paymentStatus.explorer_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[9px] text-accent hover:text-accent/80"
                  >
                    View on Explorer <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 3: Payment confirmed ── */}
      {step === "confirmed" && (
        <div className="text-center py-6 space-y-4">
          <div className="h-16 w-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center mx-auto">
            <CheckCircle className="h-8 w-8 text-emerald-400" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-emerald-300">Payment Confirmed!</h3>
            <p className="text-[12px] text-dark-400 mt-1.5 max-w-xs mx-auto">
              Your payment has been verified. The session replacement for <strong className="text-dark-200">{sessionName}</strong> is now being processed.
            </p>
          </div>
          {paymentStatus?.tx_hash && (
            <div className="inline-flex items-center gap-2 rounded-lg bg-dark-800/60 border border-white/[0.06] px-3 py-2">
              <span className="text-[10px] text-dark-500 font-mono">{paymentStatus.tx_hash.slice(0, 20)}...</span>
              {paymentStatus?.explorer_link && (
                <a
                  href={paymentStatus.explorer_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-accent hover:text-accent/80 flex items-center gap-0.5"
                >
                  Explorer <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
          )}
          <button
            onClick={onClose}
            className="mt-2 px-6 py-2.5 rounded-xl text-[12px] font-bold bg-emerald-500 text-white hover:bg-emerald-600 shadow-lg shadow-emerald-500/25 transition-all"
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════ */

function CoinButton({ coin, onClick, disabled }: { coin: CryptoCurrency; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col items-center gap-1.5 p-3 rounded-xl border border-white/[0.04] bg-dark-800/30 hover:bg-dark-800/60 hover:border-accent/20 disabled:opacity-40 transition-all cursor-pointer"
    >
      {coin.logo ? (
        <img src={coin.logo} alt={coin.symbol} className="h-8 w-8 rounded-full group-hover:scale-110 transition-transform" />
      ) : (
        <div className="h-8 w-8 rounded-full bg-accent/10 flex items-center justify-center text-accent text-[10px] font-bold">
          {coin.symbol.slice(0, 3)}
        </div>
      )}
      <div className="text-center">
        <p className="text-[11px] font-bold text-dark-200 group-hover:text-dark-50 transition-colors">{coin.symbol}</p>
        <p className="text-[8px] text-dark-600">{coin.name}</p>
      </div>
    </button>
  );
}

function StablecoinGroup({
  label, symbol, coins, expanded, onToggle, onSelect, disabled, logo,
}: {
  label: string;
  symbol: string;
  coins: CryptoCurrency[];
  expanded: boolean;
  onToggle: () => void;
  onSelect: (c: CryptoCurrency) => void;
  disabled: boolean;
  logo: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.04] bg-dark-800/20 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-dark-800/40 transition-colors cursor-pointer"
      >
        {logo ? (
          <img src={logo} alt={label} className="h-7 w-7 rounded-full" />
        ) : (
          <div className="h-7 w-7 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 text-[9px] font-bold">
            {label.slice(0, 2)}
          </div>
        )}
        <div className="flex-1 text-left">
          <p className="text-[12px] font-bold text-dark-200">{label}</p>
          <p className="text-[9px] text-dark-500">{symbol} — {coins.length} networks</p>
        </div>
        <ChevronRight className={`h-4 w-4 text-dark-500 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="border-t border-white/[0.04] px-2 py-2 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {coins.map((c) => (
            <button
              key={c.code}
              onClick={() => onSelect(c)}
              disabled={disabled}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dark-800/40 hover:bg-dark-800/80 border border-white/[0.03] hover:border-accent/20 disabled:opacity-40 transition-all cursor-pointer"
            >
              <span className="text-[11px] font-bold text-dark-200">{c.network || c.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
