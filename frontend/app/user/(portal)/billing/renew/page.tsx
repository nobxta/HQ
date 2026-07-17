"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle,
  Clock,
  Coins,
  Copy,
  ReceiptText,
  RefreshCw,
} from "lucide-react";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import { PageSkeleton } from "@/components/ui/Skeleton";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import { usePortalBot, useRenewalOptions } from "@/lib/hooks/usePortal";
import { cn, formatDate, formatUSD } from "@/lib/utils";

// ── Supported crypto assets/networks ────────────────────────────────────────
// Asset and network are ALWAYS stored separately so display code never has to
// concatenate codes (which produced strings like "USDTTRC20").
const PAYMENT_METHODS = [
  { code: "USDT_TRC20", assetName: "Tether", assetCode: "USDT", networkName: "TRON", networkCode: "TRC20" },
  { code: "USDT_BEP20", assetName: "Tether", assetCode: "USDT", networkName: "BNB Smart Chain", networkCode: "BEP20" },
  { code: "USDT_ERC20", assetName: "Tether", assetCode: "USDT", networkName: "Ethereum", networkCode: "ERC20" },
  { code: "BTC", assetName: "Bitcoin", assetCode: "BTC", networkName: "Bitcoin", networkCode: "Bitcoin" },
  { code: "ETH", assetName: "Ethereum", assetCode: "ETH", networkName: "Ethereum", networkCode: "ERC20" },
  { code: "LTC", assetName: "Litecoin", assetCode: "LTC", networkName: "Litecoin", networkCode: "Litecoin" },
  { code: "TRX", assetName: "TRON", assetCode: "TRX", networkName: "TRON", networkCode: "TRC20" },
  { code: "BNB", assetName: "BNB", assetCode: "BNB", networkName: "BNB Smart Chain", networkCode: "BEP20" },
] as const;

type Step = "duration" | "method" | "invoice" | "success";
type PaymentMethod = (typeof PAYMENT_METHODS)[number] | {
  code: string;
  assetName: string;
  assetCode: string;
  networkName: string;
  networkCode: string;
};

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

