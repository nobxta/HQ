"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle,
  ChevronRight,
  Copy,
  Loader2,
  QrCode,
  RefreshCw,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import { usePortalBot, useRenewalOptions } from "@/lib/hooks/usePortal";
import { cn, formatDate, formatUSD } from "@/lib/utils";

const CURRENCIES = [
  { code: "USDT_TRC20", name: "Tether", symbol: "USDT", network: "TRC20" },
  { code: "USDT_BEP20", name: "Tether", symbol: "USDT", network: "BEP20" },
  { code: "USDT_ERC20", name: "Tether", symbol: "USDT", network: "ERC20" },
  { code: "BTC", name: "Bitcoin", symbol: "BTC", network: "Bitcoin" },
  { code: "ETH", name: "Ethereum", symbol: "ETH", network: "ERC20" },
  { code: "LTC", name: "Litecoin", symbol: "LTC", network: "Litecoin" },
  { code: "TRX", name: "TRON", symbol: "TRX", network: "TRC20" },
  { code: "BNB", name: "BNB", symbol: "BNB", network: "BEP20" },
];

type Step = "duration" | "crypto" | "invoice" | "success";

type Payment = {
  order_id: string;
  amount_usd: number;
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
  const [step, setStep] = useState<Step>("duration");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [status, setStatus] = useState("idle");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const selectedOption = data?.options?.[duration];
  const selectedCurrency = CURRENCIES.find((item) => item.code === currency) || CURRENCIES[0];
  const isCompleted = status === "completed";
  const hasOpenInvoice = !!payment && !isCompleted;
  const qrUrl = payment?.pay_address
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=14&data=${encodeURIComponent(payment.pay_address)}`
    : "";

  const planName = data?.bot?.plan_name || bot?.plan_name || "Custom";
  const currentExpiry = formatDate(data?.bot?.valid_till || bot?.valid_till);
  const remaining = data?.bot?.hours_left != null ? formatRemaining(Number(data.bot.hours_left)) : "-";
  const renewalSummary = useMemo(() => ({
    plan: planName,
    duration: selectedOption?.days ? `${selectedOption.days} Days` : duration === "7d" ? "7 Days" : "30 Days",
    amount: selectedOption?.price ? formatUSD(Number(selectedOption.price)) : "-",
    newExpiry: selectedOption?.new_valid_till || payment?.new_valid_till_preview || payment?.new_valid_till || "-",
  }), [duration, payment?.new_valid_till, payment?.new_valid_till_preview, planName, selectedOption?.days, selectedOption?.new_valid_till, selectedOption?.price]);

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  const checkStatus = async () => {
    if (!session || !payment) return;
    setChecking(true);
    try {
      const res = await portalApi.get(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal-status/${payment.order_id}?telegram_id=${session.telegram_id}`
      );
      const nextStatus = res.data.status || "payment_waiting";
      setStatus(nextStatus);
      if (nextStatus === "completed") {
        setPayment((p) => p ? { ...p, ...res.data } : p);
        setStep("success");
        mutate();
        mutateBot();
      } else {
        toast.success("Status refreshed");
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not refresh status");
    } finally {
      setChecking(false);
    }
  };

  const createPayment = async () => {
    if (!session || !selectedOption?.available || hasOpenInvoice) return;
    setCreating(true);
    try {
      const res = await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renew?telegram_id=${session.telegram_id}`,
        { duration_days: selectedOption.days, currency }
      );
      if (res.data.status === "completed") {
        setStatus("completed");
        setStep("success");
        mutate();
        mutateBot();
        return;
      }
      setPayment(res.data);
      setStatus(res.data.status || "payment_waiting");
      setStep("invoice");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Could not create invoice");
    } finally {
      setCreating(false);
    }
  };

  const cancelPayment = async (nextStep: Step = "duration") => {
    if (!session || !payment) return;
    setCancelling(true);
    try {
      await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal/${payment.order_id}/cancel?telegram_id=${session.telegram_id}`
      );
      setPayment(null);
      setStatus("idle");
      setStep(nextStep);
      mutate();
      toast.success("Invoice cancelled");
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
    setStep(data.active_invoice.status === "completed" ? "success" : "invoice");
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
          setStep("success");
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
    <div className="min-h-[calc(100vh-7rem)] bg-[#050509] px-3 py-4 sm:px-5 sm:py-7">
      <div className="mx-auto w-full max-w-[860px]">
        <Link href="/user/billing" className="mb-4 inline-flex items-center gap-2 text-xs font-semibold text-dark-400 hover:text-white">
          <ArrowLeft className="h-4 w-4" /> Back to Billing
        </Link>

        <section className="overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#0d0d14] shadow-2xl shadow-black/40">
          <header className="border-b border-white/[0.07] px-4 py-5 sm:px-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Renew Advert Plan</h1>
                <p className="mt-1 text-sm text-dark-400">Extend your current plan securely.</p>
              </div>
              {hasOpenInvoice && (
                <span className="w-fit rounded-full border border-warning/25 bg-warning/10 px-3 py-1 text-[11px] font-bold text-warning">
                  Existing invoice
                </span>
              )}
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              <SummaryTile label="Current Plan" value={planName} />
              <SummaryTile label="Valid Until" value={currentExpiry} />
              <SummaryTile label="Remaining" value={remaining} />
            </div>
          </header>

          <div className="border-b border-white/[0.07] px-4 py-4 sm:px-6">
            <StepIndicator step={step} />
          </div>

          <main className="px-4 py-5 sm:px-6 sm:py-6">
            {step === "duration" && (
              <DurationStep
                data={data}
                bot={bot}
                duration={duration}
                setDuration={setDuration}
                hasOpenInvoice={hasOpenInvoice}
                onContinue={() => hasOpenInvoice ? setStep("invoice") : setStep("crypto")}
              />
            )}

            {step === "crypto" && (
              <CryptoStep
                currency={currency}
                setCurrency={setCurrency}
                summary={renewalSummary}
                onBack={() => setStep("duration")}
                onCreate={createPayment}
                creating={creating}
                disabled={!selectedOption?.available || hasOpenInvoice}
              />
            )}

            {step === "invoice" && payment && (
              <InvoiceStep
                payment={payment}
                status={status}
                summary={renewalSummary}
                selectedCurrency={selectedCurrency}
                qrUrl={qrUrl}
                onCopy={copy}
                onCheckStatus={checkStatus}
                checking={checking}
                onRefresh={checkStatus}
                onChangeMethod={() => cancelPayment("crypto")}
                onCancel={() => cancelPayment("duration")}
                cancelling={cancelling}
              />
            )}

            {step === "success" && (
              <SuccessStep payment={payment} onDashboard={() => router.push("/user/dashboard")} />
            )}
          </main>
        </section>
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps = [
    { id: "duration", label: "Duration" },
    { id: "crypto", label: "Crypto" },
    { id: "invoice", label: "Invoice" },
  ] as const;
  const current = step === "success" ? 3 : steps.findIndex((item) => item.id === step);
  return (
    <div className="flex items-center">
      {steps.map((item, index) => {
        const active = index === current;
        const done = index < current || step === "success";
        return (
          <div key={item.id} className="flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                active && "bg-accent text-white shadow-lg shadow-accent/25",
                done && "bg-success/15 text-success",
                !active && !done && "bg-white/[0.05] text-dark-500"
              )}>
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <span className={cn("truncate text-xs font-bold sm:text-sm", active ? "text-white" : done ? "text-success" : "text-dark-500")}>
                {item.label}
              </span>
            </div>
            {index < steps.length - 1 && <span className={cn("mx-2 h-px flex-1 sm:mx-4", done ? "bg-success/30" : "bg-white/[0.08]")} />}
          </div>
        );
      })}
    </div>
  );
}

