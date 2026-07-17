"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle,
  Coins,
  Copy,
  Loader2,
  QrCode,
  ReceiptText,
  RefreshCw,
} from "lucide-react";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import { usePortalBot, useRenewalOptions } from "@/lib/hooks/usePortal";
import { cn, formatDate, formatUSD } from "@/lib/utils";

const PAYMENT_METHODS = [
  { code: "USDT_TRC20", assetName: "Tether", assetCode: "USDT", networkName: "TRON", networkCode: "TRC20" },
  { code: "USDT_BEP20", assetName: "Tether", assetCode: "USDT", networkName: "BNB Smart Chain", networkCode: "BEP20" },
  { code: "USDT_ERC20", assetName: "Tether", assetCode: "USDT", networkName: "Ethereum", networkCode: "ERC20" },
  { code: "BTC", assetName: "Bitcoin", assetCode: "BTC", networkName: "Bitcoin", networkCode: "Bitcoin" },
  { code: "ETH", assetName: "Ethereum", assetCode: "ETH", networkName: "Ethereum", networkCode: "ERC20" },
  { code: "LTC", assetName: "Litecoin", assetCode: "LTC", networkName: "Litecoin", networkCode: "Litecoin" },
  { code: "TRX", assetName: "TRON", assetCode: "TRX", networkName: "TRON", networkCode: "TRC20" },
  { code: "BNB", assetName: "BNB", assetCode: "BNB", networkName: "BNB Smart Chain", networkCode: "BEP20" },
];

type Step = "duration" | "method" | "invoice" | "success";

type PaymentMethod = typeof PAYMENT_METHODS[number];

type Payment = {
  order_id: string;
  amount_usd: number;
  pay_amount: number | string;
  pay_currency: string;
  pay_address: string;
  invoice_expires_at?: string;
  duration_days: number;
  status?: string;
  amount_received?: number | string;
  new_valid_till?: string;
  new_valid_till_preview?: string;
};

