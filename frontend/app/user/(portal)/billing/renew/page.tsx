"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Coins,
  Copy,
  Info,
  ReceiptText,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import portalApi, { getPortalSession } from "@/lib/portal-api";
import { usePortalBot, useRenewalOptions } from "@/lib/hooks/usePortal";
import { cn, formatDate, formatUSD } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens — kept identical to the rest of the portal so the checkout feels
// native to HQAdz (single brand purple, near-black surfaces, subtle borders).
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  accent: "#7657FF",
  accentHover: "#856BFF",
  text: "#F7F8FC",
  text2: "#D9DCEA",
  sub: "#9298AD",
  faint: "#52586B",
  card: "#0E1018",
  surface: "#11131D",
  surface2: "#151824",
  field: "#12141C",
  border: "#20242F",
  border2: "#262A3A",
  success: "#25C9A0",
  danger: "#F06472",
  amber: "#F2B94B",
};

// ─────────────────────────────────────────────────────────────────────────────
// Supported assets & networks.
//
// Asset code and network code are ALWAYS stored separately so display code never
// concatenates them into strings like "USDTTRC20". Network selection is offered
// ONLY for the two stablecoins (USDT / USDC). Every native coin runs on its own
// single chain and is a direct-select option with no network dropdown.
//
// The set below is the curated superset; the live list is intersected against
// what the payment provider actually supports (see filterProviderBackedAssets),
// so an unsupported network can never be shown or paid to.
// ─────────────────────────────────────────────────────────────────────────────
type NetworkCode = "TRC20" | "ERC20" | "BEP20" | "SOL" | "ARB" | "MATIC";

const NETWORK_META: Record<NetworkCode, { label: string; full: string }> = {
  TRC20: { label: "TRC20", full: "TRON network" },
  ERC20: { label: "ERC20", full: "Ethereum network" },
  BEP20: { label: "BEP20", full: "BNB Smart Chain" },
  SOL: { label: "Solana", full: "Solana network" },
  ARB: { label: "Arbitrum", full: "Arbitrum One" },
  MATIC: { label: "Polygon", full: "Polygon PoS" },
};

type CryptoAsset = {
  code: string; // asset ticker: BTC, ETH, USDT …
  name: string; // professional full name
  popular?: boolean;
  networks: NetworkCode[] | null; // stablecoins only; null = single fixed chain
};

const CRYPTO_ASSETS: CryptoAsset[] = [
  { code: "BTC", name: "Bitcoin", popular: true, networks: null },
  { code: "ETH", name: "Ethereum", popular: true, networks: null },
  { code: "USDT", name: "Tether", popular: true, networks: ["TRC20", "ERC20", "BEP20", "SOL", "ARB"] },
  { code: "USDC", name: "USD Coin", popular: true, networks: ["ERC20", "BEP20", "SOL", "MATIC", "ARB"] },
  { code: "XMR", name: "Monero", networks: null },
  { code: "LTC", name: "Litecoin", networks: null },
  { code: "TRX", name: "TRON", networks: null },
  { code: "BNB", name: "BNB Smart Chain", networks: null },
  { code: "XRP", name: "XRP Ledger", networks: null },
  { code: "SOL", name: "Solana", networks: null },
  { code: "MATIC", name: "Polygon", networks: null },
  { code: "TON", name: "Toncoin", networks: null },
];

const STABLES = new Set(["USDT", "USDC"]);

// Internal currency code sent to the API for a given asset+network.
function internalCode(assetCode: string, network?: NetworkCode | null): string {
  return network ? `${assetCode}_${network}` : assetCode;
}

// Provider code (from /crypto/currencies) → internal code, so a restored invoice's
// stored pay_currency resolves back to the exact asset + network for display.
const PROVIDER_TO_INTERNAL: Record<string, string> = {
  BTC: "BTC", ETH: "ETH", LTC: "LTC", XMR: "XMR", TRX: "TRX", DOGE: "DOGE",
  XRP: "XRP", SOL: "SOL", BNBBSC: "BNB", BNB: "BNB", MATIC: "MATIC", ADA: "ADA", TON: "TON",
  USDTTRC20: "USDT_TRC20", USDTBSC: "USDT_BEP20", USDTBEP20: "USDT_BEP20",
  USDTERC20: "USDT_ERC20", USDTSOL: "USDT_SOL", USDTARB: "USDT_ARB",
  USDCBSC: "USDC_BEP20", USDCBEP20: "USDC_BEP20", USDCERC20: "USDC_ERC20",
  USDCSOL: "USDC_SOL", USDCMATIC: "USDC_MATIC", USDCPOLYGON: "USDC_MATIC", USDCARB: "USDC_ARB",
};

type ResolvedMethod = {
  code: string;        // internal code
  assetCode: string;   // BTC, USDT …
  assetName: string;   // Bitcoin, Tether …
  network: NetworkCode | null;
};

function assetByCode(code: string): CryptoAsset | undefined {
  return CRYPTO_ASSETS.find((a) => a.code === code);
}

function resolveMethod(assetCode: string, network: NetworkCode | null): ResolvedMethod {
  const asset = assetByCode(assetCode);
  return {
    code: internalCode(assetCode, network),
    assetCode,
    assetName: asset?.name || assetCode,
    network,
  };
}

// Resolve a stored invoice's pay_currency (provider OR internal form) into a method.
function methodFromPayCurrency(pay: string, fallback: ResolvedMethod): ResolvedMethod {
  const upper = String(pay || "").trim().toUpperCase();
  const compact = upper.replace(/[-_\s]/g, "");
  let internal = PROVIDER_TO_INTERNAL[compact];
  if (!internal && upper.includes("_")) internal = upper; // already internal, e.g. USDT_TRC20
  if (!internal) internal = PROVIDER_TO_INTERNAL[upper] || "";
  if (!internal) return fallback;
  const [ac, nc] = internal.split("_");
  const asset = assetByCode(ac);
  if (!asset) return fallback;
  const net = (nc as NetworkCode) || null;
  return { code: internal, assetCode: ac, assetName: asset.name, network: asset.networks ? net : null };
}