const TERMINAL_STATUSES = new Set(["completed", "paid", "expired", "cancelled", "failed", "invoice_failed"]);

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
  // Order id we just cancelled/dismissed, so the "restore active invoice" effect below does not
  // immediately re-open it from the still-cached renewal-options response (the cancel race).
  const dismissedInvoiceRef = useRef<string | null>(null);

  const options = data?.options || {};
  const selectedOption = options?.[selectedDuration];
  const selectedMethod = findMethod(selectedMethodCode);
  const status = invoiceStatus.toLowerCase();
  const isTerminal = TERMINAL_STATUSES.has(status);
  const hasOpenInvoice = !!invoice && !isTerminal;

  const planName = data?.bot?.plan_name || bot?.plan_name || "Custom";
  const currentValidTill = data?.bot?.valid_till || bot?.valid_till || "";
  const currentExpiry = formatDate(currentValidTill);
  const hoursLeft = data?.bot?.hours_left;
  const remaining = hoursLeft != null ? formatRemaining(Number(hoursLeft)) : "";
  const planExpired = hoursLeft != null && Number(hoursLeft) <= 0;
  const pageTitle = `Renew ${planName} Plan`;

  // Single source of truth for the order summary shown in steps 2 & 3.
  const summary = useMemo<RenewalSummary>(() => ({
    planName,
    durationLabel: selectedOption?.days
      ? `${selectedOption.days} days`
      : selectedDuration === "7d" ? "7 days" : "30 days",
    amountUsd: selectedOption?.price ? formatUSD(Number(selectedOption.price)) : "—",
    newExpiry: formatDate(
      selectedOption?.new_valid_till || invoice?.new_valid_till_preview || invoice?.new_valid_till
    ),
  }), [planName, selectedDuration, selectedOption?.days, selectedOption?.price, selectedOption?.new_valid_till, invoice?.new_valid_till, invoice?.new_valid_till_preview]);

  const qrValue = invoice?.pay_address || "";
  const qrUrl = qrValue
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=${encodeURIComponent(qrValue)}`
    : "";

  // ── Handlers ───────────────────────────────────────────────────────────────
  const copyAddress = async () => {
    if (!invoice?.pay_address) return;
    try {
      await navigator.clipboard.writeText(invoice.pay_address);
      setCopied(true);
      toast.success("Address copied");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy address");
    }
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
      setInvoice((previous) => (previous ? { ...previous, ...res.data } : previous));
      if (nextStatus === "completed" || nextStatus === "paid") {
        setStep("success");
        mutate();
        mutateBot();
      } else if (!silent) {
        toast.success("Status checked");
      }
    } catch (e: any) {
      if (!silent) setError(e?.response?.data?.detail || "Could not check payment status.");
    } finally {
      setChecking(false);
    }
  };

  const createInvoice = async () => {
    if (!session || !selectedOption?.available || hasOpenInvoice || creating) return;
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
      dismissedInvoiceRef.current = invoice.order_id;
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

  // Start a fresh invoice after the current one expired (no cancel needed —
  // the backend already treats it as dead). Return to the method step.
  const startNewInvoice = () => {
    if (invoice) dismissedInvoiceRef.current = invoice.order_id;
    setInvoice(null);
    setInvoiceStatus("idle");
    setError("");
    setStep("method");
  };

  // ── Effects ────────────────────────────────────────────────────────────────
  // Restore an active unpaid invoice after a refresh so users never lose it and
  // duplicate invoices are never created silently.
  useEffect(() => {
    if (!data?.active_invoice || invoice) return;
    // Don't re-open an invoice the user just cancelled/dismissed (the renewal-options response can
    // still carry it for a moment before the backend marks it terminal).
    if (data.active_invoice.order_id && data.active_invoice.order_id === dismissedInvoiceRef.current) return;
    const st = (data.active_invoice.status || "").toLowerCase();
    if (TERMINAL_STATUSES.has(st)) return;
    setInvoice(data.active_invoice);
    setInvoiceStatus(data.active_invoice.status || "payment_waiting");
    setStep(data.active_invoice.status === "completed" ? "success" : "invoice");
  }, [data?.active_invoice, invoice]);

  // 1-second clock for the live countdown — only while an invoice is open.
  useEffect(() => {
    if (!invoice || isTerminal) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [invoice, isTerminal]);

  // Poll payment status; stop once payment/cancellation/expiration is reached.
  useEffect(() => {
    if (!invoice || !session || isTerminal) return;
    const poll = setInterval(() => requestStatus(true), 8000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.order_id, isTerminal, session?.bot_name, session?.telegram_id]);

  if (isLoading || !bot) return <div className="p-4 sm:p-6"><PageSkeleton /></div>;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 pb-28 sm:pb-0">
      <Link
        href="/user/billing"
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#9298AD] transition-colors hover:text-[#F7F8FC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/50"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Billing
      </Link>

      <RenewalHeader
        planName={planName}
        currentExpiry={currentExpiry}
        remaining={remaining}
        hasOpenInvoice={hasOpenInvoice}
        planExpired={planExpired}
        graceHoursLeft={(bot?.grace_hours_left as number | null | undefined) ?? null}
      />

      <div className="rounded-2xl border border-[#20242F] bg-[#0E1018] px-4 py-3.5 sm:px-5">
        <RenewalProgress step={step} />
      </div>

      {error && <RenewalError message={error} />}

      <div className="rounded-2xl border border-[#20242F] bg-[#0E1018] p-4 sm:p-5">

            {step === "duration" && (
              <DurationSelector
                options={options}
                currentExpiry={currentExpiry}
                planExpired={planExpired}
                planName={planName}
                selectedDuration={selectedDuration}
                setSelectedDuration={setSelectedDuration}
                hasOpenInvoice={hasOpenInvoice}
                onContinue={() => (hasOpenInvoice ? setStep("invoice") : setStep("method"))}
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
                onNewInvoice={startNewInvoice}
                cancelling={cancelling}
              />
            )}

            {step === "success" && (
              <RenewalSuccess invoice={invoice} planName={planName} onDashboard={() => router.push("/user/dashboard")} />
            )}
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────
function RenewalHeader({ planName, currentExpiry, remaining, hasOpenInvoice, planExpired, graceHoursLeft }: {
  planName: string;
  currentExpiry: string;
  remaining: string;
  hasOpenInvoice: boolean;
  planExpired: boolean;
  graceHoursLeft: number | null;
}) {
  const inGrace = planExpired && graceHoursLeft !== null && graceHoursLeft > 0;
  return (
    <div className="rounded-2xl border border-[#20242F] bg-[#0E1018] p-4 sm:p-5">
      <div className="flex items-start gap-3 sm:gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#7657FF]/25 bg-[#7657FF]/10 text-[#B9A7FF]">
          <RefreshCw className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <h1 className="text-lg font-bold text-[#F7F8FC] sm:text-xl">Renew your {planName} plan</h1>
            {hasOpenInvoice && (
              <span className="rounded-full border border-[#F2B94B]/30 bg-[#F2B94B]/10 px-2.5 py-0.5 text-[11px] font-bold text-[#F2B94B]">
                Active invoice
              </span>
            )}
          </div>
          {planExpired ? (
            <>
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#F2555A]/25 bg-[#F2555A]/10 px-2.5 py-1 text-[12px] font-bold text-[#F2555A]">
                <AlertCircle className="h-3.5 w-3.5" /> Subscription expired
              </span>
              <p className="mt-2.5 text-[13px] leading-relaxed text-[#9298AD] sm:text-sm">
                {inGrace
                  ? `Renew within ${graceHoursLeft} hours to keep your accounts, campaigns and settings.`
                  : "Renew now to restore your accounts, campaigns and settings."}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[13px] text-[#9298AD] sm:text-sm">
              Active until <span className="text-[#D9DCEA]">{currentExpiry}</span>
              {remaining ? ` · ${remaining} remaining` : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Progress ─────────────────────────────────────────────────────────────────
function RenewalProgress({ step }: { step: Step }) {
  const steps = [
    { id: "duration", label: "Duration", icon: CalendarDays },
    { id: "method", label: "Payment method", icon: Coins },
    { id: "invoice", label: "Payment invoice", icon: ReceiptText },
  ] as const;
  const current = step === "success" ? 3 : steps.findIndex((item) => item.id === step);
  const activeIndex = Math.min(Math.max(current, 0), 2);
  const active = steps[activeIndex];
  const ActiveIcon = active.icon;

  return (
    <>
      {/* Desktop: full horizontal stepper */}
      <ol className="hidden items-center sm:flex" aria-label="Renewal progress">
        {steps.map((item, index) => {
          const done = index < current || step === "success";
          const isActive = index === current;
          return (
            <li key={item.id} className="flex min-w-0 flex-1 items-center last:flex-none">
              <span
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                  isActive && "bg-[#7657FF] text-white",
                  done && "bg-[#25C9A0]/15 text-[#25C9A0]",
                  !isActive && !done && "bg-[#151824] text-[#9298AD]"
                )}
              >
                {done ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <span className={cn("ml-2 truncate text-sm font-semibold", isActive ? "text-[#F7F8FC]" : done ? "text-[#D9DCEA]" : "text-[#9298AD]")}>
                {item.label}
              </span>
              {index < steps.length - 1 && <span className={cn("mx-4 h-px flex-1", done ? "bg-[#7657FF]" : "bg-[#262A3A]")} />}
            </li>
          );
        })}
      </ol>

      {/* Mobile: compact label + thin progress bar */}
      <div className="sm:hidden">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#7657FF] text-white">
            <ActiveIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#9298AD]">Step {activeIndex + 1} of 3</p>
            <p className="truncate text-sm font-bold text-[#F7F8FC]">{active.label}</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#151824]">
          <div className="h-full rounded-full bg-[#7657FF] transition-[width] duration-200" style={{ width: `${((activeIndex + 1) / 3) * 100}%` }} />
        </div>
      </div>
    </>
  );
}

// ── Step 1: Duration ─────────────────────────────────────────────────────────
function DurationSelector({ options, currentExpiry, planExpired, planName, selectedDuration, setSelectedDuration, hasOpenInvoice, onContinue }: {
  options: any;
  currentExpiry: string;
  planExpired: boolean;
  planName: string;
  selectedDuration: "7d" | "30d";
  setSelectedDuration: (duration: "7d" | "30d") => void;
  hasOpenInvoice: boolean;
  onContinue: () => void;
}) {
  const selected = options?.[selectedDuration];
  const weeklyRate = Number(options?.["7d"]?.price || 0) / 7;
  const monthlyRate = Number(options?.["30d"]?.price || 0) / 30;
  const monthlyBest = weeklyRate > 0 && monthlyRate > 0 && monthlyRate < weeklyRate;

  return (
    <div className="space-y-5">
      <SectionTitle title="Choose renewal duration" text={`Select how long you want to extend your ${planName} plan.`} />

      <div className="grid gap-3 sm:grid-cols-2">
        {(["7d", "30d"] as const).map((key) => {
          const option = options?.[key];
          const active = selectedDuration === key;
          const showBest = key === "30d" && monthlyBest;
          const disabled = !option?.available || hasOpenInvoice;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => setSelectedDuration(key)}
              className={cn(
                "min-h-[132px] rounded-[14px] border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60",
                active ? "border-[#7657FF] bg-[#7657FF]/10" : "border-[#262A3A] bg-[#11131D] hover:border-[#7657FF]/60",
                disabled && "cursor-not-allowed opacity-60"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors", active ? "border-[#7657FF] bg-[#7657FF] text-white" : "border-[#52586B]")}>
                  {active && <Check className="h-3 w-3" />}
                </span>
                {showBest && (
                  <span className="rounded-full bg-[#7657FF]/15 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-[#B9A7FF]">
                    Best value
                  </span>
                )}
              </div>
              <p className="mt-3 text-lg font-bold text-[#F7F8FC]">{option?.days || (key === "7d" ? 7 : 30)} days</p>
              <p className="mt-0.5 text-[28px] font-black leading-none text-[#F7F8FC]">
                {option?.available ? formatUSD(Number(option.price)) : "Unavailable"}
              </p>
              <p className="mt-2 text-[13px] text-[#9298AD]">
                Active through <span className="text-[#D9DCEA]">{formatDate(option?.new_valid_till)}</span>
              </p>
            </button>
          );
        })}
      </div>

      <p className="rounded-[14px] border border-[#262A3A] bg-[#151824] p-3 text-sm leading-relaxed text-[#D9DCEA]">
        {planExpired ? (
          <>Your renewed subscription will start after payment confirmation.</>
        ) : (
          <>Your renewal will begin after your current subscription ends on <span className="font-bold text-[#F7F8FC]">{currentExpiry}</span>.</>
        )}
      </p>

      <StepActions primaryLabel="Continue to payment" onPrimary={onContinue} primaryDisabled={!selected?.available} />
    </div>
  );
}

// ── Step 2: Payment method ───────────────────────────────────────────────────
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
    <div className="space-y-5">
      <SectionTitle title="Choose payment method" text="Select the cryptocurrency and network you want to use." />
      <RenewalOrderSummary summary={summary} />

      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment method">
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
          Send only {selectedMethod.assetCode} using the {formatNetworkLabel(selectedMethod)} network. Other assets or networks may result in permanent loss of funds.
        </PaymentWarning>
      )}

      <StepActions
        secondaryLabel="Back"
        onSecondary={onBack}
        primaryLabel={creating ? "Creating invoice…" : "Create payment invoice"}
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
    <div className="rounded-[14px] border border-[#262A3A] bg-[#151824] px-4 py-3">
      <p className="text-sm font-bold text-[#F7F8FC]">{summary.planName} Plan · {summary.durationLabel}</p>
      <p className="mt-1 text-sm text-[#D9DCEA]">{summary.amountUsd} USD</p>
      <p className="text-[13px] text-[#9298AD]">Renews through {summary.newExpiry}</p>
    </div>
  );
}

function PaymentMethodCard({ method, selected, onSelect }: { method: PaymentMethod; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${method.assetName} on ${method.networkName}`}
      onClick={onSelect}
      className={cn(
        "flex min-h-[60px] items-center gap-3 rounded-[12px] border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60",
        selected ? "border-[#7657FF] bg-[#7657FF]/10" : "border-[#262A3A] bg-[#11131D] hover:border-[#7657FF]/60"
      )}
    >
      <CryptoLogo code={method.assetCode} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-[#F7F8FC]">{method.assetCode}</p>
        <p className="truncate text-[13px] text-[#9298AD]">{method.networkCode} network</p>
      </div>
      <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", selected ? "border-[#7657FF] bg-[#7657FF] text-white" : "border-[#52586B]")}>
        {selected && <Check className="h-3 w-3" />}
      </span>
    </button>
  );
}