export default function RenewalPage() {
  const router = useRouter();
  const session = getPortalSession();
  const { data: bot, mutate: mutateBot } = usePortalBot();
  const { data, isLoading, mutate } = useRenewalOptions();
  const [selectedDuration, setSelectedDuration] = useState<"7d" | "30d">("30d");
  const [selectedMethodCode, setSelectedMethodCode] = useState("USDT_TRC20");
  const [step, setStep] = useState<Step>("duration");
  const [invoice, setInvoice] = useState<Payment | null>(null);
  const [invoiceStatus, setInvoiceStatus] = useState("idle");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const selectedOption = data?.options?.[selectedDuration];
  const selectedMethod = PAYMENT_METHODS.find((item) => item.code === selectedMethodCode) || PAYMENT_METHODS[0];
  const isCompleted = invoiceStatus === "completed" || invoiceStatus === "paid";
  const hasOpenInvoice = !!invoice && !isCompleted;
  const planName = data?.bot?.plan_name || bot?.plan_name || "Custom";
  const currentExpiry = formatDate(data?.bot?.valid_till || bot?.valid_till);
  const remaining = data?.bot?.hours_left != null ? formatRemaining(Number(data.bot.hours_left)) : "";
  const pageTitle = `Renew ${planName} Plan`;

  const summary = useMemo(() => ({
    planName,
    durationLabel: selectedOption?.days ? `${selectedOption.days} days` : selectedDuration === "7d" ? "7 days" : "30 days",
    amountUsd: selectedOption?.price ? formatUSD(Number(selectedOption.price)) : "-",
    newExpiry: selectedOption?.new_valid_till || invoice?.new_valid_till_preview || invoice?.new_valid_till || "-",
  }), [invoice?.new_valid_till, invoice?.new_valid_till_preview, planName, selectedDuration, selectedOption?.days, selectedOption?.new_valid_till, selectedOption?.price]);

  const qrValue = invoice?.pay_address || "";
  const qrUrl = qrValue ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=16&data=${encodeURIComponent(qrValue)}` : "";

  const copyAddress = async () => {
    if (!invoice?.pay_address) return;
    await navigator.clipboard.writeText(invoice.pay_address);
    setCopied(true);
    toast.success("Address copied");
    setTimeout(() => setCopied(false), 1800);
  };

  const requestStatus = async (silent = false) => {
    if (!session || !invoice) return;
    setChecking(true);
    setError("");
    try {
      const res = await portalApi.get(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal-status/${invoice.order_id}?telegram_id=${session.telegram_id}`
      );
      const nextStatus = res.data.status || "payment_waiting";
      setInvoiceStatus(nextStatus);
      setInvoice((previous) => previous ? { ...previous, ...res.data } : previous);
      if (nextStatus === "completed" || nextStatus === "paid") {
        setStep("success");
        mutate();
        mutateBot();
      } else if (!silent) {
        toast.success("Status checked");
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Could not check payment status.");
    } finally {
      setChecking(false);
    }
  };

  const createInvoice = async () => {
    if (!session || !selectedOption?.available || hasOpenInvoice) return;
    setCreating(true);
    setError("");
    try {
      const res = await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renew?telegram_id=${session.telegram_id}`,
        { duration_days: selectedOption.days, currency: selectedMethodCode }
      );
      if (res.data.status === "completed") {
        setInvoiceStatus("completed");
        setStep("success");
        mutate();
        mutateBot();
        return;
      }
      setInvoice(res.data);
      setInvoiceStatus(res.data.status || "payment_waiting");
      setStep("invoice");
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Could not create payment invoice.");
    } finally {
      setCreating(false);
    }
  };

  const cancelInvoice = async (nextStep: Step = "duration") => {
    if (!session || !invoice) return;
    setCancelling(true);
    setError("");
    try {
      await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal/${invoice.order_id}/cancel?telegram_id=${session.telegram_id}`
      );
      setInvoice(null);
      setInvoiceStatus("idle");
      setStep(nextStep);
      mutate();
      toast.success("Invoice cancelled");
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Could not cancel invoice.");
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    if (!data?.active_invoice || invoice) return;
    setInvoice(data.active_invoice);
    setInvoiceStatus(data.active_invoice.status || "payment_waiting");
    setStep(data.active_invoice.status === "completed" ? "success" : "invoice");
  }, [data?.active_invoice, invoice]);

  useEffect(() => {
    if (!invoice || isCompleted) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [invoice, isCompleted]);

  useEffect(() => {
    if (!invoice || !session || isCompleted) return;
    const poll = setInterval(() => requestStatus(true), 8000);
    return () => clearInterval(poll);
  }, [invoice?.order_id, isCompleted, session?.bot_name, session?.telegram_id]);

  if (isLoading || !bot) return <PageSkeleton />;

  return (
    <div className="min-h-[calc(100vh-7rem)] bg-[#07080D] px-4 py-4 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-6 sm:py-6 sm:pb-6 lg:px-8">
      <div className={cn("mx-auto w-full", step === "invoice" ? "max-w-[980px]" : "max-w-[780px]")}>
        <Link href="/user/billing" className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#9298AD] hover:text-[#F7F8FC]">
          <ArrowLeft className="h-4 w-4" /> Billing
        </Link>

        <section className="overflow-hidden rounded-2xl border border-[#262A3A] bg-[#0E1018] shadow-xl shadow-black/25 max-[640px]:rounded-xl">
          <RenewalHeader
            pageTitle={pageTitle}
            planName={planName}
            currentExpiry={currentExpiry}
            remaining={remaining}
            hasOpenInvoice={hasOpenInvoice}
          />

          <div className="border-b border-[#262A3A] px-4 py-3 sm:px-5">
            <RenewalProgress step={step} />
          </div>

          <main className={cn("mx-auto w-full px-4 py-4 sm:px-5 sm:py-5", step === "invoice" ? "max-w-[940px]" : "max-w-[620px]")}>
            {error && <RenewalError message={error} />}

            {step === "duration" && (
              <DurationSelector
                options={data?.options || {}}
                bot={bot}
                currentExpiry={currentExpiry}
                planName={planName}
                selectedDuration={selectedDuration}
                setSelectedDuration={setSelectedDuration}
                hasOpenInvoice={hasOpenInvoice}
                onContinue={() => hasOpenInvoice ? setStep("invoice") : setStep("method")}
              />
            )}

            {step === "method" && (
              <PaymentMethodSelector
                selectedMethodCode={selectedMethodCode}
                setSelectedMethodCode={setSelectedMethodCode}
                summary={summary}
                selectedMethod={selectedMethod}
                onBack={() => setStep("duration")}
                onCreate={createInvoice}
                creating={creating}
                disabled={!selectedOption?.available || hasOpenInvoice}
              />
            )}

            {step === "invoice" && invoice && (
              <InvoicePaymentPanel
                invoice={invoice}
                status={invoiceStatus}
                method={methodForInvoice(invoice, selectedMethod)}
                summary={summary}
                qrUrl={qrUrl}
                now={now}
                copied={copied}
                onCopy={copyAddress}
                onCheckStatus={() => requestStatus(false)}
                checking={checking}
                onChangeMethod={() => cancelInvoice("method")}
                onCancel={() => cancelInvoice("duration")}
                cancelling={cancelling}
              />
            )}

            {step === "success" && (
              <RenewalSuccess invoice={invoice} planName={planName} onDashboard={() => router.push("/user/dashboard")} />
            )}
          </main>
        </section>
      </div>
    </div>
  );
}

