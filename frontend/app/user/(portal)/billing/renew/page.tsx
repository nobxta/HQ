"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle, Clock, Copy, CreditCard, Loader2, QrCode, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import { PageSkeleton } from "@/components/ui/Skeleton";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import { usePortalBot, useRenewalOptions } from "@/lib/hooks/usePortal";
import { formatDate, formatUSD } from "@/lib/utils";

const CURRENCIES = ["BTC", "ETH", "LTC", "XMR", "USDT_TRC20", "USDT_BEP20", "USDT_ERC20", "USDC_ERC20", "USDC_BEP20", "SOL", "TRX", "BNB"];

type Payment = {
  order_id: string;
  amount_usd: number;
  fiat_currency?: string;
  pay_amount: number | string;
  pay_currency: string;
  pay_address: string;
  invoice_expires_at: string;
  duration_days: number;
  new_valid_till?: string;
  new_valid_till_preview?: string;
};

export default function RenewalPage() {
  const router = useRouter();
  const session = getPortalSession();
  const { data: bot, mutate: mutateBot } = usePortalBot();
  const { data, isLoading, mutate } = useRenewalOptions();
  const [duration, setDuration] = useState<"7d" | "30d">("30d");
  const [currency, setCurrency] = useState("USDT_TRC20");
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [status, setStatus] = useState("idle");

  const option = data?.options?.[duration];
  const qrValue = payment?.pay_address || "";
  const qrUrl = qrValue ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=14&data=${encodeURIComponent(qrValue)}` : "";

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  const createPayment = async () => {
    if (!session || !option?.available) return;
    setCreating(true);
    try {
      const res = await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renew?telegram_id=${session.telegram_id}`,
        { duration_days: option.days, currency }
      );
      if (res.data.status === "completed") {
        setStatus("completed");
        mutate();
        mutateBot();
        return;
      }
      setPayment(res.data);
      setStatus("payment_waiting");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not create payment");
    } finally {
      setCreating(false);
    }
  };

  const cancelPayment = async () => {
    if (!session || !payment) return;
    setCancelling(true);
    try {
      await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal/${payment.order_id}/cancel?telegram_id=${session.telegram_id}`
      );
      setPayment(null);
      setStatus("idle");
      mutate();
      toast.success("Invoice cancelled. You can create a new one now.");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not cancel invoice");
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    if (!data?.active_invoice || payment) return;
    setPayment(data.active_invoice);
    setStatus(data.active_invoice.status || "payment_waiting");
  }, [data?.active_invoice, payment]);

  useEffect(() => {
    if (!payment || !session || status === "completed") return;
    const id = setInterval(async () => {
      try {
        const res = await portalApi.get(
          `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal-status/${payment.order_id}?telegram_id=${session.telegram_id}`
        );
        setStatus(res.data.status || "payment_waiting");
        if (res.data.status === "completed") {
          setPayment((p) => p ? { ...p, ...res.data } : p);
          mutate();
          mutateBot();
          clearInterval(id);
        }
      } catch {}
    }, 7000);
    return () => clearInterval(id);
  }, [payment?.order_id, session?.bot_name, session?.telegram_id, status, mutate, mutateBot]);

  if (isLoading || !bot) return <PageSkeleton />;

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in max-w-6xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link href="/user/billing" className="inline-flex items-center gap-1.5 text-xs text-dark-400 hover:text-dark-200 mb-2">
            <ArrowLeft className="h-3.5 w-3.5" /> Billing
          </Link>
          <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Renew Your AdBot</h1>
          <p className="text-xs sm:text-sm text-dark-400 mt-1">Extend your subscription without losing any remaining time.</p>
        </div>
      </div>

      <Card>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            ["Plan", data?.bot?.plan_name || bot.plan_name || "Custom"],
            ["Status", data?.bot?.state || bot.state || "stopped"],
            ["Valid Until", formatDate(data?.bot?.valid_till || bot.valid_till)],
            ["Remaining", data?.bot?.hours_left != null ? `${Math.max(data.bot.hours_left, 0)}h` : "—"],
            ["Accounts", data?.bot?.sessions_count ?? bot.sessions_count ?? 0],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-dark-700/60 bg-dark-800/50 p-3">
              <p className="text-[10px] uppercase text-dark-500">{k}</p>
              <p className="mt-1 text-sm font-bold text-dark-100 truncate">{String(v || "—")}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle><CreditCard className="h-4 w-4 inline mr-2" />Choose Validity</CardTitle></CardHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(["7d", "30d"] as const).map((key) => {
              const opt = data?.options?.[key];
              const active = duration === key;
              return (
                <button
                  key={key}
                  disabled={!opt?.available || !!payment}
                  onClick={() => setDuration(key)}
                  className={`relative rounded-lg border p-4 text-left transition-all ${active ? "border-accent bg-accent/10" : "border-dark-700 bg-dark-800/60 hover:border-accent/50"} disabled:opacity-50`}
                >
                  {key === "30d" && <span className="absolute right-3 top-3 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-dark-950">Recommended</span>}
                  <p className="text-sm font-bold text-dark-100">{opt?.days || (key === "7d" ? 7 : 30)} Days</p>
                  <p className="mt-2 text-2xl font-bold text-accent">{opt?.available ? formatUSD(Number(opt.price)) : "Unavailable"}</p>
                  <p className="mt-2 text-xs text-dark-400">New expiry: {opt?.new_valid_till || "—"}</p>
                </button>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle><Wallet className="h-4 w-4 inline mr-2" />Cryptocurrency</CardTitle></CardHeader>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {CURRENCIES.map((c) => (
              <button key={c} disabled={!!payment} onClick={() => setCurrency(c)}
                className={`rounded-lg border px-3 py-2.5 text-xs font-semibold transition-colors ${currency === c ? "border-accent bg-accent/10 text-accent" : "border-dark-700 bg-dark-800 text-dark-300 hover:border-dark-600"}`}>
                {c.replace("_", " ")}
              </button>
            ))}
          </div>
          {!payment && (
            <Button className="mt-4 w-full" onClick={createPayment} loading={creating} disabled={!option?.available}>
              <QrCode className="h-4 w-4" /> Generate Payment
            </Button>
          )}
        </Card>
      </div>

      {payment && (
        <Card>
          <CardHeader><CardTitle>{status === "completed" ? <CheckCircle className="h-4 w-4 inline mr-2 text-success" /> : <Clock className="h-4 w-4 inline mr-2 text-warning" />}Payment</CardTitle></CardHeader>
          {status === "completed" ? (
            <div className="rounded-lg border border-success/30 bg-success/10 p-4">
              <p className="text-lg font-bold text-success">Subscription Renewed</p>
              <p className="text-sm text-dark-300 mt-1">New expiry: {payment.new_valid_till || payment.new_valid_till_preview || "updated"}</p>
              <div className="mt-4 flex flex-col sm:flex-row gap-2">
                <Button onClick={() => router.push("/user/dashboard")}><ShieldCheck className="h-4 w-4" /> Return to Dashboard</Button>
                <Button variant="secondary" onClick={() => router.push("/user/billing")}>View Billing History</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
              <div className="rounded-lg bg-white p-4 flex items-center justify-center">
                {qrUrl && <img src={qrUrl} alt="Payment QR code" className="h-[220px] w-[220px]" />}
              </div>
              <div className="space-y-3 min-w-0">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Info label="Duration" value={`${payment.duration_days} days`} />
                  <Info label="Fiat price" value={formatUSD(Number(payment.amount_usd))} />
                  <Info label="Status" value={status.replace("_", " ")} />
                  <Info label="Order" value={payment.order_id} mono />
                </div>
                <CopyBox label="Send exactly" value={`${payment.pay_amount} ${payment.pay_currency}`} onCopy={() => copy(String(payment.pay_amount), "Amount")} />
                <CopyBox label="Payment address" value={payment.pay_address} onCopy={() => copy(payment.pay_address, "Address")} />
                <div className="flex items-center gap-2 text-xs text-dark-500">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Waiting for NOWPayments confirmation. Do not send a different amount or network.
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button variant="secondary" onClick={cancelPayment} loading={cancelling} disabled={status !== "payment_waiting"}>
                    Cancel Invoice
                  </Button>
                  <Button variant="ghost" onClick={() => mutate()}>
                    Reopen Latest Invoice
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-lg border border-dark-700/60 bg-dark-800/50 p-3 min-w-0"><p className="text-[10px] uppercase text-dark-500">{label}</p><p className={`mt-1 truncate text-dark-100 ${mono ? "font-mono text-xs" : "font-semibold"}`}>{value}</p></div>;
}

function CopyBox({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div>
      <p className="mb-1.5 text-xs text-dark-400">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-dark-700 bg-dark-950 px-3 py-2.5">
        <code className="min-w-0 flex-1 break-all text-xs text-dark-100">{value}</code>
        <button onClick={onCopy} className="shrink-0 rounded-md p-1.5 text-dark-400 hover:bg-dark-800 hover:text-dark-100"><Copy className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