// ── Step 3: Invoice ──────────────────────────────────────────────────────────
function InvoicePaymentPanel({ invoice, status, method, summary, qrUrl, now, copied, onCopy, onCheckStatus, checking, onChangeMethod, onCancel, onNewInvoice, cancelling }: {
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
  onNewInvoice: () => void;
  cancelling: boolean;
}) {
  const statusInfo = getStatusInfo(status, invoice, method);
  const expired = statusInfo.tone === "error";
  const countdown = formatRemainingTime(invoice.invoice_expires_at, now);
  const expiryExact = formatExpiryExact(invoice.invoice_expires_at);
  const cryptoAmount = formatCryptoAmount(invoice.pay_amount);
  const networkLabel = formatNetworkLabel(method);
  const renewsThrough = formatDate(invoice.new_valid_till || invoice.new_valid_till_preview || summary.newExpiry);

  // Reusable blocks — arranged differently per breakpoint below.
  const statusBlock = (
    <InvoiceStatus statusInfo={statusInfo} countdown={countdown} expiryExact={expiryExact} onRefresh={onCheckStatus} refreshing={checking} expired={expired} />
  );
  const amountBlock = (
    <PaymentAmounts amountUsd={formatUSD(Number(invoice.amount_usd))} cryptoAmount={cryptoAmount} assetCode={method.assetCode} networkLabel={networkLabel} />
  );
  const metaBlock = (
    <MetaList networkLabel={networkLabel} invoiceId={shortId(invoice.order_id)} renewsThrough={renewsThrough} />
  );
  const qrBlock = <PaymentQRCode qrUrl={qrUrl} assetCode={method.assetCode} networkLabel={networkLabel} />;
  const addressBlock = <WalletAddress address={invoice.pay_address} network={networkLabel} copied={copied} onCopy={onCopy} />;
  const warningBlock = (
    <PaymentWarning>
      Send only {method.assetCode} using the {networkLabel} network. Sending another asset or using another network may permanently lose your funds.
    </PaymentWarning>
  );
  const actionsBlock = (
    <PaymentActions
      expired={expired}
      onCheckStatus={onCheckStatus}
      checking={checking}
      onChangeMethod={onChangeMethod}
      onCancel={onCancel}
      onNewInvoice={onNewInvoice}
      cancelling={cancelling}
    />
  );

  return (
    <div className="space-y-5">
      <SectionTitle title="Complete payment" text="Send the exact amount using the selected currency and network." />

      {/* Desktop: two columns (QR + address | status, amounts, actions) */}
      <div className="hidden gap-5 md:grid md:grid-cols-[46%_minmax(0,1fr)]">
        <div className="space-y-4">
          {qrBlock}
          {addressBlock}
        </div>
        <div className="space-y-4">
          {statusBlock}
          {amountBlock}
          {metaBlock}
          {warningBlock}
          {actionsBlock}
        </div>
      </div>

      {/* Mobile: single-column checkout order */}
      <div className="space-y-4 md:hidden">
        {statusBlock}
        {amountBlock}
        {qrBlock}
        {addressBlock}
        {warningBlock}
        {actionsBlock}
        {metaBlock}
      </div>
    </div>
  );
}