function RenewalHeader({ pageTitle, planName, currentExpiry, remaining, hasOpenInvoice }: {
  pageTitle: string;
  planName: string;
  currentExpiry: string;
  remaining: string;
  hasOpenInvoice: boolean;
}) {
  return (
    <header className="border-b border-[#262A3A] px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-[#F7F8FC] sm:text-[26px]">{pageTitle}</h1>
          <p className="mt-1 text-[13px] text-[#9298AD] sm:text-sm">Extend your subscription without interrupting your active service.</p>
        </div>
        {hasOpenInvoice && (
          <span className="w-fit rounded-full border border-[#F2B94B]/30 bg-[#F2B94B]/10 px-3 py-1 text-xs font-bold text-[#F2B94B]">
            Active invoice
          </span>
        )}
      </div>
      <CurrentPlanSummary planName={planName} currentExpiry={currentExpiry} remaining={remaining} />
    </header>
  );
}

function CurrentPlanSummary({ planName, currentExpiry, remaining }: { planName: string; currentExpiry: string; remaining: string }) {
  return (
    <div className="mt-4 rounded-xl border border-[#262A3A] bg-[#151824] px-4 py-3">
      <p className="font-bold text-[#F7F8FC]">{planName} Plan</p>
      <p className="mt-1 text-sm text-[#9298AD] sm:hidden">Expires {currentExpiry}{remaining ? ` - ${remaining} remaining` : ""}</p>
      <p className="mt-1 hidden text-sm text-[#9298AD] sm:block">Active until {currentExpiry}</p>
      {remaining && <p className="hidden text-sm text-[#D9DCEA] sm:block">{remaining} remaining</p>}
    </div>
  );
}