function DurationStep({ data, bot, duration, setDuration, hasOpenInvoice, onContinue }: {
  data: any;
  bot: any;
  duration: "7d" | "30d";
  setDuration: (duration: "7d" | "30d") => void;
  hasOpenInvoice: boolean;
  onContinue: () => void;
}) {
  const selected = data?.options?.[duration];
  return (
    <div className="space-y-5">
      <SectionHeading title="Choose Renewal Duration" text="Select how long you want to extend your current plan." />

      <div className="grid gap-3 sm:grid-cols-2">
        {(["7d", "30d"] as const).map((key) => {
          const opt = data?.options?.[key];
          const active = duration === key;
          return (
            <button
              key={key}
              type="button"
              disabled={!opt?.available || hasOpenInvoice}
              onClick={() => setDuration(key)}
              className={cn(
                "min-h-[156px] rounded-2xl border bg-[#14141f] p-4 text-left transition-all",
                active ? "border-accent bg-accent/[0.12] shadow-lg shadow-accent/10" : "border-white/[0.08] hover:border-accent/40",
                (!opt?.available || hasOpenInvoice) && "opacity-60"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border", active ? "border-accent bg-accent text-white" : "border-white/[0.16]")}>
                  {active && <Check className="h-3.5 w-3.5" />}
                </span>
                {key === "30d" && <span className="rounded-full bg-accent/15 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-accent-100">Best Value</span>}
              </div>
              <p className="mt-5 text-lg font-bold text-white">{opt?.days || (key === "7d" ? 7 : 30)} Days</p>
              <p className="mt-2 text-3xl font-black tracking-tight text-white">{opt?.available ? formatUSD(Number(opt.price)) : "Unavailable"}</p>
              <p className="mt-3 text-xs font-medium text-dark-400">New expiry: <span className="text-dark-100">{opt?.new_valid_till || "-"}</span></p>
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3 text-xs text-dark-300">
        Your renewal will begin after your current subscription expires on <span className="font-bold text-white">{formatDate(data?.bot?.valid_till || bot.valid_till)}</span>.
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Link href="/user/billing" className="inline-flex h-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 text-sm font-bold text-dark-200 hover:bg-white/[0.07]">
          Back to Billing
        </Link>
        <Button className="h-11 rounded-xl px-5 font-bold" onClick={onContinue} disabled={!selected?.available}>
          {hasOpenInvoice ? "Open Invoice" : "Continue to Crypto"} <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function CryptoStep({ currency, setCurrency, summary, onBack, onCreate, creating, disabled }: {
  currency: string;
  setCurrency: (currency: string) => void;
  summary: { plan: string; duration: string; amount: string; newExpiry: string };
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-5">
      <SectionHeading title="Choose Payment Currency" text="Select the cryptocurrency and network you want to use." />
      <CompactSummary rows={[
        ["Plan", summary.plan],
        ["Renewal", summary.duration],
        ["Amount", summary.amount],
        ["New Expiry", summary.newExpiry],
      ]} />

      <div className="grid gap-2.5 sm:grid-cols-2">
        {CURRENCIES.map((item) => {
          const active = currency === item.code;
          return (
            <button
              key={item.code}
              type="button"
              onClick={() => setCurrency(item.code)}
              className={cn(
                "flex min-h-[76px] items-center gap-3 rounded-2xl border bg-[#14141f] p-3 text-left transition-all",
                active ? "border-accent bg-accent/[0.12] shadow-lg shadow-accent/10" : "border-white/[0.08] hover:border-accent/40"
              )}
            >
              <CryptoLogo code={item.code} className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-white">{item.name}</p>
                <p className="text-xs text-dark-400">{item.symbol} · Network: {item.network}</p>
              </div>
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", active ? "border-accent bg-accent text-white" : "border-white/[0.16]")}>
                {active && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          );
        })}
      </div>

      <WarningBox text="Only send payment using the selected currency and network." />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="secondary" className="h-11 rounded-xl px-5" onClick={onBack}>Back</Button>
        <Button className="h-11 rounded-xl px-5 font-bold" onClick={onCreate} loading={creating} disabled={disabled}>
          Generate Invoice
        </Button>
      </div>
    </div>
  );
}

function InvoiceStep({ payment, status, summary, selectedCurrency, qrUrl, onCopy, onCheckStatus, checking, onRefresh, onChangeMethod, onCancel, cancelling }: {
  payment: Payment;
  status: string;
  summary: { plan: string; duration: string; amount: string; newExpiry: string };
  selectedCurrency: { symbol: string; network: string; code: string };
  qrUrl: string;
  onCopy: (value: string, label: string) => void;
  onCheckStatus: () => void;
  checking: boolean;
  onRefresh: () => void;
  onChangeMethod: () => void;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const network = selectedCurrency.network || networkFromPayCurrency(payment.pay_currency);
  return (
    <div className="space-y-5">
      <SectionHeading title="Complete Payment" text="Send the exact amount using the selected currency and network." />
      <CompactSummary rows={[
        ["Current Plan", summary.plan],
        ["Renewal", summary.duration],
        ["New Expiry", summary.newExpiry],
        ["USD Total", formatUSD(Number(payment.amount_usd))],
        ["Payment Currency", payment.pay_currency],
        ["Network", network],
      ]} />

      <div className="rounded-[22px] border border-white/[0.08] bg-[#11111a] p-4">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-dark-500">Pay</p>
          <p className="mt-1 text-4xl font-black tracking-tight text-white">{formatUSD(Number(payment.amount_usd))}</p>
          <p className="mt-2 text-sm text-dark-400">Send exactly <span className="font-bold text-white">{payment.pay_amount} {payment.pay_currency}</span></p>
        </div>

        <div className="mt-5 rounded-2xl border border-white/[0.07] bg-[#0a0a10]">
          <DetailRow label="Network" value={network} />
          <DetailRow label="Status" value={<StatusPill status={status} />} />
          <DetailRow label="Invoice ID" value={shortId(payment.order_id)} mono />
          <DetailRow label="Expires" value={payment.invoice_expires_at ? formatDate(payment.invoice_expires_at) : "Active quote"} />
        </div>
      </div>

      <div className="rounded-[22px] border border-white/[0.08] bg-[#11111a] p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-dark-400">Wallet address</p>
            <p className="text-[11px] text-dark-500">Network: {network}</p>
          </div>
          <button
            type="button"
            onClick={() => onCopy(payment.pay_address, "Address")}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs font-bold text-dark-200 hover:bg-white/[0.09]"
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
        <code className="block break-all rounded-xl bg-[#07070c] p-3 font-mono text-xs leading-5 text-white">{payment.pay_address}</code>

        <div className="mt-4 flex flex-col items-center rounded-2xl border border-white/[0.07] bg-[#08080d] p-4">
          <div className="rounded-[18px] bg-white p-3">
            {qrUrl && <img src={qrUrl} alt="Payment QR code" className="h-[190px] w-[190px] sm:h-[220px] sm:w-[220px]" />}
          </div>
          <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/[0.05] px-3 py-1 text-xs font-bold text-dark-300">
            <QrCode className="h-3.5 w-3.5" /> Scan to pay with {payment.pay_currency}
          </p>
        </div>
      </div>

      <WarningBox text={`Send only ${payment.pay_currency} using the ${network} network. Using another currency or network may result in permanent loss of funds.`} />

      <div className="sticky bottom-0 -mx-4 -mb-5 border-t border-white/[0.07] bg-[#0d0d14]/95 p-4 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button className="h-12 w-full rounded-xl font-bold" onClick={onCheckStatus} loading={checking}>
          I&apos;ve Paid, Check Status
        </Button>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Button variant="secondary" className="h-10 rounded-xl" onClick={onRefresh} loading={checking}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button variant="secondary" className="h-10 rounded-xl" onClick={onChangeMethod} loading={cancelling}>
            Change Method
          </Button>
          <Button variant="danger" className="h-10 rounded-xl" onClick={onCancel} loading={cancelling}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function SuccessStep({ payment, onDashboard }: { payment: Payment | null; onDashboard: () => void }) {
  return (
    <div className="mx-auto max-w-md py-8 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-success/25 bg-success/15 text-success">
        <CheckCircle className="h-8 w-8" />
      </div>
      <h2 className="mt-5 text-2xl font-bold text-white">Payment Confirmed</h2>
      <p className="mt-2 text-sm text-dark-400">Renewal successful.</p>
      <div className="mt-5 rounded-2xl border border-white/[0.08] bg-[#11111a] text-left">
        <DetailRow label="New Expiry Date" value={payment?.new_valid_till || payment?.new_valid_till_preview || "Updated"} />
        <DetailRow label="Invoice ID" value={payment?.order_id ? shortId(payment.order_id) : "-"} mono />
      </div>
      <Button className="mt-5 h-12 w-full rounded-xl font-bold" onClick={onDashboard}>Go to Dashboard</Button>
    </div>
  );
}

function SectionHeading({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{title}</h2>
      <p className="mt-1 text-sm text-dark-400">{text}</p>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3">
      <p className="text-[10px] font-black uppercase tracking-wide text-dark-500">{label}</p>
      <p className="mt-1 truncate text-sm font-bold text-white">{value}</p>
    </div>
  );
}

function CompactSummary({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-wide text-dark-500">{label}</p>
          <p className="truncate text-sm font-bold text-white">{value}</p>
        </div>
      ))}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 last:border-0">
      <span className="text-xs font-semibold text-dark-400">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-sm font-bold text-white", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function WarningBox({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-warning/20 bg-warning/[0.06] p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <p className="text-xs font-medium leading-5 text-warning/90">{text}</p>
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
      {completed ? "Completed" : confirming ? "Confirming" : "Waiting for Payment"}
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
  };
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label={`${base} logo`}>
      <rect width="40" height="40" rx="14" fill={color[base] || "#7C5CFF"} />
      <circle cx="20" cy="20" r="13" fill="rgba(255,255,255,0.16)" />
      {base === "BTC" && <text x="20" y="27" textAnchor="middle" fontSize="22" fontWeight="800" fill="white">B</text>}
      {base === "ETH" && <path d="M20 7 11.5 20.5 20 25l8.5-4.5L20 7Zm0 26 8.5-10.1L20 27.4l-8.5-4.5L20 33Z" fill="white" />}
      {base === "LTC" && <text x="20" y="27" textAnchor="middle" fontSize="23" fontWeight="800" fill="white">L</text>}
      {base === "TRX" && <path d="M10 9 31 14.5 18.5 31 10 9Zm4.2 4.2 5 13.2 7.2-9.5-12.2-3.7Z" fill="white" />}
      {base === "BNB" && <path d="m20 8 5 5-5 5-5-5Zm-8 8 5 5-5 5-5-5 5-5Zm16 0 5 5-5 5-5-5 5-5Zm-8 8 5 5-5 5-5-5 5-5Z" fill="white" />}
      {base === "USDT" && <path d="M11 12h18v4h-7v2.1c4.4.2 7.6 1.1 7.6 2.2s-3.2 2-7.6 2.2V29h-4v-6.5c-4.4-.2-7.6-1.1-7.6-2.2s3.2-2 7.6-2.2V16h-7v-4Zm9 8.7c2.8 0 5.1-.3 5.1-.7s-2.3-.7-5.1-.7-5.1.3-5.1.7 2.3.7 5.1.7Z" fill="white" />}
    </svg>
  );
}

function formatRemaining(hours: number) {
  if (hours <= 0) return "Expired";
  if (hours < 48) return `${Math.ceil(hours)} hours`;
  return `${Math.ceil(hours / 24)} days`;
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}-${id.slice(-4)}` : id;
}

function networkFromPayCurrency(currency: string) {
  if (currency.includes("TRC20") || currency === "TRX") return "TRC20";
  if (currency.includes("BEP20") || currency === "BNB") return "BEP20";
  if (currency.includes("ERC20") || currency === "ETH") return "ERC20";
  if (currency === "BTC") return "Bitcoin";
  if (currency === "LTC") return "Litecoin";
  return currency;
}