function InvoiceStatus({ statusInfo, countdown, expiryExact, onRefresh, refreshing, expired }: {
  statusInfo: StatusInfo;
  countdown: string;
  expiryExact: string;
  onRefresh: () => void;
  refreshing: boolean;
  expired: boolean;
}) {
  const toneText = statusInfo.tone === "success" ? "text-[#25C9A0]"
    : statusInfo.tone === "error" ? "text-[#F06472]"
    : statusInfo.tone === "accent" ? "text-[#856BFF]"
    : "text-[#F2B94B]";
  const dot = statusInfo.tone === "success" ? "bg-[#25C9A0]"
    : statusInfo.tone === "error" ? "bg-[#F06472]"
    : statusInfo.tone === "accent" ? "bg-[#856BFF]"
    : "bg-[#F2B94B]";
  return (
    <div className="rounded-[14px] border border-[#262A3A] bg-[#151824] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("flex items-center gap-2 text-sm font-bold", toneText)}>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", dot, !expired && "animate-pulse")} aria-hidden="true" />
            {statusInfo.title}
          </p>
          <p className="mt-1 text-[13px] text-[#9298AD]">{statusInfo.description}</p>
        </div>
        <button
          type="button"
          aria-label="Refresh payment status"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[#262A3A] text-[#9298AD] transition-colors hover:text-[#F7F8FC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </button>
      </div>
      {!expired && (
        <div className="mt-3 rounded-[10px] bg-[#11131D] p-3">
          <p className="text-sm font-bold text-[#F7F8FC]">Invoice expires in {countdown}</p>
          {expiryExact && <p className="mt-0.5 text-[13px] text-[#9298AD]">{expiryExact}</p>}
        </div>
      )}
    </div>
  );
}

