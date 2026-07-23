"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Modal from "@/components/ui/Modal";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import {
  Copy, Check, Loader2, ExternalLink, Clock,
  AlertTriangle, CheckCircle, Search, ChevronRight, XCircle, X,
} from "lucide-react";

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   TYPES
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
  replacement_count?: number;
  sessions?: string[];
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
  job?: ReplacementJob | null;
}

interface ReplacementTimelineEvent {
  at: string;
  stage: string;
  message: string;
  status: string;
}

interface ReplacementItem {
  id: string;
  session_file: string;
  real_name?: string;
  new_session_file?: string;
  status: string;
  stage?: string;
  stage_message?: string;
  progress?: number;
  timeline?: ReplacementTimelineEvent[];
  chatlist_result?: {
    configured: number;
    joined: number;
    failed: number;
    errors?: string[];
  };
}

interface ReplacementJob {
  job_id: string;
  status: string;
  progress: number;
  total: number;
  completed: number;
  awaiting_inventory: number;
  items: ReplacementItem[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  entryId: string;
  sessionName: string;
  amountUsd: number;
  replacementCount?: number;
  onPaymentConfirmed: () => void;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CATEGORY GROUPING
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   COMPONENT
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

export default function CryptoPaymentModal({
  open, onClose, entryId, sessionName, amountUsd, replacementCount = 1, onPaymentConfirmed,
}: Props) {
  // Steps: "select" â†’ "paying" â†’ "confirmed"
  const [step, setStep] = useState<"select" | "paying" | "confirmed">("select");
  const [currencies, setCurrencies] = useState<CryptoCurrency[]>([]);
  const [loadingCurrencies, setLoadingCurrencies] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedGroup, setExpandedGroup] = useState<"usdt" | "usdc" | null>(null);

  // Invoice / payment
  const [selectedCurrency, setSelectedCurrency] = useState<CryptoCurrency | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [resumingInvoice, setResumingInvoice] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [invoiceError, setInvoiceError] = useState("");
  const [copied, setCopied] = useState<"address" | "amount" | null>(null);

  // Payment polling
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatusData | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const confirmationNotifiedRef = useRef(false);

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
      setResumingInvoice(true);
      confirmationNotifiedRef.current = false;
      fetchCurrencies();
      const s = getPortalSession();
      if (s?.bot_name && s?.telegram_id != null && entryId) {
        portalApi.get(
          `/api/portal/bot/${s.bot_name}/replacement/${entryId}/invoice?telegram_id=${s.telegram_id}`
        ).then((response) => {
          const active = response.data;
          if (!active?.active) return;
          const payCurrency = String(active.pay_currency || "").toUpperCase();
          setInvoice(active);
          setSelectedCurrency({
            code: payCurrency,
            symbol: payCurrency.replace(/(TRC20|BEP20|ERC20|SOL|POLYGON)$/i, "") || payCurrency,
            name: payCurrency,
            network: "",
            logo: "",
            price_usd: 0,
            is_stablecoin: false,
          });
          setStep("paying");
          startPolling();
        }).catch(() => {
          // No active invoice: the user can choose a currency normally.
        }).finally(() => setResumingInvoice(false));
      } else {
        setResumingInvoice(false);
      }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, entryId]);

  /* â”€â”€ Fetch currencies â”€â”€ */
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

  /* â”€â”€ Create invoice â”€â”€ */
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

  /* â”€â”€ Poll payment status â”€â”€ */
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
          setStep("confirmed");
          if (!confirmationNotifiedRef.current) {
            confirmationNotifiedRef.current = true;
            onPaymentConfirmed();
          }
          if (r.data?.job?.status === "completed" && pollRef.current) {
            clearInterval(pollRef.current);
          }
        }
      } catch { /* silent */ }
    };
    poll(); // immediate first check
    pollRef.current = setInterval(poll, 3000);
  }, [entryId, onPaymentConfirmed]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const jobId = paymentStatus?.job?.job_id;
    const s = getPortalSession();
    if (!open || !jobId || !s?.access_token || wsRef.current) return;
    const base = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");
    const ws = new WebSocket(
      `${base}/ws/replacements/${encodeURIComponent(jobId)}?token=${encodeURIComponent(s.access_token)}`
    );
    ws.onmessage = async () => {
      try {
        const latest = await portalApi.get(
          `/api/portal/bot/${s.bot_name}/replacement-jobs/${jobId}?telegram_id=${s.telegram_id}`
        );
        setPaymentStatus((current) => current ? { ...current, job: latest.data } : current);
      } catch {
        // Polling remains the reconnect-safe fallback.
      }
    };
    ws.onclose = () => { wsRef.current = null; };
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [open, paymentStatus?.job?.job_id]);

  /* â”€â”€ Countdown timer â”€â”€ */
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

  /* â”€â”€ Copy helper â”€â”€ */
  const copyText = useCallback((text: string, type: "address" | "amount") => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  /* â”€â”€ Filter currencies â”€â”€ */
  const filteredCurrencies = currencies.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.name.toLowerCase().includes(q) ||
           c.symbol.toLowerCase().includes(q) ||
           c.code.toLowerCase().includes(q) ||
           (c.network && c.network.toLowerCase().includes(q));
  });
  const groups = groupCurrencies(filteredCurrencies);

  /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     RENDER
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

  return (
    <Modal open={open} onClose={onClose} title="" size="md">
      {step === "select" && resumingInvoice && (
        <div className="flex min-h-56 flex-col items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
          <p className="mt-3 text-[12px] font-medium text-dark-300">Checking for an active invoiceâ€¦</p>
          <p className="mt-1 text-[10px] text-dark-500">You will keep the same address if one already exists.</p>
        </div>
      )}
      {/* â”€â”€ STEP 1: Select cryptocurrency â”€â”€ */}
      {step === "select" && !resumingInvoice && (
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
              Replace <span className="text-dark-300 font-semibold">{replacementCount > 1 ? `${replacementCount} sessions` : sessionName}</span> â€” <span className="text-amber-400 font-bold">${(amountUsd * replacementCount).toFixed(2)}</span>
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

      {/* â”€â”€ STEP 2: Payment screen â”€â”€ */}
      {step === "paying" && invoice && selectedCurrency && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-bold text-dark-100">Complete payment</h3>
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[9px] font-semibold text-amber-300">Invoice active</span>
              </div>
              <p className="mt-1 text-[10px] text-dark-500">Closing this window will not cancel or change this invoice.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close payment"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dark-500 hover:bg-white/[0.05] hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Coin header */}
          <div className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-dark-800/35 p-3">
            {selectedCurrency.logo ? (
              <img src={selectedCurrency.logo} alt={selectedCurrency.symbol} className="h-9 w-9 rounded-full" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/10 text-[11px] font-bold text-amber-300">
                {selectedCurrency.symbol.slice(0, 2)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-dark-100">
                {(invoice.pay_currency || selectedCurrency.symbol).toUpperCase()}
                {selectedCurrency.network && <span className="ml-1.5 text-[9px] font-semibold text-dark-500">{selectedCurrency.network}</span>}
              </p>
              <p className="mt-0.5 text-[10px] text-dark-500">
                ${Number(invoice.amount_usd || amountUsd).toFixed(2)} for {invoice.replacement_count || replacementCount} account{(invoice.replacement_count || replacementCount) === 1 ? "" : "s"}
              </p>
            </div>
            <span className="text-[9px] font-mono text-dark-600">#{invoice.payment_id}</span>
          </div>

          {(invoice.sessions?.length || sessionName) && (
            <div className="flex flex-wrap gap-1.5">
              {(invoice.sessions?.length ? invoice.sessions : [sessionName]).map((name) => (
                <span key={name} className="rounded-md border border-white/[0.05] bg-white/[0.025] px-2 py-1 text-[9px] font-medium text-dark-400">{name}</span>
              ))}
            </div>
          )}

          {/* Timer */}
          <div className="flex items-center justify-between rounded-lg border border-amber-500/15 bg-amber-500/[0.055] px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-amber-400"><Clock className="h-3.5 w-3.5" /> Invoice expires in</span>
            <span className={`text-[11px] font-bold tabular-nums ${timeLeft === "Expired" ? "text-red-400" : "text-amber-200"}`}>{timeLeft || "â€”"}</span>
          </div>

          {/* Amount to send */}
          <div className="space-y-3 rounded-xl border border-white/[0.07] bg-dark-800/55 p-3.5">
            <div>
              <p className="mb-1.5 text-[9px] font-bold uppercase tracking-wider text-dark-500">Send exactly</p>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 break-all text-[20px] font-bold tabular-nums text-dark-50">
                  {invoice.pay_amount}
                  <span className="ml-1.5 text-[12px] font-semibold text-dark-400">{invoice.pay_currency.toUpperCase()}</span>
                </span>
                <button
                  onClick={() => copyText(String(invoice.pay_amount), "amount")}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-accent/10 px-2.5 text-[10px] font-semibold text-accent hover:bg-accent/20"
                >
                  {copied === "amount" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied === "amount" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <div className="border-t border-white/[0.05] pt-3">
              <p className="mb-1.5 text-[9px] font-bold uppercase tracking-wider text-dark-500">One-time payment address</p>
              <div className="rounded-lg border border-emerald-500/10 bg-dark-900/55 p-2.5">
                <code className="block break-all font-mono text-[11px] leading-relaxed text-emerald-300">
                  {invoice.pay_address}
                </code>
                <button
                  onClick={() => copyText(invoice.pay_address, "address")}
                  className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/10 bg-emerald-500/10 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/15"
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
                    ? `Received: ${paymentStatus.amount_received} ${invoice.pay_currency.toUpperCase()} â€” confirming...`
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

      {/* â”€â”€ STEP 3: Payment confirmed â”€â”€ */}
      {step === "confirmed" && (
        <div className="py-2 space-y-4">
          <div className="h-16 w-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center mx-auto">
            <CheckCircle className="h-8 w-8 text-emerald-400" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-bold text-emerald-300">Payment received</h3>
            <p className="text-[12px] text-dark-400 mt-1.5 max-w-sm mx-auto">
              Keep this page open to watch the replacement live. It will continue safely if you leave.
            </p>
          </div>
          {paymentStatus?.job && <ReplacementProgress job={paymentStatus.job} />}
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
            className="block mx-auto mt-2 px-6 py-2.5 rounded-xl text-[12px] font-bold bg-emerald-500 text-white hover:bg-emerald-600 shadow-lg shadow-emerald-500/25 transition-all"
          >
            {paymentStatus?.job?.status === "completed" ? "Done" : "Continue in background"}
          </button>
        </div>
      )}
    </Modal>
  );
}

function ReplacementProgress({ job }: { job: ReplacementJob }) {
  const finished = job.status === "completed";
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-dark-900/55 p-3 sm:p-4 space-y-3 text-left">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-bold text-dark-100">
            {finished ? "Replacement complete" : `Replacing ${job.total} session${job.total === 1 ? "" : "s"}`}
          </p>
          <p className="text-[10px] text-dark-500">
            {job.completed} of {job.total} completed
            {job.awaiting_inventory > 0 ? ` Â· ${job.awaiting_inventory} waiting for inventory` : ""}
          </p>
        </div>
        <span className="text-[12px] font-bold text-accent tabular-nums">{job.progress}%</span>
      </div>
      <div className="h-2 rounded-full bg-dark-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${finished ? "bg-emerald-400" : "bg-accent"}`}
          style={{ width: `${Math.max(2, Math.min(100, job.progress))}%` }}
        />
      </div>
      <div className="space-y-2">
        {job.items.map((item, index) => (
          <div key={item.id} className="rounded-xl border border-white/[0.05] bg-dark-800/45 p-3">
            <div className="flex items-start gap-2.5">
              <div className={`mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                item.status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
                item.status === "awaiting_session" ? "bg-amber-500/15 text-amber-400" :
                "bg-accent/15 text-accent"
              }`}>
                {item.status === "completed" ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[11px] font-semibold text-dark-200">
                    {(item.real_name || item.session_file).replace(".session", "")}
                  </p>
                  <span className="text-[10px] text-dark-500 tabular-nums">{item.progress || 0}%</span>
                </div>
                <p className="mt-0.5 text-[10px] leading-relaxed text-dark-400">
                  {item.stage_message || "Waiting to start"}
                </p>
                {item.new_session_file && (
                  <p className="mt-1 text-[9px] text-emerald-400">
                    New account: {item.new_session_file.replace(".session", "")}
                  </p>
                )}
                {!!item.chatlist_result?.configured && (
                  <p className="mt-1 text-[9px] text-dark-500">
                    Chat lists: {item.chatlist_result.joined}/{item.chatlist_result.configured} joined
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SUB-COMPONENTS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
          <p className="text-[9px] text-dark-500">{symbol} â€” {coins.length} networks</p>
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

