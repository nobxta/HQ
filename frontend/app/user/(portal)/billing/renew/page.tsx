"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  Check,
  CheckCircle,
  ChevronRight,
  Clock3,
  Copy,
  Gem,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import { usePortalBot, useRenewalOptions } from "@/lib/hooks/usePortal";
import { cn, formatDate, formatUSD } from "@/lib/utils";

const CURRENCIES = [
  { code: "USDT_TRC20", name: "Tether", network: "TRC20", stable: true },
  { code: "BTC", name: "Bitcoin", network: "BTC", stable: false },
  { code: "ETH", name: "Ethereum", network: "ERC20", stable: false },
  { code: "LTC", name: "Litecoin", network: "LTC", stable: false },
  { code: "TRX", name: "TRON", network: "TRC20", stable: false },
  { code: "BNB", name: "BNB", network: "BEP20", stable: false },
  { code: "USDT_BEP20", name: "Tether", network: "BEP20", stable: true },
  { code: "USDT_ERC20", name: "Tether", network: "ERC20", stable: true },
  { code: "USDC_ERC20", name: "USD Coin", network: "ERC20", stable: true },
  { code: "SOL", name: "Solana", network: "SOL", stable: false },
  { code: "XMR", name: "Monero", network: "XMR", stable: false },
];

type Step = "plan" | "crypto" | "payment" | "status";