function PaymentAmounts({ amountUsd, cryptoAmount, assetCode, networkLabel }: {
  amountUsd: string;
  cryptoAmount: string;
  assetCode: string;
  networkLabel: string;
}) {
  return (
    <div className="rounded-[14px] border border-[#262A3A] bg-[#151824] p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#9298AD]">Amount due</p>
      <p className="mt-1 break-words text-[32px] font-black leading-none text-[#F7F8FC] sm:text-[36px]">
        {amountUsd} <span className="text-lg font-bold text-[#9298AD]">USD</span>
      </p>
      <div className="mt-4 border-t border-[#262A3A] pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#9298AD]">Send exactly</p>
        <p className="mt-1 break-all font-mono text-xl font-bold text-[#F7F8FC] sm:text-2xl">
          {cryptoAmount} <span className="text-[#D9DCEA]">{assetCode}</span>
        </p>
        <p className="mt-0.5 text-[13px] text-[#9298AD]">via the {networkLabel} network</p>
        <p className="mt-2 text-[13px] text-[#9298AD]">The crypto amount is locked until the invoice expires.</p>
      </div>
    </div>
  );
}

function MetaList({ networkLabel, invoiceId, renewsThrough }: { networkLabel: string; invoiceId: string; renewsThrough: string }) {
  return (
    <div className="rounded-[14px] border border-[#262A3A] bg-[#151824]">
      <MetaRow label="Network" value={networkLabel} />
      <MetaRow label="Invoice ID" value={invoiceId} mono />
      <MetaRow label="Renews through" value={renewsThrough} />
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#262A3A] px-4 py-3 last:border-0">
      <p className="shrink-0 text-[13px] font-semibold text-[#9298AD]">{label}</p>
      <p className={cn("min-w-0 break-words text-right text-sm font-bold text-[#F7F8FC]", mono && "font-mono")}>{value}</p>
    </div>
  );
}