// ── Display helpers — every stablecoin string carries its network ────────────
function isStable(m: { assetCode: string }): boolean {
  return STABLES.has(m.assetCode);
}
function networkLabel(net: NetworkCode | null): string {
  return net ? NETWORK_META[net].label : "";
}
// "USDT (TRC20)"  /  "Bitcoin (BTC)"
function methodLabel(m: ResolvedMethod): string {
  return isStable(m) ? `${m.assetCode} (${networkLabel(m.network)})` : `${m.assetName} (${m.assetCode})`;
}
// Unit used in the "send exactly" sentence: "USDT (TRC20)" for stables, "BTC" for natives.
function payUnit(m: ResolvedMethod): string {
  return isStable(m) ? `${m.assetCode} (${networkLabel(m.network)})` : m.assetCode;
}

type Step = "duration" | "method" | "invoice" | "success";

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

type ProviderCurrency = { code: string; symbol?: string; name?: string; network?: string };

const TERMINAL_STATUSES = new Set(["completed", "paid", "expired", "cancelled", "failed", "invoice_failed"]);
// Statuses where cancelling is no longer safe (funds may be inbound / settled).
const UNCANCELLABLE = new Set(["confirming", "processing", "paid", "completed", "expired", "cancelled", "failed", "invoice_failed"]);

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════
export default function RenewalPage() {
  const router = useRouter();
  const session = getPortalSession();
  const { data: bot, mutate: mutateBot } = usePortalBot();
  const { data, isLoading, mutate } = useRenewalOptions();

  const [selectedDuration, setSelectedDuration] = useState<"7d" | "30d">("30d");
  const [selectedAsset, setSelectedAsset] = useState("USDT");
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkCode>("TRC20");
  const [step, setStep] = useState<Step>("duration");
  const [invoice, setInvoice] = useState<Payment | null>(null);
  const [invoiceStatus, setInvoiceStatus] = useState("idle");
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [providerCodes, setProviderCodes] = useState<Set<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [netSheetOpen, setNetSheetOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Order we just cancelled/dismissed, so the restore effect doesn't re-open it from
  // the still-cached renewal-options response (the cancel race).
  const dismissedInvoiceRef = useRef<string | null>(null);

  const options = data?.options || {};
  const selectedOption = options?.[selectedDuration];

  const supportedAssets = useMemo(
    () => filterProviderBackedAssets(CRYPTO_ASSETS, providerCodes),
    [providerCodes]
  );
  const popularAssets = supportedAssets.filter((a) => a.popular);
  const otherAssets = supportedAssets.filter((a) => !a.popular);

  const asset = supportedAssets.find((a) => a.code === selectedAsset) ?? supportedAssets[0] ?? CRYPTO_ASSETS[0];
  const needsNetwork = !!asset.networks;
  const activeNetwork: NetworkCode | null = needsNetwork
    ? (asset.networks!.includes(selectedNetwork) ? selectedNetwork : asset.networks![0])
    : null;
  const selectedMethod = resolveMethod(asset.code, activeNetwork);
  // For stablecoins the user MUST have picked a network before continuing.
  const methodReady = !needsNetwork || !!activeNetwork;

  const selectAsset = (code: string) => {
    setSelectedAsset(code);
    const a = supportedAssets.find((x) => x.code === code);
    if (a?.networks) {
      setSelectedNetwork(a.networks[0]);
      setNetSheetOpen(true); // prompt for network immediately
    }
  };

  const status = invoiceStatus.toLowerCase();
  const isTerminal = TERMINAL_STATUSES.has(status);
  const hasOpenInvoice = !!invoice && !isTerminal;

  const planName = data?.bot?.plan_name || bot?.plan_name || "Custom";
  const hoursLeft = data?.bot?.hours_left;
  const remaining = hoursLeft != null ? formatRemaining(Number(hoursLeft)) : "";
  const planExpired = hoursLeft != null && Number(hoursLeft) <= 0;
  const graceHoursLeft = (bot?.grace_hours_left as number | null | undefined) ?? null;

  // ── Handlers (logic preserved from the original implementation) ────────────
  const copyText = async (value: string | number | undefined, label: string) => {
    if (value === undefined || value === null || value === "") return;
    try {
      await navigator.clipboard.writeText(String(value));
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Couldn't copy the ${label.toLowerCase()}. Select and copy it manually.`);
    }
  };

  const requestStatus = async (silent = false) => {
    if (!session || !invoice) return;
    setError("");
    try {
      const res = await portalApi.get(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renewal-status/${invoice.order_id}?telegram_id=${session.telegram_id}`
      );
      const nextStatus = res.data.status || "payment_waiting";
      setInvoiceStatus(nextStatus);
      setInvoice((prev) => (prev ? { ...prev, ...res.data } : prev));
      if (nextStatus === "completed" || nextStatus === "paid") {
        setStep("success");
        mutate();
        mutateBot();
      } else if (!silent) {
        toast.success("Status checked");
      }
    } catch (e: any) {
      if (!silent) setError(e?.response?.data?.detail || "Couldn't check payment status. Please try again.");
    }
  };

  const createInvoice = async () => {
    if (!session || !selectedOption?.available || hasOpenInvoice || creating || !methodReady) return;
    setCreating(true);
    setError("");
    try {
      const res = await portalApi.post(
        `/api/portal/bot/${encodeURIComponent(session.bot_name)}/renew?telegram_id=${session.telegram_id}`,
        { duration_days: selectedOption.days, currency: selectedMethod.code }
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
      setError(e?.response?.data?.detail || "Couldn't create the invoice. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const cancelInvoice = async (nextStep: Step = "duration") => {
    if (!session || !invoice) return;
    if (TERMINAL_STATUSES.has(invoiceStatus.toLowerCase())) {
      dismissedInvoiceRef.current = invoice.order_id;
      setInvoice(null);
      setInvoiceStatus("idle");
      setError("");
      setStep(nextStep);
      return;
    }
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
      setError(e?.response?.data?.detail || "Couldn't cancel the invoice. Please try again.");
    } finally {
      setCancelling(false);
    }
  };

  // ── Effects (unchanged semantics) ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    portalApi.get("/api/portal/crypto/currencies")
      .then((res) => {
        if (cancelled) return;
        const currencies = Array.isArray(res.data?.currencies) ? res.data.currencies : [];
        const codes = currencies
          .map((currency: ProviderCurrency) => String(currency.code || "").toUpperCase())
          .filter(Boolean);
        setProviderCodes(new Set(codes));
      })
      .catch(() => {
        if (!cancelled) setProviderCodes(null);
      });
    return () => { cancelled = true; };
  }, []);

  // Keep the selected asset/network valid as the provider-backed set resolves.
  useEffect(() => {
    if (!supportedAssets.length) return;
    const current = supportedAssets.find((a) => a.code === selectedAsset);
    if (!current) {
      const next = supportedAssets[0];
      setSelectedAsset(next.code);
      if (next.networks) setSelectedNetwork(next.networks[0]);
      return;
    }
    if (current.networks && !current.networks.includes(selectedNetwork)) {
      setSelectedNetwork(current.networks[0]);
    }
  }, [supportedAssets, selectedAsset, selectedNetwork]);

  // Restore an active unpaid invoice after a refresh so users never lose it and
  // duplicate invoices are never created silently.
  useEffect(() => {
    if (!data?.active_invoice || invoice) return;
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

  // Poll payment status; stop once terminal.
  useEffect(() => {
    if (!invoice || !session || isTerminal) return;
    const poll = setInterval(() => requestStatus(true), 8000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.order_id, isTerminal, session?.bot_name, session?.telegram_id]);

  if (isLoading || !bot) return <div className="mx-auto w-full max-w-[1120px]"><PageSkeleton /></div>;

  const invoiceMethod = invoice ? methodFromPayCurrency(invoice.pay_currency, selectedMethod) : selectedMethod;

  // Order summary is a single source of truth shared by steps 2 & 3.
  const summary = {
    planName,
    durationDays: selectedOption?.days || (selectedDuration === "7d" ? 7 : 30),
    amountUsd: selectedOption?.price ? formatUSD(Number(selectedOption.price)) : "—",
  };

  return (
    <div className="mx-auto w-full max-w-[1120px] pb-[calc(6.5rem+env(safe-area-inset-bottom))] lg:pb-4">
      {/* Compact back control — the page title + notification bell live in the shared header */}
      <Link
        href="/user/billing"
        className="inline-flex min-h-9 items-center gap-1.5 text-[13px] font-semibold text-[color:var(--sub)] transition-colors hover:text-[color:var(--txt)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/50 rounded-md"
        style={{ ["--sub" as any]: C.sub, ["--txt" as any]: C.text }}
      >
        <ArrowLeft className="h-4 w-4" /> Billing
      </Link>

      <div className="mt-3 space-y-5">
        <PlanStatusSummary planName={planName} planExpired={planExpired} remaining={remaining} graceHoursLeft={graceHoursLeft} />
        <RenewalStepper step={step} />

        {error && <RenewalError message={error} />}

        {step === "duration" && (
          <DurationStep
            options={options}
            planName={planName}
            planExpired={planExpired}
            selectedDuration={selectedDuration}
            setSelectedDuration={setSelectedDuration}
            hasOpenInvoice={hasOpenInvoice}
            onContinue={() => (hasOpenInvoice ? setStep("invoice") : setStep("method"))}
          />
        )}

        {step === "method" && (
          <PaymentStep
            popular={popularAssets}
            others={otherAssets}
            selectedAsset={selectedAsset}
            onSelectAsset={selectAsset}
            asset={asset}
            activeNetwork={activeNetwork}
            onOpenNetwork={() => setNetSheetOpen(true)}
            method={selectedMethod}
            methodReady={methodReady}
            summary={summary}
            creating={creating}
            disabled={!selectedOption?.available || hasOpenInvoice}
            onBack={() => setStep("duration")}
            onCreate={createInvoice}
          />
        )}

        {step === "invoice" && invoice && (
          <InvoiceStep
            invoice={invoice}
            status={invoiceStatus}
            method={invoiceMethod}
            now={now}
            planName={planName}
            cancelling={cancelling}
            cancellable={!UNCANCELLABLE.has(status)}
            onCopy={copyText}
            onRequestCancel={() => setCancelOpen(true)}
            onRestart={() => cancelInvoice("duration")}
          />
        )}

        {step === "success" && (
          <SuccessView invoice={invoice} method={invoiceMethod} planName={planName} onDashboard={() => router.push("/user/dashboard")} />
        )}
      </div>

      {/* Network chooser — bottom sheet on mobile, centred modal on desktop */}
      <NetworkSheet
        open={netSheetOpen && needsNetwork}
        assetCode={asset.code}
        networks={(asset.networks || []) as NetworkCode[]}
        selected={activeNetwork}
        onSelect={(n) => { setSelectedNetwork(n); setNetSheetOpen(false); }}
        onClose={() => setNetSheetOpen(false)}
      />

      {/* Cancel confirmation */}
      <CancelDialog
        open={cancelOpen}
        loading={cancelling}
        onKeep={() => setCancelOpen(false)}
        onConfirm={async () => { await cancelInvoice("duration"); setCancelOpen(false); }}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Plan status summary — compact horizontal strip
// ═════════════════════════════════════════════════════════════════════════════
function PlanStatusSummary({ planName, planExpired, remaining, graceHoursLeft }: {
  planName: string;
  planExpired: boolean;
  remaining: string;
  graceHoursLeft: number | null;
}) {
  const inGrace = planExpired && graceHoursLeft !== null && graceHoursLeft > 0;
  const windowLabel = inGrace ? `${graceHoursLeft}h` : remaining;
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-2xl border p-4 sm:p-5"
      style={{ borderColor: C.border, background: "linear-gradient(180deg,#10131D,#0C0E15)" }}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-3.5">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ background: "rgba(118,87,255,0.12)", border: "1px solid rgba(118,87,255,0.22)", color: "#B9A7FF" }}
        >
          <RefreshCw className="h-[22px] w-[22px]" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[16px] font-bold leading-tight" style={{ color: C.text }}>{planName} Plan</p>
          <p className="mt-1 text-[13px] font-semibold" style={{ color: planExpired ? "#F2555A" : C.success }}>
            {planExpired ? "Subscription expired" : "Subscription active"}
          </p>
        </div>
      </div>
      {windowLabel && (
        <div className="flex shrink-0 items-center gap-2.5 text-right">
          <div>
            <p className="text-[12px]" style={{ color: C.sub }}>Renew within</p>
            <p className="text-[19px] font-bold tabular-nums leading-tight sm:text-[20px]" style={{ color: C.text }}>{windowLabel}</p>
          </div>
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ border: `1px solid ${planExpired ? "rgba(242,85,90,0.4)" : C.border2}` }}
          >
            <Clock className="h-[18px] w-[18px]" style={{ color: planExpired ? "#F2555A" : C.sub }} />
          </span>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Stepper — shared across all three steps
// ═════════════════════════════════════════════════════════════════════════════
function RenewalStepper({ step }: { step: Step }) {
  const steps = [
    { id: "duration", label: "Duration" },
    { id: "method", label: "Payment" },
    { id: "invoice", label: "Invoice" },
  ] as const;
  const currentIndex = step === "success" ? 3 : steps.findIndex((s) => s.id === step);

  return (
    <nav aria-label="Renewal progress" className="px-1 pb-6">
      <ol className="flex items-center">
        {steps.map((s, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <li key={s.id} className={cn("flex items-center", i < steps.length - 1 && "flex-1")}>
              <div className="relative flex flex-col items-center">
                <span
                  aria-current={active ? "step" : undefined}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[13px] font-bold transition-colors"
                  style={{
                    background: active ? C.accent : done ? "rgba(37,201,160,0.15)" : C.surface2,
                    color: active ? "#fff" : done ? C.success : C.sub,
                    border: active ? `1px solid ${C.accent}` : done ? "1px solid rgba(37,201,160,0.35)" : `1px solid ${C.border2}`,
                  }}
                >
                  {done ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span
                  className="absolute left-1/2 top-[calc(100%+7px)] -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold sm:text-[13px]"
                  style={{ color: active ? C.text : done ? C.text2 : C.sub }}
                >
                  {s.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <span
                  className="mx-2 h-[2px] flex-1 rounded-full sm:mx-3"
                  style={{ background: done ? C.accent : C.border2 }}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 1 — Duration
// ═════════════════════════════════════════════════════════════════════════════
function DurationStep({ options, planName, planExpired, selectedDuration, setSelectedDuration, hasOpenInvoice, onContinue }: {
  options: any;
  planName: string;
  planExpired: boolean;
  selectedDuration: "7d" | "30d";
  setSelectedDuration: (d: "7d" | "30d") => void;
  hasOpenInvoice: boolean;
  onContinue: () => void;
}) {
  const selected = options?.[selectedDuration];
  const weeklyRate = Number(options?.["7d"]?.price || 0) / 7;
  const monthlyRate = Number(options?.["30d"]?.price || 0) / 30;
  const monthlyBest = weeklyRate > 0 && monthlyRate > 0 && monthlyRate < weeklyRate;

  return (
    <section className="mx-auto w-full max-w-[680px]">
      <StepHeading title="Choose renewal duration" text={`Select how long you want to extend your ${planName} plan.`} center />

      <div className="mt-6 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Renewal duration">
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
                "relative min-h-[120px] rounded-2xl border p-4 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60",
                disabled && "cursor-not-allowed opacity-60"
              )}
              style={{
                borderColor: active ? C.accent : C.border2,
                background: active ? "rgba(118,87,255,0.10)" : C.surface,
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors"
                  style={{ borderColor: active ? C.accent : C.faint, background: active ? C.accent : "transparent", color: "#fff" }}
                >
                  {active && <Check className="h-3 w-3" />}
                </span>
                {showBest && (
                  <span className="rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "#B9A7FF", background: "rgba(118,87,255,0.15)" }}>
                    Best value
                  </span>
                )}
              </div>
              <p className="mt-3 text-[18px] font-bold" style={{ color: C.text }}>{option?.days || (key === "7d" ? 7 : 30)} days</p>
              <p className="mt-0.5 text-[30px] font-black leading-none tabular-nums" style={{ color: C.text }}>
                {option?.available ? formatUSD(Number(option.price)) : "—"}
              </p>
              <p className="mt-2 text-[13px]" style={{ color: C.sub }}>
                {option?.available
                  ? <>Active through <span style={{ color: C.text2 }}>{formatDate(option?.new_valid_till)}</span></>
                  : (option?.unavailable_reason || "Unavailable")}
              </p>
            </button>
          );
        })}
      </div>

      <InfoNote className="mt-5">
        {planExpired
          ? "Your renewed subscription will start immediately after payment confirmation."
          : "Your renewal is added on top of your current subscription after payment confirmation."}
      </InfoNote>

      <StickyActionBar>
        <span className="hidden lg:block" />
        <Button
          className="h-[52px] w-full gap-2 rounded-xl text-[15px] font-bold sm:h-12 lg:h-11 lg:w-auto lg:px-6 lg:text-sm"
          style={{ background: C.accent }}
          onClick={onContinue}
          disabled={!selected?.available}
        >
          Continue to payment <ArrowRight className="h-4 w-4" />
        </Button>
      </StickyActionBar>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 2 — Payment method
// ═════════════════════════════════════════════════════════════════════════════
function PaymentStep({ popular, others, selectedAsset, onSelectAsset, asset, activeNetwork, onOpenNetwork, method, methodReady, summary, creating, disabled, onBack, onCreate }: {
  popular: CryptoAsset[];
  others: CryptoAsset[];
  selectedAsset: string;
  onSelectAsset: (code: string) => void;
  asset: CryptoAsset;
  activeNetwork: NetworkCode | null;
  onOpenNetwork: () => void;
  method: ResolvedMethod;
  methodReady: boolean;
  summary: { planName: string; durationDays: number; amountUsd: string };
  creating: boolean;
  disabled: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  const continueLabel = creating
    ? "Creating invoice…"
    : methodReady ? `Continue with ${methodLabel(method)}` : "Continue to invoice";

  return (
    <section>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
        {/* Left — selection */}
        <div>
          <StepHeading title="Choose payment method" text="Select your preferred cryptocurrency and network." />

          <GridLabel>Popular</GridLabel>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label="Popular cryptocurrencies">
            {popular.map((a) => (
              <CryptoTile
                key={a.code}
                asset={a}
                selected={selectedAsset === a.code}
                networkText={a.networks ? (selectedAsset === a.code && activeNetwork ? networkLabel(activeNetwork) : "Select network") : ""}
                onSelect={() => onSelectAsset(a.code)}
                onEditNetwork={a.networks ? onOpenNetwork : undefined}
              />
            ))}
          </div>

          {others.length > 0 && (
            <>
              <GridLabel>Other cryptocurrencies</GridLabel>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4" role="radiogroup" aria-label="Other cryptocurrencies">
                {others.map((a) => (
                  <CryptoTile
                    key={a.code}
                    asset={a}
                    compact
                    selected={selectedAsset === a.code}
                    networkText=""
                    onSelect={() => onSelectAsset(a.code)}
                  />
                ))}
              </div>
            </>
          )}

          {asset.networks && !activeNetwork && (
            <p className="mt-3 flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: C.amber }}>
              <AlertTriangle className="h-4 w-4" /> Select a network to continue.
            </p>
          )}

          <InfoNote className="mt-5">
            You&apos;ll review the exact amount and payment details before the invoice is created.
          </InfoNote>
        </div>

        {/* Right — sticky order summary (desktop only) */}
        <aside className="hidden lg:block lg:sticky lg:top-24">
          <div className="rounded-2xl border p-5" style={{ borderColor: C.border, background: C.card }}>
            <p className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: C.sub }}>Order summary</p>
            <div className="mt-3 space-y-2.5 text-[14px]">
              <SummaryRow label="Plan" value={`${summary.planName} Plan`} />
              <SummaryRow label="Duration" value={`${summary.durationDays} days`} />
              <SummaryRow label="Pay with" value={methodReady ? methodLabel(method) : "—"} />
            </div>
            <div className="my-4 h-px" style={{ background: C.border }} />
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold" style={{ color: C.sub }}>Total</span>
              <span className="text-[26px] font-black tabular-nums" style={{ color: C.text }}>{summary.amountUsd}</span>
            </div>
            <Button
              className="mt-4 h-12 w-full gap-2 rounded-xl text-[15px] font-bold"
              style={{ background: C.accent }}
              onClick={onCreate}
              disabled={disabled || creating || !methodReady}
              loading={creating}
            >
              {continueLabel} {!creating && <ArrowRight className="h-4 w-4" />}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="mt-2 block w-full text-center text-[13px] font-semibold transition-colors hover:text-[color:var(--t)]"
              style={{ color: C.sub, ["--t" as any]: C.text }}
            >
              Back to duration
            </button>
          </div>
        </aside>
      </div>

      {/* Mobile sticky bar */}
      <StickyActionBar>
        <Button variant="secondary" className="h-11 rounded-xl px-5 lg:hidden" onClick={onBack}>Back</Button>
        <Button
          className="h-[52px] w-full gap-2 rounded-xl text-[15px] font-bold lg:hidden"
          style={{ background: C.accent }}
          onClick={onCreate}
          disabled={disabled || creating || !methodReady}
          loading={creating}
        >
          {continueLabel}
        </Button>
      </StickyActionBar>
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: C.sub }}>{label}</span>
      <span className="truncate text-right font-semibold" style={{ color: C.text }}>{value}</span>
    </div>
  );
}

function CryptoTile({ asset, selected, networkText, compact, onSelect, onEditNetwork }: {
  asset: CryptoAsset;
  selected: boolean;
  networkText: string;
  compact?: boolean;
  onSelect: () => void;
  onEditNetwork?: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={`${asset.name} (${asset.code})`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-2xl border p-3 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60",
        compact ? "min-h-[76px] flex-row items-center gap-3" : "min-h-[104px] gap-2"
      )}
      style={{
        borderColor: selected ? C.accent : C.border2,
        background: selected ? "rgba(118,87,255,0.08)" : C.surface,
      }}
    >
      <div className={cn("flex items-center", compact ? "gap-3" : "justify-between")}>
        <CoinLogo code={asset.code} size={compact ? 32 : 36} />
        {!compact && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
            style={{ borderColor: selected ? C.accent : C.faint, background: selected ? C.accent : "transparent", color: "#fff" }}
          >
            {selected && <Check className="h-3 w-3" />}
          </span>
        )}
        {compact && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-bold" style={{ color: C.text }}>{asset.code}</p>
            <p className="truncate text-[12px]" style={{ color: C.sub }}>{asset.name}</p>
          </div>
        )}
        {compact && selected && <Check className="h-4 w-4 shrink-0" style={{ color: C.accent }} />}
      </div>

      {!compact && (
        <div className="min-w-0">
          <p className="truncate text-[14px] font-bold" style={{ color: C.text }}>{asset.code}</p>
          <p className="truncate text-[12px]" style={{ color: C.sub }}>{asset.name}</p>
        </div>
      )}

      {!compact && networkText && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEditNetwork?.(); }}
          className="mt-auto inline-flex items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition-colors"
          style={{
            borderColor: selected ? "rgba(118,87,255,0.5)" : C.border2,
            background: C.surface2,
            color: selected ? "#B9A7FF" : C.sub,
          }}
        >
          <span className="truncate">{networkText}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 rotate-90" />
        </button>
      )}
    </div>
  );
}

function GridLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-2.5 mt-5 text-[12px] font-bold uppercase tracking-wide first:mt-0" style={{ color: C.sub }}>{children}</p>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Network selector — bottom sheet (mobile) / modal (desktop)
// ═════════════════════════════════════════════════════════════════════════════
function NetworkSheet({ open, assetCode, networks, selected, onSelect, onClose }: {
  open: boolean;
  assetCode: string;
  networks: NetworkCode[];
  selected: NetworkCode | null;
  onSelect: (n: NetworkCode) => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={`Select ${assetCode} network`} size="sm">
      <div role="radiogroup" aria-label={`${assetCode} network`} className="space-y-2">
        {networks.map((n) => {
          const meta = NETWORK_META[n];
          const active = selected === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSelect(n)}
              className="flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7657FF]/60"
              style={{ borderColor: active ? C.accent : C.border2, background: active ? "rgba(118,87,255,0.10)" : C.surface }}
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
                style={{ borderColor: active ? C.accent : C.faint, background: active ? C.accent : "transparent", color: "#fff" }}
              >
                {active && <Check className="h-3 w-3" />}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-bold" style={{ color: C.text }}>{assetCode} ({meta.label})</p>
                <p className="text-[13px]" style={{ color: C.sub }}>{meta.full}</p>
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-4 flex items-start gap-2 text-[12px]" style={{ color: C.sub }}>
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: C.amber }} />
        Send {assetCode} only on the network you select here — using a different network can permanently lose the funds.
      </p>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 3 — Invoice
// ═════════════════════════════════════════════════════════════════════════════
function InvoiceStep({ invoice, status, method, now, planName, cancelling, cancellable, onCopy, onRequestCancel, onRestart }: {
  invoice: Payment;
  status: string;
  method: ResolvedMethod;
  now: number;
  planName: string;
  cancelling: boolean;
  cancellable: boolean;
  onCopy: (v: string | number | undefined, label: string) => void;
  onRequestCancel: () => void;
  onRestart: () => void;
}) {
  const s = status.toLowerCase();
  const expired = s === "expired" || s === "cancelled" || s === "failed" || s === "invoice_failed";
  const payAmount = Number(invoice.pay_amount || 0);
  const received = Number(invoice.amount_received || 0);
  const underpaid = received > 0 && payAmount > 0 && received < payAmount;
  const detected = s === "confirming" || s === "processing";
  const countdown = formatRemainingTime(invoice.invoice_expires_at, now);
  const cryptoAmount = String(invoice.pay_amount ?? "").trim();
  const stable = isStable(method);
  const unit = payUnit(method);
  const addrCaption = stable
    ? `${method.assetCode} (${networkLabel(method.network)}) address`
    : `${method.assetName} address`;

  if (expired) {
    return (
      <section className="mx-auto w-full max-w-[560px] text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "rgba(240,100,114,0.12)", border: "1px solid rgba(240,100,114,0.28)", color: C.danger }}>
          <Clock className="h-7 w-7" />
        </div>
        <h2 className="mt-4 text-[22px] font-bold" style={{ color: C.text }}>Invoice {s === "cancelled" ? "cancelled" : "expired"}</h2>
        <p className="mt-2 text-[14px]" style={{ color: C.sub }}>
          This invoice can no longer accept payment. Your plan wasn&apos;t charged.
        </p>
        <Button className="mx-auto mt-6 h-12 w-full max-w-xs gap-2 rounded-xl font-bold" style={{ background: C.accent }} onClick={onRestart}>
          Create a new invoice
        </Button>
      </section>
    );
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
      {/* LEFT — unified invoice card */}
      <div className="min-w-0 rounded-2xl border p-4 sm:p-6" style={{ borderColor: C.border, background: "linear-gradient(180deg,#0F1220,#0B0D14)" }}>
        {/* Amount to pay */}
        <p className="text-[16px] font-bold" style={{ color: C.text }}>Amount to pay</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <span className="break-all font-mono text-[clamp(32px,8.5vw,44px)] font-black leading-none tabular-nums" style={{ color: "#8B6CFF" }}>
            {cryptoAmount}
          </span>
          <span className="text-[clamp(18px,4vw,22px)] font-bold" style={{ color: C.text }}>{method.assetCode}</span>
          {stable && (
            <span className="rounded-lg px-2.5 py-1 text-[12px] font-bold" style={{ color: "#B9A7FF", border: "1px solid rgba(118,87,255,0.4)", background: "rgba(118,87,255,0.08)" }}>
              {networkLabel(method.network)}
            </span>
          )}
          <button
            type="button"
            onClick={() => onCopy(invoice.pay_amount, "Amount")}
            aria-label="Copy amount"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors hover:border-[#7657FF]/50"
            style={{ borderColor: C.border, background: C.field, color: C.sub }}
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-[13px]" style={{ color: C.faint }}>≈ {formatUSD(Number(invoice.amount_usd))} USD</p>

        {/* Exact-payment instruction */}
        <p className="mt-3.5 text-[14px] leading-relaxed" style={{ color: C.sub }}>
          Send exactly <span className="font-bold" style={{ color: C.text2 }}>{cryptoAmount} {unit}</span> to the address below
        </p>

        {/* Status banner — only for meaningful states (detected / underpaid) */}
        {(detected || underpaid) && (
          <div className="mt-3.5" aria-live="polite">
            <StatusBanner
              tone={underpaid ? "amber" : "accent"}
              text={underpaid
                ? `Received ${trimNum(received)} of ${trimNum(payAmount)} ${method.assetCode} — send the remaining ${trimNum(payAmount - received)}.`
                : "Payment detected — waiting for blockchain confirmation."}
            />
          </div>
        )}

        {/* Address */}
        <div className="mt-4">
          <CopyField value={invoice.pay_address} onCopy={() => onCopy(invoice.pay_address, "Wallet address")} />
        </div>

        {/* Divider */}
        <div className="my-5 h-px" style={{ background: C.border }} />

        {/* QR + metadata — side-by-side on all common phones; stacks only below 360px */}
        <div className="flex flex-col items-center gap-4 min-[360px]:flex-row min-[360px]:items-start sm:gap-5">
          <div className="flex shrink-0 flex-col items-center gap-2">
            <QrCode value={invoice.pay_address} />
            <p className="max-w-[132px] text-center text-[11.5px] leading-tight sm:max-w-[150px] lg:max-w-[180px]" style={{ color: C.sub }}>{addrCaption}</p>
          </div>
          <dl className="flex min-w-0 flex-1 flex-col justify-center gap-4">
            <MetaRow icon={Coins} label="Payment Method" value={methodLabel(method)} />
            <MetaRow icon={CalendarDays} label="Plan Duration" value={`${invoice.duration_days} days`} />
            <MetaRow icon={Clock} label="Invoice Expires In" value={countdown} valueStyle={{ color: C.amber }} mono />
            <MetaRow icon={ReceiptText} label="Invoice ID" value={shortId(invoice.order_id)} mono onCopy={() => onCopy(invoice.order_id, "Invoice ID")} />
          </dl>
        </div>
      </div>

      {/* RIGHT — instructions + cancel */}
      <div className="min-w-0 space-y-4">
        <InstructionsCard method={method} planName={planName} stable={stable} />
        {cancellable ? (
          <button
            type="button"
            onClick={onRequestCancel}
            disabled={cancelling}
            className="h-12 w-full rounded-xl border text-[14px] font-semibold transition-colors hover:border-[#F06472]/40 hover:text-[color:var(--d)] disabled:opacity-50"
            style={{ borderColor: C.border2, background: "transparent", color: C.sub, ["--d" as any]: C.danger }}
          >
            Cancel Invoice
          </button>
        ) : (
          <p className="text-center text-[12px]" style={{ color: C.sub }}>
            This invoice can no longer be cancelled — a payment is being processed.
          </p>
        )}
      </div>
    </section>
  );
}

function StatusBanner({ tone, text }: { tone: "amber" | "accent"; text: string }) {
  const color = tone === "amber" ? C.amber : "#B9A7FF";
  const bg = tone === "amber" ? "rgba(242,185,75,0.08)" : "rgba(118,87,255,0.08)";
  const bd = tone === "amber" ? "rgba(242,185,75,0.28)" : "rgba(118,87,255,0.3)";
  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] font-semibold" style={{ color, background: bg, borderColor: bd }}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span>{text}</span>
    </div>
  );
}

function CopyField({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title={value}
      aria-label="Copy wallet address"
      className="flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors hover:border-[#7657FF]/50"
      style={{ borderColor: C.border, background: C.field }}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[13.5px]" style={{ color: C.text }}>{value}</span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: C.surface2, color: C.sub }}>
        <Copy className="h-4 w-4" />
      </span>
    </button>
  );
}

function MetaRow({ icon: Icon, label, value, valueStyle, mono, onCopy }: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  valueStyle?: React.CSSProperties;
  mono?: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 sm:gap-3">
      {Icon && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(118,87,255,0.10)", color: "#B9A7FF" }}>
          <Icon className="h-4 w-4" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row lg:items-center lg:justify-between lg:gap-2">
        <dt className="text-[12px] lg:truncate lg:text-[13px]" style={{ color: C.sub }}>{label}</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-[13px] font-bold tabular-nums lg:text-[13.5px]", mono && "font-mono")} style={{ color: C.text, ...valueStyle }}>{value}</span>
          {onCopy && (
            <button type="button" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} className="shrink-0 transition-colors hover:text-[color:var(--t)]" style={{ color: C.sub, ["--t" as any]: C.text }}>
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
        </dd>
      </div>
    </div>
  );
}

function QrCode({ value }: { value: string }) {
  const url = value
    ? `https://api.qrserver.com/v1/create-qr-code/?size=440x440&margin=0&qzone=1&data=${encodeURIComponent(value)}`
    : "";
  return (
    <div className="shrink-0 rounded-2xl bg-white p-2.5 sm:p-3">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="Payment QR code"
          width={190}
          height={190}
          className="h-[124px] w-[124px] min-[360px]:h-[136px] min-[360px]:w-[136px] sm:h-[152px] sm:w-[152px] lg:h-[180px] lg:w-[180px]"
          style={{ imageRendering: "pixelated" }}
        />
      ) : (
        <div className="flex h-[136px] w-[136px] items-center justify-center text-sm font-semibold lg:h-[180px] lg:w-[180px]" style={{ color: "#0E1018" }}>
          QR unavailable
        </div>
      )}
    </div>
  );
}

function InstructionsCard({ method, planName, stable }: { method: ResolvedMethod; planName: string; stable: boolean }) {
  const netLabel = networkLabel(method.network);
  const netFull = method.network ? NETWORK_META[method.network].full : "";
  const items = [
    stable ? `Send only ${method.assetCode} (${netLabel}) to the address above.` : `Send only ${method.assetName} to the address above.`,
    "Send the exact amount. Do not send less or more.",
    "Your payment will be detected automatically.",
    `After successful payment, your ${planName} plan will be renewed instantly.`,
  ];
  return (
    <div className="rounded-2xl border p-4 sm:p-5" style={{ borderColor: C.border, background: "linear-gradient(180deg,#0F1220,#0B0D14)" }}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(118,87,255,0.12)", color: "#B9A7FF" }}>
          <Info className="h-4 w-4" />
        </span>
        <p className="text-[15px] font-bold" style={{ color: C.text }}>Important Instructions</p>
      </div>
      <ul className="mt-3.5 space-y-2.5">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed" style={{ color: C.sub }}>
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: C.faint }} aria-hidden />
            <span>{t}</span>
          </li>
        ))}
      </ul>
      {stable && (
        <p className="mt-3.5 flex items-start gap-2 rounded-lg border p-2.5 text-[12px] font-semibold leading-relaxed" style={{ color: C.amber, borderColor: "rgba(242,185,75,0.25)", background: "rgba(242,185,75,0.07)" }}>
          <ShieldAlert className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          Send on the {netLabel} network only{netFull ? ` (${netFull})` : ""} — a different network can permanently lose the funds.
        </p>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Success
// ═════════════════════════════════════════════════════════════════════════════
function SuccessView({ invoice, method, planName, onDashboard }: {
  invoice: Payment | null;
  method: ResolvedMethod;
  planName: string;
  onDashboard: () => void;
}) {
  const through = formatDate(invoice?.new_valid_till || invoice?.new_valid_till_preview);
  const days = invoice?.duration_days;
  return (
    <section className="mx-auto w-full max-w-[520px] text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "rgba(37,201,160,0.15)", border: "1px solid rgba(37,201,160,0.3)", color: C.success }}>
        <CheckCircle2 className="h-7 w-7" />
      </div>
      <h2 className="mt-4 text-[24px] font-bold" style={{ color: C.text }}>Payment confirmed</h2>
      <p className="mt-2 text-[14px]" style={{ color: C.sub }}>
        Your {planName} plan has been renewed{days ? ` for ${days} days` : ""}.
      </p>

      <div className="mt-6 rounded-2xl border p-4 text-left" style={{ borderColor: C.border, background: C.card }}>
        <dl className="space-y-3">
          <MetaRow label="Active through" value={through} />
          <MetaRow label="Payment method" value={methodLabel(method)} />
          {invoice?.order_id && <MetaRow label="Invoice ID" value={shortId(invoice.order_id)} mono />}
        </dl>
      </div>

      <Button className="mt-6 h-12 w-full gap-2 rounded-xl font-bold" style={{ background: C.accent }} onClick={onDashboard}>
        Go to Dashboard
      </Button>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Cancel confirmation
// ═════════════════════════════════════════════════════════════════════════════
function CancelDialog({ open, loading, onKeep, onConfirm }: {
  open: boolean;
  loading: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onKeep} size="sm">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "rgba(240,100,114,0.12)" }}>
          <AlertTriangle className="h-6 w-6" style={{ color: C.danger }} />
        </div>
        <h3 className="text-[18px] font-bold" style={{ color: C.text }}>Cancel this invoice?</h3>
        <p className="text-[14px]" style={{ color: C.sub }}>
          This payment address will no longer be valid for this renewal. You can create another invoice by restarting the renewal process.
        </p>
        <div className="flex w-full gap-3 pt-1">
          <Button variant="secondary" className="h-11 flex-1 rounded-xl" onClick={onKeep} disabled={loading}>Keep invoice</Button>
          <Button variant="danger" className="h-11 flex-1 rounded-xl" onClick={onConfirm} loading={loading}>Cancel invoice</Button>
        </div>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared primitives
// ═════════════════════════════════════════════════════════════════════════════
function StepHeading({ title, text, center }: { title: string; text: string; center?: boolean }) {
  return (
    <div className={center ? "text-center" : ""}>
      <h2 className="text-[clamp(20px,4.5vw,26px)] font-bold" style={{ color: C.text }}>{title}</h2>
      <p className="mt-1 text-[14px]" style={{ color: C.sub }}>{text}</p>
    </div>
  );
}

function InfoNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl border p-3.5 text-[13px] leading-relaxed", className)} style={{ borderColor: C.border2, background: C.surface2, color: C.sub }}>
      <Info className="mt-0.5 h-4 w-4 shrink-0" style={{ color: C.accent }} aria-hidden />
      <p>{children}</p>
    </div>
  );
}

function RenewalError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-xl border p-3 text-[14px] font-semibold" style={{ borderColor: "rgba(240,100,114,0.3)", background: "rgba(240,100,114,0.1)", color: C.danger }}>
      {message}
    </div>
  );
}

