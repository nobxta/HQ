"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePortalBot, usePortalOrders } from "@/lib/hooks/usePortal";
import { getPortalSession } from "@/lib/portal-api";
import portalApi from "@/lib/portal-api";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Save, Users, Plus, Trash2, Shield, Key, Copy, RefreshCw,
  Calendar, Tag, CreditCard, ArrowRight, Check, X, Loader2,
  Clock, ChevronLeft, Wallet, ExternalLink, AlertTriangle,
} from "lucide-react";
import toast from "react-hot-toast";
import { formatDate, formatUSD } from "@/lib/utils";
import Link from "next/link";

// Crypto display names
const CRYPTO_NAMES: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", LTC: "Litecoin", XMR: "Monero",
  TRX: "TRON", BNB: "BNB", DOGE: "Dogecoin", XRP: "Ripple",
  SOL: "Solana", MATIC: "Polygon", ADA: "Cardano", TON: "TON",
  USDT_TRC20: "USDT (TRC-20)", USDT_BEP20: "USDT (BEP-20)",
  USDT_ERC20: "USDT (ERC-20)", USDT_SOL: "USDT (SOL)",
  USDC_BEP20: "USDC (BEP-20)", USDC_ERC20: "USDC (ERC-20)",
  USDC_SOL: "USDC (SOL)",
};

type RenewalStep = "idle" | "duration" | "crypto" | "network" | "paying" | "completed" | "failed";

type PaymentInfo = {
  order_id: string;
  pay_address: string;
  pay_amount: number;
  pay_currency: string;
  amount_usd: number;
  duration_days: number;
  invoice_expires_at: string;
};