type Payment = {
  order_id: string;
  amount_usd: number;
  fiat_currency?: string;
  pay_amount: number | string;
  pay_currency: string;
  pay_address: string;
  invoice_expires_at?: string;
  duration_days: number;
  status?: string;
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
  const [step, setStep] = useState<Step>("plan");
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [status, setStatus] = useState("idle");

  const option = data?.options?.[duration];
  const activeCurrency = CURRENCIES.find((item) => item.code === currency) || CURRENCIES[0];
  const qrValue = payment?.pay_address || "";
  const qrUrl = qrValue
    ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=16&data=${encodeURIComponent(qrValue)}`
    : "";
  const isCompleted = status === "completed";
  const isWaiting = status === "payment_waiting" || status === "waiting" || status === "idle";

  const estimatedAmount = useMemo(() => {
    if (!option?.price) return "";
    const price = Number(option.price);
    if (activeCurrency.stable) return `~${price.toFixed(2)} ${currency.split("_")[0]}`;
    return `Pay equivalent of ${formatUSD(price)}`;
  }, [activeCurrency.stable, currency, option?.price]);

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
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
        setStep("status");
        mutate();
        mutateBot();
        return;
      }
      setPayment(res.data);
      setStatus(res.data.status || "payment_waiting");
      setStep("payment");
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
      setStep("plan");
      setShowQr(false);
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
    setStep(data.active_invoice.status === "completed" ? "status" : "payment");
  }, [data?.active_invoice, payment]);

  useEffect(() => {
    if (!payment || !session || isCompleted) return;
    const id = setInterval(async () => {
      try {
        const res = await portalApi.get(
          `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal-status/${payment.order_id}?telegram_id=${session.telegram_id}`
        );
        const nextStatus = res.data.status || "payment_waiting";
        setStatus(nextStatus);
        if (nextStatus === "completed") {
          setPayment((p) => p ? { ...p, ...res.data } : p);
          setStep("status");
          mutate();
          mutateBot();
          clearInterval(id);
        }
      } catch {}
    }, 7000);
    return () => clearInterval(id);
  }, [isCompleted, mutate, mutateBot, payment, session?.bot_name, session?.telegram_id]);

  if (isLoading || !bot) return <PageSkeleton />;

  return (
    <div className="min-h-[calc(100vh-7rem)] animate-fade-in bg-[#050509] px-0 py-2 sm:px-4 sm:py-6">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,430px)_minmax(0,520px)] lg:items-start lg:justify-center">
        <aside className="hidden lg:block">
          <Link href="/user/billing" className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-dark-400 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Back to billing
          </Link>
          <div className="relative overflow-hidden rounded-[28px] border border-white/[0.07] bg-[#101018] p-7 shadow-2xl shadow-black/40">
            <div className="absolute -right-20 -top-24 h-48 w-48 rounded-full bg-accent/25 blur-[80px]" />
            <div className="absolute -bottom-20 -left-20 h-44 w-44 rounded-full bg-cyan-400/10 blur-[70px]" />
            <div className="relative">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/25 bg-accent/15 text-accent">
                <Gem className="h-6 w-6" />
              </div>
              <h1 className="mt-6 text-3xl font-bold tracking-tight text-white">Renew Advert Plan</h1>
              <p className="mt-3 text-sm leading-6 text-dark-400">
                Choose validity, select a crypto currency, then pay the generated invoice. Any renewal is added after your current expiry date.
              </p>
              <div className="mt-8 space-y-3">
                <SummaryRow icon={<ShieldCheck className="h-4 w-4" />} label="Current plan" value={data?.bot?.plan_name || bot.plan_name || "Custom"} />
                <SummaryRow icon={<Calendar className="h-4 w-4" />} label="Valid until" value={formatDate(data?.bot?.valid_till || bot.valid_till) || "-"} />
                <SummaryRow icon={<Clock3 className="h-4 w-4" />} label="Remaining" value={data?.bot?.hours_left != null ? `${Math.max(data.bot.hours_left, 0)} hours` : "-"} />
              </div>
            </div>
          </div>
        </aside>

        <main className="w-full">
          <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
            <Link href="/user/billing" className="inline-flex items-center gap-2 text-xs font-semibold text-dark-400 hover:text-white">
              <ArrowLeft className="h-4 w-4" /> Billing
            </Link>
            {payment && <span className="rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-[10px] font-bold text-warning">Invoice open</span>}
          </div>

          <section className="overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#0c0c13] shadow-2xl shadow-black/40">
            <CheckoutHeader step={step} hasInvoice={!!payment && !isCompleted} />

            <div className="border-y border-white/[0.06] bg-[#08080d] px-4 py-3 sm:px-6">
              <StepRail step={step} />
            </div>

            <div className="p-4 sm:p-6">
              {step === "plan" && (
                <PlanStep
                  data={data}
                  bot={bot}
                  duration={duration}
                  setDuration={setDuration}
                  disabled={!!payment}
                  onContinue={() => payment ? setStep("payment") : setStep("crypto")}
                />
              )}

              {step === "crypto" && (
                <CryptoStep
                  currency={currency}
                  setCurrency={setCurrency}
                  price={Number(option?.price || 0)}
                  selectedAmount={estimatedAmount}
                  onBack={() => setStep("plan")}
                  onCreate={createPayment}
                  creating={creating}
                  disabled={!option?.available}
                />
              )}

              {step === "payment" && payment && (
                <PaymentStep
                  payment={payment}
                  status={status}
                  showQr={showQr}
                  setShowQr={setShowQr}
                  qrUrl={qrUrl}
                  onCopy={copy}
                  onCancel={cancelPayment}
                  cancelling={cancelling}
                  canCancel={isWaiting}
                  onRefresh={() => mutate()}
                />
              )}

              {step === "status" && (
                <StatusStep
                  status={status}
                  payment={payment}
                  onDashboard={() => router.push("/user/dashboard")}
                  onBilling={() => router.push("/user/billing")}
                />
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function CheckoutHeader({ step, hasInvoice }: { step: Step; hasInvoice: boolean }) {
  const title = step === "plan" ? "Choose validity" : step === "crypto" ? "Choose crypto" : step === "payment" ? "Pay invoice" : "Payment status";
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent text-sm font-black text-white shadow-lg shadow-accent/30">H</div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-dark-500">HQAdz checkout</p>
          <h2 className="text-lg font-bold text-white">{title}</h2>
        </div>
      </div>
      {hasInvoice && (
        <span className="rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-[10px] font-bold text-warning">
          Open invoice
        </span>
      )}
    </div>
  );
}

function StepRail({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "plan", label: "Plan" },
    { id: "crypto", label: "Crypto" },
    { id: "payment", label: "Payment" },
  ];
  const current = step === "status" ? 3 : steps.findIndex((item) => item.id === step);
  return (
    <div className="flex items-center gap-2">
      {steps.map((item, index) => {
        const active = index === current;
        const done = index < current || step === "status";
        return (
          <div key={item.id} className="flex min-w-0 flex-1 items-center gap-2">
            <div className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold",
              done ? "border-success/30 bg-success/15 text-success" : active ? "border-accent/50 bg-accent/20 text-accent-100" : "border-white/[0.08] bg-white/[0.03] text-dark-500"
            )}>
              {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
            </div>
            <span className={cn("truncate text-xs font-semibold", active ? "text-white" : done ? "text-success" : "text-dark-500")}>{item.label}</span>
            {index < steps.length - 1 && <div className={cn("hidden h-px flex-1 sm:block", done ? "bg-success/30" : "bg-white/[0.08]")} />}
          </div>
        );
      })}
    </div>
  );
}

function PlanStep({ data, bot, duration, setDuration, disabled, onContinue }: {
  data: any;
  bot: any;
  duration: "7d" | "30d";
  setDuration: (duration: "7d" | "30d") => void;
  disabled: boolean;
  onContinue: () => void;
}) {
  const selected = data?.options?.[duration];
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-2xl font-bold tracking-tight text-white">Renew Advert Plan</h3>
        <p className="mt-1 text-sm text-dark-400">Choose how long you want to extend your bot.</p>
      </div>

      <div className="grid gap-3">
        {(["7d", "30d"] as const).map((key) => {
          const opt = data?.options?.[key];
          const active = duration === key;
          return (
            <button
              key={key}
              type="button"
              disabled={!opt?.available || disabled}
              onClick={() => setDuration(key)}
              className={cn(
                "group relative overflow-hidden rounded-2xl border p-4 text-left transition-all",
                active ? "border-accent bg-accent/[0.13] shadow-lg shadow-accent/10" : "border-white/[0.07] bg-[#141420] hover:border-accent/40",
                (!opt?.available || disabled) && "opacity-60"
              )}
            >
              <div className="absolute -right-12 -top-12 h-28 w-28 rounded-full bg-accent/10 blur-2xl transition-opacity group-hover:opacity-100" />
              <div className="relative flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.05] text-accent">
                      {key === "30d" ? <Gem className="h-4 w-4" /> : <TimerReset className="h-4 w-4" />}
                    </div>
                    <div>
                      <p className="font-bold text-white">{opt?.days || (key === "7d" ? 7 : 30)} Days</p>
                      <p className="text-xs text-dark-500">Adds after current expiry</p>
                    </div>
                  </div>
                  <p className="mt-4 text-3xl font-bold text-white">{opt?.available ? formatUSD(Number(opt.price)) : "Unavailable"}</p>
                  <p className="mt-1 text-xs text-dark-400">New expiry: <span className="text-dark-200">{opt?.new_valid_till || "-"}</span></p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {key === "30d" && <span className="rounded-full bg-cyan-400/15 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-cyan-300">Best value</span>}
                  <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border", active ? "border-accent bg-accent text-white" : "border-white/[0.12] bg-white/[0.03]")}>
                    {active && <Check className="h-3.5 w-3.5" />}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-[#11111a] p-4">
        <InfoLine label="Current expiry" value={formatDate(data?.bot?.valid_till || bot.valid_till) || "-"} />
        <InfoLine label="After payment" value={selected?.new_valid_till || "-"} highlight />
      </div>

      <Button className="h-12 w-full rounded-xl text-sm font-bold" onClick={onContinue} disabled={!selected?.available}>
        {disabled ? "Open Existing Invoice" : "Continue"} <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function CryptoStep({ currency, setCurrency, price, selectedAmount, onBack, onCreate, creating, disabled }: {
  currency: string;
  setCurrency: (currency: string) => void;
  price: number;
  selectedAmount: string;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-2xl font-bold tracking-tight text-white">Select Payment Currency</h3>
        <p className="mt-1 text-sm text-dark-400">No wallet connection required. Pick a coin and we will generate the invoice address.</p>
      </div>

      <div className="space-y-2.5">
        {CURRENCIES.map((item) => {
          const active = currency === item.code;
          return (
            <button
              key={item.code}
              type="button"
              onClick={() => setCurrency(item.code)}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all",
                active ? "border-accent bg-accent/[0.13] shadow-lg shadow-accent/10" : "border-white/[0.07] bg-[#141420] hover:border-accent/40"
              )}
            >
              <CryptoLogo code={item.code} className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-white">{item.name}</p>
                <p className="text-xs text-dark-500">{item.code.replace("_", " ")} network {item.network}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold text-dark-300">{item.stable ? `~${price.toFixed(2)} ${item.code.split("_")[0]}` : selectedAmount}</p>
                <span className={cn("ml-auto mt-1 flex h-5 w-5 items-center justify-center rounded-full border", active ? "border-accent bg-accent text-white" : "border-white/[0.12] bg-white/[0.03]")}>
                  {active && <Check className="h-3 w-3" />}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" className="h-12 rounded-xl" onClick={onBack}>Back</Button>
        <Button className="h-12 rounded-xl font-bold" onClick={onCreate} loading={creating} disabled={disabled}>
          Generate Invoice
        </Button>
      </div>
    </div>
  );
}

function PaymentStep({ payment, status, showQr, setShowQr, qrUrl, onCopy, onCancel, cancelling, canCancel, onRefresh }: {
  payment: Payment;
  status: string;
  showQr: boolean;
  setShowQr: (show: boolean) => void;
  qrUrl: string;
  onCopy: (value: string, label: string) => void;
  onCancel: () => void;
  cancelling: boolean;
  canCancel: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-sm font-semibold text-dark-400">Pay</p>
        <h3 className="mt-1 text-4xl font-black tracking-tight text-white">{formatUSD(Number(payment.amount_usd))}</h3>
        <p className="mt-2 text-sm text-dark-400">Send exactly <span className="font-bold text-white">{payment.pay_amount} {payment.pay_currency}</span></p>
      </div>

      <div className="rounded-2xl border border-warning/20 bg-warning/[0.06] p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-xs leading-5 text-warning/90">Use only the selected coin and network. Sending a different amount or network can delay confirmation.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-[#11111a]">
        <PaymentLine label="Status" value={<StatusPill status={status} />} />
        <PaymentLine label="Amount due" value={`${payment.pay_amount} ${payment.pay_currency}`} onCopy={() => onCopy(String(payment.pay_amount), "Amount")} />
        <PaymentLine label="USD amount" value={formatUSD(Number(payment.amount_usd))} />
        <PaymentLine label="Invoice ID" value={payment.order_id} mono />
        <PaymentLine label="Expires" value={payment.invoice_expires_at ? formatDate(payment.invoice_expires_at) : "Active quote"} />
      </div>

      <CopyPanel label={`${payment.pay_currency} address`} value={payment.pay_address} onCopy={() => onCopy(payment.pay_address, "Address")} />

      <button
        type="button"
        onClick={() => setShowQr(!showQr)}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-accent/35 bg-accent/10 text-sm font-bold text-accent-100 hover:bg-accent/15"
      >
        <QrCode className="h-4 w-4" /> {showQr ? "Hide QR" : "Show QR"}
      </button>

      {showQr && (
        <div className="rounded-[24px] border border-white/[0.08] bg-[#07070c] p-4">
          <div className="mx-auto flex w-fit items-center justify-center rounded-[18px] bg-white p-3 shadow-xl shadow-black/40">
            {qrUrl && <img src={qrUrl} alt="Payment QR code" className="h-[190px] w-[190px] sm:h-[220px] sm:w-[220px]" />}
          </div>
          <p className="mt-3 text-center text-xs font-medium text-dark-400">Scan to pay with {payment.pay_currency}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" className="h-11 rounded-xl" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
        <Button variant="danger" className="h-11 rounded-xl" onClick={onCancel} loading={cancelling} disabled={!canCancel}>
          <X className="h-4 w-4" /> Cancel
        </Button>
      </div>
    </div>
  );
}

function StatusStep({ status, payment, onDashboard, onBilling }: {
  status: string;
  payment: Payment | null;
  onDashboard: () => void;
  onBilling: () => void;
}) {
  const completed = status === "completed";
  return (
    <div className="space-y-5 text-center">
      <div className={cn("mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border", completed ? "border-success/25 bg-success/15 text-success" : "border-warning/25 bg-warning/15 text-warning")}>
        {completed ? <CheckCircle className="h-8 w-8" /> : <Loader2 className="h-8 w-8 animate-spin" />}
      </div>
      <div>
        <h3 className="text-2xl font-bold text-white">{completed ? "Payment completed" : "Payment in progress"}</h3>
        <p className="mt-2 text-sm leading-6 text-dark-400">
          {completed ? "Your Advert plan was renewed successfully." : "We detected the invoice and are waiting for blockchain confirmation."}
        </p>
      </div>
      {payment && (
        <div className="rounded-2xl border border-white/[0.07] bg-[#11111a] text-left">
          <PaymentLine label="Payment of" value={`${payment.pay_amount} ${payment.pay_currency}`} />
          <PaymentLine label="Total amount" value={formatUSD(Number(payment.amount_usd))} />
          <PaymentLine label="New expiry" value={payment.new_valid_till || payment.new_valid_till_preview || "Updating"} />
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button variant="secondary" className="h-12 rounded-xl" onClick={onBilling}>Billing</Button>
        <Button className="h-12 rounded-xl font-bold" onClick={onDashboard}>Dashboard</Button>
      </div>
    </div>
  );
}

function SummaryRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.035] p-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/[0.05] text-accent">{icon}</div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wide text-dark-500">{label}</p>
        <p className="truncate text-sm font-bold text-white">{value}</p>
      </div>
    </div>
  );
}

function InfoLine({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] py-2.5 last:border-0">
      <span className="text-xs font-medium text-dark-400">{label}</span>
      <span className={cn("text-right text-sm font-bold", highlight ? "text-cyan-300" : "text-white")}>{value}</span>
    </div>
  );
}

function PaymentLine({ label, value, onCopy, mono }: { label: string; value: React.ReactNode; onCopy?: () => void; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 last:border-0">
      <span className="shrink-0 text-xs font-semibold text-dark-400">{label}</span>
      <div className="flex min-w-0 items-center gap-2 text-right">
        <span className={cn("truncate text-sm font-bold text-white", mono && "font-mono text-xs")}>{value}</span>
        {onCopy && (
          <button type="button" onClick={onCopy} className="shrink-0 rounded-lg p-1.5 text-dark-500 hover:bg-white/[0.06] hover:text-white">
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function CopyPanel({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-[#11111a] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-dark-400">{label}</p>
        <button type="button" onClick={onCopy} className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-2 py-1 text-xs font-bold text-dark-200 hover:bg-white/[0.08]">
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
      </div>
      <code className="block break-all rounded-xl bg-[#08080d] p-3 font-mono text-xs leading-5 text-white">{value}</code>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const completed = status === "completed";
  const confirming = status === "confirming" || status === "processing";
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide",
      completed ? "bg-success/15 text-success" : confirming ? "bg-accent/15 text-accent-100" : "bg-warning/15 text-warning"
    )}>
      <span className={cn("h-1.5 w-1.5 rounded-full", completed ? "bg-success" : confirming ? "bg-accent" : "bg-warning")} />
      {completed ? "Completed" : confirming ? "Confirming" : "Waiting"}
    </span>
  );
}

function CryptoLogo({ code, className }: { code: string; className?: string }) {
  const base = code.split("_")[0];
  const color: Record<string, string> = {
    BTC: "#F7931A",
    ETH: "#627EEA",
    LTC: "#345D9D",
    TRX: "#EF0027",
    BNB: "#F3BA2F",
    USDT: "#26A17B",
    USDC: "#2775CA",
    SOL: "#14F195",
    XMR: "#FF6600",
  };
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label={`${base} logo`}>
      <rect width="40" height="40" rx="14" fill={color[base] || "#7C5CFF"} />
      <circle cx="20" cy="20" r="13" fill="rgba(255,255,255,0.16)" />
      {base === "BTC" && <text x="20" y="27" textAnchor="middle" fontSize="22" fontWeight="800" fill="white">B</text>}
      {base === "ETH" && <path d="M20 7 11.5 20.5 20 25l8.5-4.5L20 7Zm0 26 8.5-10.1L20 27.4l-8.5-4.5L20 33Z" fill="white" />}
      {base === "LTC" && <text x="20" y="27" textAnchor="middle" fontSize="23" fontWeight="800" fill="white">L</text>}
      {base === "TRX" && <path d="M10 9 31 14.5 18.5 31 10 9Zm4.2 4.2 5 13.2 7.2-9.5-12.2-3.7Z" fill="white" />}
      {base === "BNB" && <path d="m20 8 5 5-5 5-5-5 5-5Zm-8 8 5 5-5 5-5-5 5-5Zm16 0 5 5-5 5-5-5 5-5Zm-8 8 5 5-5 5-5-5 5-5Z" fill="white" />}
      {base === "USDT" && <path d="M11 12h18v4h-7v2.1c4.4.2 7.6 1.1 7.6 2.2s-3.2 2-7.6 2.2V29h-4v-6.5c-4.4-.2-7.6-1.1-7.6-2.2s3.2-2 7.6-2.2V16h-7v-4Zm9 8.7c2.8 0 5.1-.3 5.1-.7s-2.3-.7-5.1-.7-5.1.3-5.1.7 2.3.7 5.1.7Z" fill="white" />}
      {base === "USDC" && <text x="20" y="27" textAnchor="middle" fontSize="22" fontWeight="800" fill="white">$</text>}
      {base === "SOL" && <path d="M12 13h17l-3 4H9l3-4Zm2 6h17l-3 4H11l3-4Zm-2 6h17l-3 4H9l3-4Z" fill="white" />}
      {base === "XMR" && <path d="M20 8a12 12 0 0 1 10.8 17.2h-5.1v-9.4L20 21.5l-5.7-5.7v9.4H9.2A12 12 0 0 1 20 8Z" fill="white" />}
    </svg>
  );
}