function PaymentQRCode({ qrUrl, assetCode, networkLabel }: { qrUrl: string; assetCode: string; networkLabel: string }) {
  return (
    <div className="rounded-[14px] border border-[#262A3A] bg-[#151824] p-4">
      <div className="mx-auto flex aspect-square w-full max-w-[240px] items-center justify-center rounded-[12px] bg-white p-3">
        {qrUrl ? (
          <img src={qrUrl} alt={`QR code to pay with ${assetCode} on ${networkLabel}`} className="h-full w-full object-contain" />
        ) : (
          <span className="text-sm font-semibold text-[#0E1018]">QR unavailable</span>
        )}
      </div>
      <p className="mt-3 text-center text-[13px] font-semibold text-[#D9DCEA]">
        Scan to pay with {assetCode} on {networkLabel}
      </p>
    </div>
  );
}

function WalletAddress({ address, network, copied, onCopy }: {
  address: string;
  network: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-[14px] border border-[#262A3A] bg-[#151824] p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#F7F8FC]">Wallet address</p>
          <p className="truncate text-[13px] text-[#9298AD]">{network} network</p>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-[10px] border border-[#262A3A] px-3 text-[13px] font-bold text-[#D9DCEA] transition-colors hover:border-[#7657FF]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60"
          aria-label={copied ? "Address copied" : "Copy wallet address"}
        >
          {copied ? <Check className="h-4 w-4 text-[#25C9A0]" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onCopy}
        title={address}
        aria-label="Copy wallet address"
        className="block w-full select-all break-all rounded-[10px] bg-[#11131D] p-3 text-left font-mono text-[13px] leading-relaxed text-[#F7F8FC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60"
      >
        {address}
      </button>
    </div>
  );
}

function PaymentActions({ expired, onCheckStatus, checking, onChangeMethod, onCancel, onNewInvoice, cancelling }: {
  expired: boolean;
  onCheckStatus: () => void;
  checking: boolean;
  onChangeMethod: () => void;
  onCancel: () => void;
  onNewInvoice: () => void;
  cancelling: boolean;
}) {
  if (expired) {
    return (
      <div className="space-y-3">
        <Button className="h-12 w-full rounded-[12px] bg-[#7657FF] font-bold hover:bg-[#856BFF]" onClick={onNewInvoice}>
          Create a new invoice
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <Button className="h-12 w-full rounded-[12px] bg-[#7657FF] font-bold hover:bg-[#856BFF]" onClick={onCheckStatus} loading={checking}>
        I&apos;ve sent the payment
      </Button>
      <p className="text-center text-[13px] text-[#9298AD]">Payment status is also checked automatically.</p>
      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="secondary" className="h-10 rounded-[10px] px-4" onClick={onChangeMethod} loading={cancelling}>
          Change payment method
        </Button>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="min-h-10 rounded-[10px] px-4 text-[13px] font-bold text-[#F06472] transition-colors hover:bg-[#F06472]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F06472]/50 disabled:opacity-50"
        >
          Cancel invoice
        </button>
      </div>
    </div>
  );
}

// ── Success ──────────────────────────────────────────────────────────────────
function RenewalSuccess({ invoice, planName, onDashboard }: { invoice: Payment | null; planName: string; onDashboard: () => void }) {
  const through = formatDate(invoice?.new_valid_till || invoice?.new_valid_till_preview);
  return (
    <div className="mx-auto max-w-md py-6 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#25C9A0]/25 bg-[#25C9A0]/15 text-[#25C9A0]">
        <CheckCircle className="h-6 w-6" />
      </div>
      <h2 className="mt-4 text-2xl font-bold text-[#F7F8FC]">Payment confirmed</h2>
      <p className="mt-2 text-sm text-[#9298AD]">
        Your {planName} plan has been extended through {through}.
      </p>
      <Button className="mt-5 h-12 w-full rounded-[12px] bg-[#7657FF] font-bold hover:bg-[#856BFF]" onClick={onDashboard}>
        Go to Dashboard
      </Button>
    </div>
  );
}

// ── Shared primitives ────────────────────────────────────────────────────────
function SectionTitle({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-lg font-bold text-[#F7F8FC] sm:text-xl">{title}</h2>
      <p className="mt-1 text-[13px] text-[#9298AD] sm:text-sm">{text}</p>
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
    // Mobile: sticky action bar flush to the safe-area bottom edge (native-checkout feel).
    // Desktop (sm+): reverts to an inline right-aligned row inside the step card.
    <div className="fixed inset-x-0 bottom-0 z-40 flex flex-col-reverse gap-2 border-t border-[#20242F] bg-[#0B0C12]/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:static sm:z-auto sm:mt-1 sm:flex-row sm:items-center sm:justify-between sm:border-0 sm:bg-transparent sm:p-0 sm:pt-1 sm:backdrop-blur-none">
      {secondaryLabel && onSecondary ? (
        <Button variant="secondary" className="h-11 rounded-xl px-5" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      ) : (
        <span className="hidden sm:block" />
      )}
      <Button
        className="h-[52px] w-full rounded-xl bg-[#7657FF] px-5 text-[15px] font-bold hover:bg-[#856BFF] sm:h-11 sm:w-auto sm:text-sm"
        onClick={onPrimary}
        disabled={primaryDisabled}
        loading={primaryLoading}
      >
        {primaryLabel}
      </Button>
    </div>
  );
}

function RenewalError({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-4 rounded-[12px] border border-[#F06472]/30 bg-[#F06472]/10 p-3 text-sm font-semibold text-[#F06472]">
      {message}
    </div>
  );
}

function PaymentWarning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[12px] border border-[#F2B94B]/25 bg-[#F2B94B]/10 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#F2B94B]" aria-hidden="true" />
      <p className="text-[13px] leading-5 text-[#F2B94B]">{children}</p>
    </div>
  );
}

function CryptoLogo({ code }: { code: string }) {
  const base = code.split("_")[0];
  // Bundled locally (frontend/public/crypto) — no external CDN dependency, works offline.
  const logo: Record<string, string> = {
    BTC: "/crypto/bitcoin.svg",
    ETH: "/crypto/ethereum.svg",
    LTC: "/crypto/litecoin.svg",
    TRX: "/crypto/tron.svg",
    BNB: "/crypto/bnb.svg",
    USDT: "/crypto/tether.svg",
  };
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white p-1">
      {logo[base] ? (
        <img src={logo[base]} alt={`${base} logo`} className="h-full w-full object-contain" />
      ) : (
        <span className="text-xs font-black text-[#0E1018]">{base.slice(0, 2)}</span>
      )}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
type StatusTone = "warning" | "success" | "error" | "accent";
type StatusInfo = { title: string; description: string; tone: StatusTone };

function findMethod(code: string): PaymentMethod {
  return PAYMENT_METHODS.find((m) => m.code === code) || PAYMENT_METHODS[0];
}

function formatNetworkLabel(method: PaymentMethod): string {
  return method.networkCode || method.networkName || "";
}

function methodForInvoice(invoice: Payment, fallback: PaymentMethod): PaymentMethod {
  const pay = String(invoice.pay_currency || "").toUpperCase();
  const exact = PAYMENT_METHODS.find((method) => method.code === pay);
  if (exact) return exact;
  const asset = assetFromPayCurrency(pay, fallback.assetCode);
  const network = networkFromPayCurrency(pay || fallback.code);
  return (
    PAYMENT_METHODS.find((method) => method.assetCode === asset && method.networkCode === network) || {
      code: pay || fallback.code,
      assetName: asset,
      assetCode: asset,
      networkName: network,
      networkCode: network,
    }
  );
}

function getStatusInfo(status: string, invoice: Payment, method: PaymentMethod): StatusInfo {
  const s = status.toLowerCase();
  const payAmount = Number(invoice.pay_amount || 0);
  const received = Number(invoice.amount_received || 0);
  if (s === "completed" || s === "paid") {
    return { tone: "success", title: "Payment confirmed", description: "Your renewal was confirmed by the backend." };
  }
  if (s === "confirming" || s === "processing") {
    return { tone: "accent", title: "Payment detected", description: "Waiting for network confirmation." };
  }
  if (s === "expired") {
    return { tone: "error", title: "Invoice expired", description: "Create a new invoice to continue." };
  }
  if (s === "cancelled" || s === "failed" || s === "invoice_failed") {
    return { tone: "error", title: "Payment failed", description: "This invoice can no longer be paid." };
  }
  if (received > 0 && payAmount > 0 && received < payAmount) {
    return {
      tone: "warning",
      title: "Partial payment received",
      description: `Received ${formatCryptoAmount(received)} of ${formatCryptoAmount(payAmount)} ${method.assetCode}.`,
    };
  }
  return { tone: "warning", title: "Waiting for payment", description: "We are checking the blockchain automatically." };
}

function formatRemaining(hours: number): string {
  if (hours <= 0) return "0h";
  if (hours < 48) return `${Math.ceil(hours)}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function formatRemainingTime(value: string | undefined, now: number): string {
  const expiry = parseInvoiceDate(value);
  if (!expiry) return "—";
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

function formatExpiryExact(value: string | undefined): string {
  const date = parseInvoiceDate(value);
  if (!date) return "";
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

// Backend stores invoice_expires_at as a naive UTC ISO string (no timezone
// suffix). `new Date("2026-07-18T09:00:00")` would parse that as LOCAL time and
// skew the countdown, so append `Z` to force UTC when no offset is present.
function parseInvoiceDate(value: string | undefined): Date | null {
  if (!value) return null;
  let raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
    raw = `${raw}Z`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Preserve backend-provided precision exactly — never re-round crypto amounts.
function formatCryptoAmount(value: string | number): string {
  return String(value ?? "").trim();
}

function assetFromPayCurrency(currency: string, fallback: string): string {
  const upper = String(currency || "").toUpperCase();
  if (upper.startsWith("USDT")) return "USDT";
  if (upper.startsWith("USDC")) return "USDC";
  if (upper.includes("_")) return upper.split("_")[0];
  return upper || fallback;
}

function networkFromPayCurrency(currency: string): string {
  const upper = String(currency || "").toUpperCase();
  if (upper.includes("TRC20") || upper === "TRX") return "TRC20";
  if (upper.includes("BEP20") || upper === "BNB") return "BEP20";
  if (upper.includes("ERC20") || upper === "ETH") return "ERC20";
  if (upper === "BTC") return "Bitcoin";
  if (upper === "LTC") return "Litecoin";
  return upper;
}

function shortId(id: string): string {
  return id && id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id || "—";
}