export default function UserSettingsPage() {
  const { data: bot, isLoading, mutate } = usePortalBot();
  const session = getPortalSession();

  // Auth users state
  const [authIds, setAuthIds] = useState<number[]>([]);
  const [newAuthId, setNewAuthId] = useState("");
  const [savingAuth, setSavingAuth] = useState(false);

  // Renewal flow state
  const [renewStep, setRenewStep] = useState<RenewalStep>("idle");
  const [selectedDuration, setSelectedDuration] = useState<number>(0);
  const [selectedCoin, setSelectedCoin] = useState("");
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
  const [renewLoading, setRenewLoading] = useState(false);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (bot) {
      setAuthIds(bot.authorized || []);
    }
  }, [bot]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [pollInterval]);

  if (isLoading) return <PageSkeleton />;
  if (!bot) return <div className="text-center py-20 text-dark-400">Bot not found</div>;

  const renewalPrice = parseFloat(bot.renewal_price || "0");
  const hasRenewalPrice = renewalPrice > 0;

  // Calculate days remaining
  const getDaysRemaining = () => {
    if (!bot.valid_till) return null;
    try {
      let end: Date | null = null;
      const vt = bot.valid_till.trim();
      // Try DD/MM/YYYY
      const slashParts = vt.split("/");
      if (slashParts.length === 3 && slashParts[0].length <= 2) {
        end = new Date(parseInt(slashParts[2]), parseInt(slashParts[1]) - 1, parseInt(slashParts[0]));
      }
      // Try YYYY-MM-DD
      if (!end || isNaN(end.getTime())) {
        const dashParts = vt.split("-");
        if (dashParts.length === 3 && dashParts[0].length === 4) {
          end = new Date(parseInt(dashParts[0]), parseInt(dashParts[1]) - 1, parseInt(dashParts[2]));
        }
      }
      if (!end || isNaN(end.getTime())) return null;
      const now = new Date();
      const diff = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return diff;
    } catch {}
    return null;
  };
  const daysRemaining = getDaysRemaining();
  const isExpiringSoon = daysRemaining !== null && daysRemaining <= 7;
  const isExpired = daysRemaining !== null && daysRemaining <= 0;

  // Renewal price for selected duration
  const getPrice = (days: number) => {
    if (days >= 30) return renewalPrice;
    return renewalPrice * (days / 30);
  };

  // Start renewal flow
  const startRenewal = () => {
    setRenewStep("duration");
    setSelectedDuration(0);
    setSelectedCoin("");
    setPaymentInfo(null);
  };

  const cancelRenewal = () => {
    setRenewStep("idle");
    setSelectedDuration(0);
    setSelectedCoin("");
    setPaymentInfo(null);
    if (pollInterval) {
      clearInterval(pollInterval);
      setPollInterval(null);
    }
  };

  // Select duration
  const selectDuration = (days: number) => {
    setSelectedDuration(days);
    setRenewStep("crypto");
  };

  // Select crypto and create invoice
  const selectCrypto = async (currency: string) => {
    setSelectedCoin(currency);
    setRenewLoading(true);
    try {
      const resp = await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/renew?telegram_id=${session?.telegram_id}`,
        { duration_days: selectedDuration, currency }
      );
      const data = resp.data;

      if (data.status === "completed") {
        // Dev mode: auto-completed
        setRenewStep("completed");
        toast.success("Renewal confirmed! Validity extended.");
        mutate();
        setRenewLoading(false);
        return;
      }

      setPaymentInfo({
        order_id: data.order_id,
        pay_address: data.pay_address,
        pay_amount: data.pay_amount,
        pay_currency: data.pay_currency,
        amount_usd: data.amount_usd,
        duration_days: data.duration_days,
        invoice_expires_at: data.invoice_expires_at,
      });
      setRenewStep("paying");

      // Start polling payment status
      const interval = setInterval(async () => {
        try {
          const statusResp = await portalApi.get(
            `/api/portal/bot/${encodeURIComponent(bot.name)}/renewal-status/${data.order_id}?telegram_id=${session?.telegram_id}`
          );
          const s = statusResp.data.status;
          if (s === "completed") {
            clearInterval(interval);
            setPollInterval(null);
            setRenewStep("completed");
            toast.success("Payment confirmed! Validity extended.");
            mutate();
          } else if (s === "failed" || s === "expired" || s === "cancelled") {
            clearInterval(interval);
            setPollInterval(null);
            setRenewStep("failed");
          }
        } catch {}
      }, 10000);
      setPollInterval(interval);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to create payment");
      setRenewStep("crypto");
    }
    setRenewLoading(false);
  };

  // Web token reset
  const [resettingToken, setResettingToken] = useState(false);
  const regenerateToken = async () => {
    setResettingToken(true);
    try {
      const resp = await portalApi.post(
        `/api/portal/generate-web-token/${encodeURIComponent(bot.name)}?telegram_id=${session?.telegram_id}`
      );
      toast.success("Access code regenerated");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to regenerate");
    }
    setResettingToken(false);
  };

  // Auth user management
  const addAuthId = () => {
    const id = Number(newAuthId.trim());
    if (!id || isNaN(id)) return;
    if (authIds.includes(id)) { toast.error("Already added"); return; }
    if (authIds.length >= 10) { toast.error("Max 10 authorized users"); return; }
    setAuthIds([...authIds, id]);
    setNewAuthId("");
  };

  const removeAuthId = (id: number) => {
    if (id === session?.telegram_id) { toast.error("Cannot remove yourself"); return; }
    setAuthIds(authIds.filter((a) => a !== id));
  };

  const saveAuth = async () => {
    setSavingAuth(true);
    try {
      await portalApi.put(
        `/api/portal/bot/${encodeURIComponent(bot.name)}/authorized?telegram_id=${session?.telegram_id}`,
        { authorized: authIds }
      );
      toast.success("Authorized users updated");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSavingAuth(false);
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied!`);
  };

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">
      <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Settings</h1>

      {/* Plan & Subscription */}
      <Card>
        <CardHeader>
          <CardTitle><Tag className="h-4 w-4 inline mr-2" />Plan & Subscription</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          {/* Plan info row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg bg-dark-800/50 border border-dark-700/50 p-3 text-center">
              <p className="text-[10px] text-dark-500 mb-1">Plan</p>
              <p className="text-sm font-bold text-dark-100 truncate">{bot.plan_name || "Custom"}</p>
            </div>
            <div className="rounded-lg bg-dark-800/50 border border-dark-700/50 p-3 text-center">
              <p className="text-[10px] text-dark-500 mb-1">Mode</p>
              <p className="text-sm font-bold text-dark-100">{bot.mode}</p>
            </div>
            <div className="rounded-lg bg-dark-800/50 border border-dark-700/50 p-3 text-center">
              <p className="text-[10px] text-dark-500 mb-1">Sessions</p>
              <p className="text-sm font-bold text-dark-100">{bot.sessions_count || 0}</p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${
              isExpired ? "bg-danger/5 border-danger/30" :
              isExpiringSoon ? "bg-warning/5 border-warning/30" :
              "bg-dark-800/50 border-dark-700/50"
            }`}>
              <p className="text-[10px] text-dark-500 mb-1">Valid Until</p>
              <p className={`text-sm font-bold truncate ${
                isExpired ? "text-danger" : isExpiringSoon ? "text-warning" : "text-dark-100"
              }`}>
                {bot.valid_till || "—"}
              </p>
              {daysRemaining !== null && (
                <p className={`text-[10px] mt-0.5 ${
                  isExpired ? "text-danger" : isExpiringSoon ? "text-warning" : "text-dark-500"
                }`}>
                  {isExpired ? "Expired" : `${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} left`}
                </p>
              )}
            </div>
          </div>

          {/* Expiry warning */}
          {isExpiringSoon && !isExpired && (
            <div className="flex items-center gap-2 rounded-lg bg-warning/5 border border-warning/20 p-3">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
              <p className="text-xs text-warning">
                Your plan expires in {daysRemaining} day{daysRemaining !== 1 ? "s" : ""}. Renew now to keep your AdBot running.
              </p>
            </div>
          )}
          {isExpired && (
            <div className="flex items-center gap-2 rounded-lg bg-danger/5 border border-danger/20 p-3">
              <AlertTriangle className="h-4 w-4 text-danger shrink-0" />
              <p className="text-xs text-danger">
                Your plan has expired, and posting is paused. Renew to reactivate your AdBot.
              </p>
            </div>
          )}

          {/* Renewal entry point */}
          {renewStep === "idle" && (
            <div className="border-t border-dark-800 pt-4">
              <div className="rounded-xl border border-accent/20 bg-gradient-to-br from-accent/12 via-dark-800/70 to-success/10 p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-dark-100">Extend your plan</p>
                    <p className="text-xs text-dark-400 mt-1">Choose 7 or 30 days, pay by crypto, and keep unused time.</p>
                  </div>
                  <Link href="/user/billing/renew">
                    <Button variant="primary" size="sm" className="w-full sm:w-auto">
                      <CreditCard className="h-4 w-4" /> Renew Now
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Duration */}
          {renewStep === "duration" && (
            <div className="border-t border-dark-800 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-dark-200">Select Duration</p>
                <button onClick={cancelRenewal} className="text-xs text-dark-500 hover:text-dark-300">Cancel</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => selectDuration(7)}
                  className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 p-4 text-left transition-all group"
                >
                  <p className="text-sm font-bold text-dark-100 group-hover:text-accent">Weekly</p>
                  <p className="text-xs text-dark-500 mt-0.5">7 days</p>
                  <p className="text-lg font-bold text-accent mt-2">{formatUSD(getPrice(7))}</p>
                </button>
                <button
                  onClick={() => selectDuration(30)}
                  className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 p-4 text-left transition-all group relative"
                >
                  <div className="absolute -top-2 right-2 bg-accent text-dark-950 text-[10px] font-bold px-2 py-0.5 rounded-full">Best Value</div>
                  <p className="text-sm font-bold text-dark-100 group-hover:text-accent">Monthly</p>
                  <p className="text-xs text-dark-500 mt-0.5">30 days</p>
                  <p className="text-lg font-bold text-accent mt-2">{formatUSD(getPrice(30))}</p>
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Crypto selection */}
          {renewStep === "crypto" && (
            <div className="border-t border-dark-800 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button onClick={() => setRenewStep("duration")} className="text-dark-500 hover:text-dark-300">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <p className="text-sm font-medium text-dark-200">
                    Select Crypto — {selectedDuration} days / {formatUSD(getPrice(selectedDuration))}
                  </p>
                </div>
                <button onClick={cancelRenewal} className="text-xs text-dark-500 hover:text-dark-300">Cancel</button>
              </div>

              {/* Main cryptos */}
              <div className="grid grid-cols-4 gap-2">
                {["BTC", "ETH", "LTC", "XMR"].map((c) => (
                  <button
                    key={c}
                    onClick={() => selectCrypto(c)}
                    disabled={renewLoading}
                    className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 px-3 py-2.5 text-xs font-medium text-dark-200 transition-all disabled:opacity-50"
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Stablecoins */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { setSelectedCoin("usdt"); setRenewStep("network"); }}
                  className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 px-3 py-2.5 text-xs font-medium text-dark-200 transition-all"
                >
                  USDT <ArrowRight className="h-3 w-3 inline ml-1" />
                </button>
                <button
                  onClick={() => { setSelectedCoin("usdc"); setRenewStep("network"); }}
                  className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 px-3 py-2.5 text-xs font-medium text-dark-200 transition-all"
                >
                  USDC <ArrowRight className="h-3 w-3 inline ml-1" />
                </button>
              </div>

              {/* More cryptos */}
              <div className="grid grid-cols-4 gap-2">
                {["TRX", "BNB", "DOGE", "SOL", "TON", "XRP", "ADA", "MATIC"].map((c) => (
                  <button
                    key={c}
                    onClick={() => selectCrypto(c)}
                    disabled={renewLoading}
                    className="rounded-lg border border-dark-700 bg-dark-800/50 hover:border-dark-600 hover:bg-dark-800 px-2 py-2 text-[11px] font-medium text-dark-400 transition-all disabled:opacity-50"
                  >
                    {c}
                  </button>
                ))}
              </div>

              {renewLoading && (
                <div className="flex items-center justify-center gap-2 py-2">
                  <Loader2 className="h-4 w-4 text-accent animate-spin" />
                  <span className="text-xs text-dark-400">Creating invoice...</span>
                </div>
              )}
            </div>
          )}

          {/* Step 2b: Network selection (USDT/USDC) */}
          {renewStep === "network" && (
            <div className="border-t border-dark-800 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button onClick={() => setRenewStep("crypto")} className="text-dark-500 hover:text-dark-300">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <p className="text-sm font-medium text-dark-200">
                    {selectedCoin.toUpperCase()} — Select Network
                  </p>
                </div>
                <button onClick={cancelRenewal} className="text-xs text-dark-500 hover:text-dark-300">Cancel</button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {selectedCoin === "usdt" ? (
                  <>
                    {[
                      { label: "TRC-20", code: "USDT_TRC20" },
                      { label: "BEP-20", code: "USDT_BEP20" },
                      { label: "ERC-20", code: "USDT_ERC20" },
                      { label: "SOL", code: "USDT_SOL" },
                    ].map((n) => (
                      <button
                        key={n.code}
                        onClick={() => selectCrypto(n.code)}
                        disabled={renewLoading}
                        className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 px-3 py-2.5 text-xs font-medium text-dark-200 transition-all disabled:opacity-50"
                      >
                        {n.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    {[
                      { label: "BEP-20", code: "USDC_BEP20" },
                      { label: "ERC-20", code: "USDC_ERC20" },
                      { label: "SOL", code: "USDC_SOL" },
                    ].map((n) => (
                      <button
                        key={n.code}
                        onClick={() => selectCrypto(n.code)}
                        disabled={renewLoading}
                        className="rounded-lg border border-dark-700 bg-dark-800 hover:border-accent/50 hover:bg-accent/5 px-3 py-2.5 text-xs font-medium text-dark-200 transition-all disabled:opacity-50"
                      >
                        {n.label}
                      </button>
                    ))}
                  </>
                )}
              </div>

              {renewLoading && (
                <div className="flex items-center justify-center gap-2 py-2">
                  <Loader2 className="h-4 w-4 text-accent animate-spin" />
                  <span className="text-xs text-dark-400">Creating invoice...</span>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Payment */}
          {renewStep === "paying" && paymentInfo && (
            <div className="border-t border-dark-800 pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-accent" />
                  <p className="text-sm font-medium text-dark-200">Complete Payment</p>
                </div>
                <button onClick={cancelRenewal} className="text-xs text-dark-500 hover:text-dark-300">Cancel</button>
              </div>

              <div className="rounded-lg bg-dark-800/50 border border-dark-700 p-4 space-y-3">
                {/* Summary */}
                <div className="flex justify-between text-xs">
                  <span className="text-dark-400">Extension</span>
                  <span className="text-dark-200 font-medium">{paymentInfo.duration_days} days</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-dark-400">Amount</span>
                  <span className="text-dark-200 font-medium">{formatUSD(paymentInfo.amount_usd)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-dark-400">Currency</span>
                  <span className="text-dark-200 font-medium">
                    {CRYPTO_NAMES[paymentInfo.pay_currency] || paymentInfo.pay_currency}
                  </span>
                </div>

                {/* Send exact amount */}
                <div className="border-t border-dark-700 pt-3">
                  <p className="text-xs text-dark-400 mb-1.5">Send exactly:</p>
                  <div className="flex items-center gap-2 rounded-lg bg-dark-950 border border-dark-600 px-3 py-2.5">
                    <code className="flex-1 text-sm font-mono text-accent truncate select-all">
                      {paymentInfo.pay_amount} {paymentInfo.pay_currency}
                    </code>
                    <button
                      onClick={() => copyToClipboard(String(paymentInfo.pay_amount), "Amount")}
                      className="text-dark-400 hover:text-dark-200 transition-colors shrink-0 p-1"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Address */}
                <div>
                  <p className="text-xs text-dark-400 mb-1.5">To address:</p>
                  <div className="flex items-center gap-2 rounded-lg bg-dark-950 border border-dark-600 px-3 py-2.5">
                    <code className="flex-1 text-xs font-mono text-dark-200 truncate select-all">
                      {paymentInfo.pay_address}
                    </code>
                    <button
                      onClick={() => copyToClipboard(paymentInfo.pay_address, "Address")}
                      className="text-dark-400 hover:text-dark-200 transition-colors shrink-0 p-1"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Valid for */}
                <div className="flex items-center gap-1.5 text-xs text-dark-500">
                  <Clock className="h-3 w-3" />
                  <span>Valid for 12 hours. After that, create a new order.</span>
                </div>
              </div>

              {/* Polling indicator */}
              <div className="flex items-center justify-center gap-2 py-1">
                <Loader2 className="h-4 w-4 text-accent animate-spin" />
                <span className="text-xs text-dark-400">Waiting for payment confirmation...</span>
              </div>
            </div>
          )}

          {/* Step 4: Completed */}
          {renewStep === "completed" && (
            <div className="border-t border-dark-800 pt-4 space-y-3">
              <div className="flex items-center gap-3 rounded-lg bg-success/5 border border-success/20 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 shrink-0">
                  <Check className="h-5 w-5 text-success" />
                </div>
                <div>
                  <p className="text-sm font-bold text-success">Payment Confirmed</p>
                  <p className="text-xs text-dark-400 mt-0.5">
                    Your plan validity has been extended by {paymentInfo?.duration_days || selectedDuration} days.
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" onClick={cancelRenewal}>
                  Done
                </Button>
              </div>
            </div>
          )}

          {/* Step 4b: Failed */}
          {renewStep === "failed" && (
            <div className="border-t border-dark-800 pt-4 space-y-3">
              <div className="flex items-center gap-3 rounded-lg bg-danger/5 border border-danger/20 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 shrink-0">
                  <X className="h-5 w-5 text-danger" />
                </div>
                <div>
                  <p className="text-sm font-bold text-danger">Payment Failed or Expired</p>
                  <p className="text-xs text-dark-400 mt-0.5">
                    The payment was not completed. You can try again.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={cancelRenewal}>
                  Dismiss
                </Button>
                <Button size="sm" onClick={startRenewal}>
                  Try Again
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Authorized Users */}
      <Card>
        <CardHeader>
          <CardTitle><Users className="h-4 w-4 inline mr-2" />Authorized Users ({authIds.length}/10)</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <p className="text-xs text-dark-500">
            Telegram user IDs that can control this bot. You cannot remove yourself.
          </p>

          {authIds.length === 0 ? (
            <p className="text-sm text-dark-500">No authorized users</p>
          ) : (
            <div className="space-y-2">
              {authIds.map((id) => (
                <div key={id} className="flex items-center justify-between rounded-lg bg-dark-800 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Shield className="h-3.5 w-3.5 text-accent shrink-0" />
                    <span className="text-xs sm:text-sm text-dark-200 font-mono truncate">{id}</span>
                    {id === session?.telegram_id && (
                      <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded shrink-0">You</span>
                    )}
                  </div>
                  <button
                    onClick={() => removeAuthId(id)}
                    disabled={id === session?.telegram_id}
                    className="text-dark-500 hover:text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0 p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              className="flex-1 min-w-0 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="Telegram User ID"
              value={newAuthId}
              onChange={(e) => setNewAuthId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAuthId()}
            />
            <Button variant="secondary" size="sm" onClick={addAuthId} className="shrink-0">
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex justify-end">
            <Button onClick={saveAuth} loading={savingAuth} size="sm">
              <Save className="h-4 w-4" /> Save Users
            </Button>
          </div>
        </div>
      </Card>

      {/* Web Access Code */}
      {bot.web_token && (
        <Card>
          <CardHeader><CardTitle><Key className="h-4 w-4 inline mr-2" />Web Access Code</CardTitle></CardHeader>
          <div className="space-y-3">
            <p className="text-xs text-dark-500">
              Use this code to login to the web panel, or share the direct link below.
            </p>
            <div className="flex items-center gap-2 rounded-lg bg-dark-800 border border-dark-700/50 px-3 py-2.5">
              <code className="flex-1 text-xs sm:text-sm font-mono text-accent truncate select-all">{bot.web_token}</code>
              <button
                onClick={() => copyToClipboard(bot.web_token, "Code")}
                className="text-dark-400 hover:text-dark-200 transition-colors shrink-0 p-1"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-dark-800/50 border border-dark-700/50 px-3 py-2">
              <span className="text-xs text-dark-500 shrink-0">Direct Link:</span>
              <code className="flex-1 text-[10px] sm:text-xs font-mono text-dark-300 truncate select-all">
                {typeof window !== "undefined" ? `${window.location.origin}/login?token=${bot.web_token}` : ""}
              </code>
              <button
                onClick={() => {
                  const url = `${window.location.origin}/login?token=${bot.web_token}`;
                  copyToClipboard(url, "Link");
                }}
                className="text-dark-400 hover:text-dark-200 transition-colors shrink-0 p-1"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                onClick={regenerateToken}
                loading={resettingToken}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Regenerate Code
              </Button>
            </div>
            <p className="text-[10px] text-dark-500">
              Regenerating will invalidate the old code. You'll need to use the new code to login.
            </p>
          </div>
        </Card>
      )}

      {/* Current Config (read-only) */}
      <Card>
        <CardHeader><CardTitle>Current Configuration</CardTitle></CardHeader>
        <div className="space-y-2 text-sm">
          {([
            ["Mode", bot.mode],
            ["Plan", bot.plan_name || "Custom"],
            ["Group File", bot.group_file || "—"],
            ["Sessions", bot.sessions_count || 0],
            ["Cycle", `${bot.cycle}s`],
            ["Gap", `${bot.gap}s`],
            ["Valid Until", bot.valid_till || "—"],
          ] as [string, any][]).map(([k, v]) => (
            <div key={k} className="flex justify-between py-1.5 border-b border-dark-800 last:border-0">
              <span className="text-dark-400">{k}</span>
              <span className="text-dark-200 font-medium truncate ml-4 text-right">{String(v)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