// Sticky action bar: fixed to the safe-area bottom on mobile, inline (right-aligned) on desktop.
function StickyActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:z-auto lg:mt-6 lg:justify-end lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
      style={{ borderColor: C.border, background: "rgba(11,12,18,0.95)" }}
    >
      {children}
    </div>
  );
}

function CoinLogo({ code, size = 36 }: { code: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@1a63530be6e374711a8554f31b17e4cb92c25fa5/128/color/${code.toLowerCase()}.png`;
  const colors: Record<string, string> = {
    BTC: "#F7931A", ETH: "#627EEA", XMR: "#FF6600", LTC: "#345D9D", SOL: "#9945FF",
    USDT: "#26A17B", USDC: "#2775CA", TRX: "#EF0027", BNB: "#F3BA2F", XRP: "#23A9E0",
    MATIC: "#8247E5", TON: "#0098EA",
  };
  if (failed) {
    const color = colors[code] || C.accent;
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full text-[10px] font-black" style={{ width: size, height: size, background: `${color}22`, color }}>
        {code.slice(0, 3)}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={`${code} logo`} width={size} height={size} loading="lazy" onError={() => setFailed(true)} className="shrink-0 rounded-full" style={{ width: size, height: size }} />;
}

// ── Utility helpers ──────────────────────────────────────────────────────────
function filterProviderBackedAssets(assets: CryptoAsset[], providerCodes: Set<string> | null): CryptoAsset[] {
  if (!providerCodes || providerCodes.size === 0) return assets;
  return assets.flatMap((asset) => {
    if (!asset.networks) return providerCodes.has(asset.code) ? [asset] : [];
    const networks = asset.networks.filter((n) => providerCodes.has(internalCode(asset.code, n)));
    return networks.length ? [{ ...asset, networks }] : [];
  });
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

// Backend stores invoice_expires_at as naive UTC (no tz) — append Z so it isn't
// parsed as local time and skew the countdown.
function parseInvoiceDate(value: string | undefined): Date | null {
  if (!value) return null;
  let raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) raw = `${raw}Z`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Trim a numeric crypto amount for display without re-rounding backend precision.
function trimNum(n: number): string {
  if (!isFinite(n)) return "0";
  return String(Number(n.toFixed(8)));
}

function shortId(id: string): string {
  return id && id.length > 11 ? `${id.slice(0, 8)}…${id.slice(-2)}` : id || "—";
}