function RenewalProgress({ step }: { step: Step }) {
  const steps = [
    { id: "duration", label: "Duration", icon: CalendarDays },
    { id: "method", label: "Payment method", icon: Coins },
    { id: "invoice", label: "Payment invoice", icon: ReceiptText },
  ] as const;
  const current = step === "success" ? 3 : steps.findIndex((item) => item.id === step);
  const active = steps[Math.min(current, 2)];
  const ActiveIcon = active.icon;

  return (
    <>
      <div className="hidden items-center sm:flex">
        {steps.map((item, index) => {
          const done = index < current || step === "success";
          const activeStep = index === current;
          return (
            <div key={item.id} className="flex min-w-0 flex-1 items-center">
              <span className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                activeStep && "bg-[#7657FF] text-white",
                done && "bg-[#25C9A0]/15 text-[#25C9A0]",
                !activeStep && !done && "bg-[#151824] text-[#9298AD]"
              )}>
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <span className={cn("ml-2 truncate text-sm font-semibold", activeStep ? "text-[#F7F8FC]" : done ? "text-[#D9DCEA]" : "text-[#9298AD]")}>
                {item.label}
              </span>
              {index < steps.length - 1 && <span className={cn("mx-4 h-px flex-1", done ? "bg-[#7657FF]" : "bg-[#262A3A]")} />}
            </div>
          );
        })}
      </div>

      <div className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#7657FF] text-white">
              <ActiveIcon className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-semibold text-[#9298AD]">Step {Math.min(current + 1, 3)} of 3</p>
              <p className="text-sm font-bold text-[#F7F8FC]">{active.label}</p>
            </div>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#151824]">
          <div className="h-full rounded-full bg-[#7657FF]" style={{ width: `${((Math.min(current, 2) + 1) / 3) * 100}%` }} />
        </div>
      </div>
    </>
  );
}

function DurationSelector({ options, bot, currentExpiry, planName, selectedDuration, setSelectedDuration, hasOpenInvoice, onContinue }: {
  options: any;
  bot: any;
  currentExpiry: string;
  planName: string;
  selectedDuration: "7d" | "30d";
  setSelectedDuration: (duration: "7d" | "30d") => void;
  hasOpenInvoice: boolean;
  onContinue: () => void;
}) {
  const selected = options?.[selectedDuration];
  const weekly = Number(options?.["7d"]?.price || 0) / 7;
  const monthly = Number(options?.["30d"]?.price || 0) / 30;
  const monthlyBest = weekly > 0 && monthly > 0 && monthly < weekly;

  return (
    <div className="space-y-4">
      <SectionTitle title="Choose renewal duration" text={`Select how long you want to extend your ${planName} plan.`} />

      <div className="grid justify-center gap-3 sm:grid-cols-2">
        {(["7d", "30d"] as const).map((key) => {
          const option = options?.[key];
          const active = selectedDuration === key;
          const showBest = key === "30d" && monthlyBest;
          return (
            <button
              key={key}
              type="button"
              disabled={!option?.available || hasOpenInvoice}
              onClick={() => setSelectedDuration(key)}
              className={cn(
                "min-h-[136px] rounded-xl border bg-[#11131D] p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-[#7657FF]/50 sm:max-w-[250px]",
                active ? "border-[#7657FF] bg-[#7657FF]/10" : "border-[#262A3A] hover:border-[#7657FF]/60",
                (!option?.available || hasOpenInvoice) && "opacity-60"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", active ? "border-[#7657FF] bg-[#7657FF] text-white" : "border-[#52586B]")}>
                  {active && <Check className="h-3 w-3" />}
                </span>
                {showBest && <span className="rounded-full bg-[#7657FF]/14 px-2 py-1 text-xs font-bold text-[#D9DCEA]">Best value</span>}
              </div>
              <p className="mt-4 text-lg font-bold text-[#F7F8FC]">{option?.days || (key === "7d" ? 7 : 30)} days</p>
              <p className="mt-1 text-2xl font-black text-[#F7F8FC]">{option?.available ? formatUSD(Number(option.price)) : "Unavailable"}</p>
              <p className="mt-2 text-sm text-[#9298AD]">Active through <span className="text-[#D9DCEA]">{formatDate(option?.new_valid_till) || "-"}</span></p>
            </button>
          );
        })}
      </div>

      <p className="rounded-xl border border-[#262A3A] bg-[#151824] p-3 text-sm text-[#D9DCEA]">
        Your renewal will begin after your current subscription ends on <span className="font-bold text-[#F7F8FC]">{currentExpiry || formatDate(bot.valid_till)}</span>.
      </p>

      <StepActions
        primaryLabel="Continue"
        onPrimary={onContinue}
        primaryDisabled={!selected?.available}
      />
    </div>
  );
}

function PaymentMethodSelector({ selectedMethodCode, setSelectedMethodCode, summary, selectedMethod, onBack, onCreate, creating, disabled }: {
  selectedMethodCode: string;
  setSelectedMethodCode: (method: string) => void;
  summary: RenewalSummary;
  selectedMethod: PaymentMethod;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="space-y-4">
      <SectionTitle title="Choose payment method" text="Select the cryptocurrency and network you want to use." />
      <RenewalOrderSummary summary={summary} />

      <div className="grid gap-2 sm:grid-cols-2">
        {PAYMENT_METHODS.map((method) => (
          <PaymentMethodCard
            key={method.code}
            method={method}
            selected={selectedMethodCode === method.code}
            onSelect={() => setSelectedMethodCode(method.code)}
          />
        ))}
      </div>

      {selectedMethod && (
        <PaymentWarning>
          Send only {selectedMethod.assetCode} using the {selectedMethod.networkCode} network. Other assets or networks may result in permanent loss of funds.
        </PaymentWarning>
      )}

      <StepActions
        secondaryLabel="Back"
        onSecondary={onBack}
        primaryLabel={creating ? "Creating invoice..." : "Create payment invoice"}
        onPrimary={onCreate}
        primaryDisabled={disabled || creating}
        primaryLoading={creating}
      />
    </div>
  );
}

type RenewalSummary = {
  planName: string;
  durationLabel: string;
  amountUsd: string;
  newExpiry: string;
};

function RenewalOrderSummary({ summary }: { summary: RenewalSummary }) {
  return (
    <div className="rounded-xl border border-[#262A3A] bg-[#151824] p-3">
      <p className="text-sm font-bold text-[#F7F8FC]">{summary.planName} Plan - {summary.durationLabel}</p>
      <p className="mt-1 text-sm text-[#D9DCEA]">{summary.amountUsd} USD</p>
      <p className="text-sm text-[#9298AD]">Renews through {formatDate(summary.newExpiry)}</p>
    </div>
  );
}

function PaymentMethodCard({ method, selected, onSelect }: { method: PaymentMethod; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex min-h-[60px] items-center gap-3 rounded-xl border bg-[#11131D] p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-[#7657FF]/50",
        selected ? "border-[#7657FF] bg-[#7657FF]/10" : "border-[#262A3A] hover:border-[#7657FF]/60"
      )}
    >
      <CryptoLogo code={method.assetCode} className="h-8 w-8" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-[#F7F8FC]">{method.assetCode}</p>
        <p className="text-[13px] text-[#9298AD]">{method.networkCode} network</p>
      </div>
      <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", selected ? "border-[#7657FF] bg-[#7657FF] text-white" : "border-[#52586B]")}>
        {selected && <Check className="h-3 w-3" />}
      </span>
    </button>
  );
}

function InvoicePaymentPanel({ invoice, status, method, summary, qrUrl, now, copied, onCopy, onCheckStatus, checking, onChangeMethod, onCancel, cancelling }: {
  invoice: Payment;
  status: string;
  method: PaymentMethod;
  summary: RenewalSummary;
  qrUrl: string;
  now: number;
  copied: boolean;
  onCopy: () => void;
  onCheckStatus: () => void;
  checking: boolean;
  onChangeMethod: () => void;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const statusInfo = getStatusInfo(status, invoice);
  const countdown = formatRemainingTime(invoice.invoice_expires_at, now);
  const expiryExact = formatDateTime(invoice.invoice_expires_at);
  const cryptoAmount = formatCryptoAmount(invoice.pay_amount);
  const shortAddress = middleTruncate(invoice.pay_address);

  return (
    <div className="space-y-4">
      <SectionTitle title="Complete payment" text="Send the exact amount using the selected currency and network." />

      <div className="grid gap-4 md:grid-cols-[46%_54%]">
        <div className="order-2 space-y-4 md:order-1">
          <div className="rounded-xl border border-[#262A3A] bg-[#151824] p-4">
            <div className="mx-auto flex w-fit items-center justify-center rounded-xl bg-white p-3">
              {qrUrl && <img src={qrUrl} alt="Payment QR code" className="h-[200px] w-[200px] sm:h-[230px] sm:w-[230px]" />}
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-[#D9DCEA]">Scan to pay with {method.assetCode} on {method.networkCode}</p>
          </div>

          <WalletAddress
            address={invoice.pay_address}
            shortAddress={shortAddress}
            network={method.networkCode}
            copied={copied}
            onCopy={onCopy}
          />
        </div>

        <div className="order-1 space-y-4 md:order-2">
          <InvoiceStatus statusInfo={statusInfo} countdown={countdown} expiryExact={expiryExact} onRefresh={onCheckStatus} refreshing={checking} />

          <div className="rounded-xl border border-[#262A3A] bg-[#151824]">
            <PaymentAmount label="Amount due" value={`${formatUSD(Number(invoice.amount_usd))} USD`} />
            <PaymentAmount label="Send exactly" value={`${cryptoAmount} ${assetFromPayCurrency(invoice.pay_currency, method.assetCode)}`} sub={`via the ${method.networkCode} network`} />
            <PaymentAmount label="Network" value={method.networkCode} />
            <PaymentAmount label="Invoice ID" value={shortId(invoice.order_id)} mono />
            <PaymentAmount label="Renews through" value={formatDate(invoice.new_valid_till || invoice.new_valid_till_preview || summary.newExpiry)} />
          </div>

          <PaymentWarning>
            Send only {method.assetCode} using the {method.networkCode} network. Sending another asset or using another network may permanently lose your funds.
          </PaymentWarning>

          <PaymentActions
            onCheckStatus={onCheckStatus}
            checking={checking}
            onChangeMethod={onChangeMethod}
            onCancel={onCancel}
            cancelling={cancelling}
          />
        </div>
      </div>
    </div>
  );
}

function InvoiceStatus({ statusInfo, countdown, expiryExact, onRefresh, refreshing }: {
  statusInfo: { title: string; description: string; tone: "warning" | "success" | "error" | "accent" };
  countdown: string;
  expiryExact: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="rounded-xl border border-[#262A3A] bg-[#151824] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn("text-sm font-bold", statusInfo.tone === "success" ? "text-[#25C9A0]" : statusInfo.tone === "error" ? "text-[#F06472]" : statusInfo.tone === "accent" ? "text-[#856BFF]" : "text-[#F2B94B]")}>
            {statusInfo.title}
          </p>
          <p className="mt-1 text-sm text-[#9298AD]">{statusInfo.description}</p>
        </div>
        <button
          type="button"
          aria-label="Refresh payment status"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#262A3A] text-[#9298AD] hover:text-[#F7F8FC] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </button>
      </div>
      <div className="mt-3 rounded-lg bg-[#11131D] p-3">
        <p className="text-sm font-bold text-[#F7F8FC]">Invoice expires in {countdown}</p>
        {expiryExact && <p className="mt-1 text-sm text-[#9298AD]">{expiryExact}</p>}
      </div>
    </div>
  );
}

function PaymentAmount({ label, value, sub, mono }: { label: string; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#262A3A] px-4 py-3 last:border-0">
      <p className="text-sm font-semibold text-[#9298AD]">{label}</p>
      <div className="min-w-0 text-right">
        <p className={cn("overflow-wrap-anywhere text-sm font-bold text-[#F7F8FC]", mono && "font-mono")}>{value}</p>
        {sub && <p className="mt-1 text-sm text-[#9298AD]">{sub}</p>}
      </div>
    </div>
  );
}

function WalletAddress({ address, shortAddress, network, copied, onCopy }: {
  address: string;
  shortAddress: string;
  network: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-xl border border-[#262A3A] bg-[#151824] p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-[#F7F8FC]">Wallet address</p>
          <p className="text-sm text-[#9298AD]">{network} network</p>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#262A3A] px-3 text-sm font-bold text-[#D9DCEA] hover:border-[#7657FF]/60"
        >
          <Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="block w-full rounded-lg bg-[#11131D] p-3 text-left font-mono text-sm text-[#F7F8FC] focus-visible:ring-2 focus-visible:ring-[#7657FF]/50"
        title={address}
      >
        <span className="hidden overflow-wrap-anywhere sm:block">{address}</span>
        <span className="sm:hidden">{shortAddress}</span>
      </button>
    </div>
  );
}

function PaymentActions({ onCheckStatus, checking, onChangeMethod, onCancel, cancelling }: {
  onCheckStatus: () => void;
  checking: boolean;
  onChangeMethod: () => void;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-[#262A3A] bg-[#0E1018]/95 p-4 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:p-0">
      <Button className="h-12 w-full rounded-xl bg-[#7657FF] font-bold hover:bg-[#856BFF]" onClick={onCheckStatus} loading={checking}>
        I&apos;ve sent the payment
      </Button>
      <p className="mt-2 text-center text-sm text-[#9298AD]">Payment status is also checked automatically.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="secondary" className="h-10 rounded-xl px-4" onClick={onChangeMethod} loading={cancelling}>
          Change payment method
        </Button>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="min-h-10 rounded-xl px-4 text-sm font-bold text-[#F06472] hover:bg-[#F06472]/10 disabled:opacity-50"
        >
          Cancel invoice
        </button>
      </div>
    </div>
  );
}

function RenewalSuccess({ invoice, planName, onDashboard }: { invoice: Payment | null; planName: string; onDashboard: () => void }) {
  return (
    <div className="mx-auto max-w-md py-6 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#25C9A0]/25 bg-[#25C9A0]/15 text-[#25C9A0]">
        <CheckCircle className="h-6 w-6" />
      </div>
      <h2 className="mt-4 text-2xl font-bold text-[#F7F8FC]">Payment confirmed</h2>
      <p className="mt-2 text-sm text-[#9298AD]">Your {planName} plan has been extended through {formatDate(invoice?.new_valid_till || invoice?.new_valid_till_preview)}.</p>
      <Button className="mt-5 h-12 w-full rounded-xl bg-[#7657FF] font-bold hover:bg-[#856BFF]" onClick={onDashboard}>Go to Dashboard</Button>
    </div>
  );
}

function SectionTitle({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-lg font-bold text-[#F7F8FC] sm:text-xl">{title}</h2>
      <p className="mt-1 text-sm text-[#9298AD]">{text}</p>
    </div>
  );
}

function StepActions({ primaryLabel, onPrimary, primaryDisabled, primaryLoading, secondaryLabel, onSecondary }: {
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-[#262A3A] bg-[#0E1018]/95 p-4 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:flex-row sm:justify-between sm:border-0 sm:bg-transparent sm:p-0">
      {secondaryLabel && onSecondary ? (
        <Button variant="secondary" className="h-11 rounded-xl px-5" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      ) : <span />}
      <Button className="h-12 rounded-xl bg-[#7657FF] px-5 font-bold hover:bg-[#856BFF] sm:h-11" onClick={onPrimary} disabled={primaryDisabled} loading={primaryLoading}>
        {primaryLabel}
      </Button>
    </div>
  );
}

function RenewalError({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-[#F06472]/30 bg-[#F06472]/10 p-3 text-sm font-semibold text-[#F06472]">
      {message}
    </div>
  );
}

function PaymentWarning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-[#F2B94B]/25 bg-[#F2B94B]/10 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#F2B94B]" />
      <p className="text-sm leading-5 text-[#F2B94B]">{children}</p>
    </div>
  );
}

function CryptoLogo({ code, className }: { code: string; className?: string }) {
  const base = code.split("_")[0];
  const logo: Record<string, string> = {
    BTC: "https://cryptologos.cc/logos/bitcoin-btc-logo.svg?v=040",
    ETH: "https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=040",
    LTC: "https://cryptologos.cc/logos/litecoin-ltc-logo.svg?v=040",
    TRX: "https://cryptologos.cc/logos/tron-trx-logo.svg?v=040",
    BNB: "https://cryptologos.cc/logos/bnb-bnb-logo.svg?v=040",
    USDT: "https://cryptologos.cc/logos/tether-usdt-logo.svg?v=040",
  };
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-white p-1", className)}>
      {logo[base] ? (
        <img src={logo[base]} alt={`${base} logo`} className="h-full w-full object-contain" />
      ) : (
        <span className="text-xs font-black text-[#0E1018]">{base.slice(0, 2)}</span>
      )}
    </span>
  );
}

function methodForInvoice(invoice: Payment, fallback: PaymentMethod): PaymentMethod {
  const pay = String(invoice.pay_currency || "").toUpperCase();
  const exact = PAYMENT_METHODS.find((method) => method.code === pay);
  if (exact) return exact;
  const asset = assetFromPayCurrency(pay, fallback.assetCode);
  const network = networkFromPayCurrency(pay || fallback.code);
  return PAYMENT_METHODS.find((method) => method.assetCode === asset && method.networkCode === network) || {
    code: pay || fallback.code,
    assetName: asset,
    assetCode: asset,
    networkName: network,
    networkCode: network,
  };
}

function getStatusInfo(status: string, invoice: Payment) {
  const s = status.toLowerCase();
  const payAmount = Number(invoice.pay_amount || 0);
  const received = Number(invoice.amount_received || 0);
  if (s === "completed" || s === "paid") {
    return { tone: "success" as const, title: "Payment confirmed", description: "Your renewal was confirmed by the backend." };
  }
  if (s === "confirming" || s === "processing") {
    return { tone: "accent" as const, title: "Payment detected", description: "Waiting for network confirmation." };
  }
  if (s === "expired") {
    return { tone: "error" as const, title: "Invoice expired", description: "Create a new invoice to continue." };
  }
  if (s === "cancelled" || s === "failed") {
    return { tone: "error" as const, title: "Payment failed", description: "This invoice can no longer be paid." };
  }
  if (received > 0 && payAmount > 0 && received < payAmount) {
    return { tone: "warning" as const, title: "Partial payment received", description: `Received ${received} of ${payAmount}.` };
  }
  return { tone: "warning" as const, title: "Waiting for payment", description: "We are checking the blockchain automatically." };
}

function formatRemaining(hours: number) {
  if (hours <= 0) return "0h";
  if (hours < 48) return `${Math.ceil(hours)}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function formatRemainingTime(value: string | undefined, now: number) {
  const expiry = parseInvoiceDate(value);
  if (!expiry) return "--:--";
  const diff = Math.max(0, expiry.getTime() - now);
  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `${hours}h ${String(rem).padStart(2, "0")}m`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDateTime(value: string | undefined) {
  const date = parseInvoiceDate(value);
  if (!date) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function parseInvoiceDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatCryptoAmount(value: string | number) {
  return String(value ?? "");
}

function assetFromPayCurrency(currency: string, fallback: string) {
  const upper = String(currency || "").toUpperCase();
  if (upper.startsWith("USDT")) return "USDT";
  if (upper.startsWith("USDC")) return "USDC";
  if (upper.includes("_")) return upper.split("_")[0];
  return upper || fallback;
}

function networkFromPayCurrency(currency: string) {
  const upper = String(currency || "").toUpperCase();
  if (upper.includes("TRC20") || upper === "TRX") return "TRC20";
  if (upper.includes("BEP20") || upper === "BNB") return "BEP20";
  if (upper.includes("ERC20") || upper === "ETH") return "ERC20";
  if (upper === "BTC") return "Bitcoin";
  if (upper === "LTC") return "Litecoin";
  return upper;
}

function middleTruncate(value: string, start = 8, end = 7) {
  if (!value || value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function shortId(id: string) {
  return id?.length > 12 ? `${id.slice(0, 8)}-${id.slice(-4)}` : id || "-";
}
