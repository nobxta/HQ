"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAdbots } from "@/lib/hooks/useAdbots";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { useForm } from "react-hook-form";
import { Play, Square, Trash2, Plus, Search, RotateCw, CheckCircle, XCircle, Loader2, CheckSquare, AlertTriangle } from "lucide-react";
import { getSession } from "next-auth/react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDate } from "@/lib/utils";
import type { BotCreatePayload } from "@/lib/types";

export default function AdbotsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, mutate } = useAdbots(stateFilter, page);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const bots = (data?.items || []).filter((b) =>
    !filter || b.name.toLowerCase().includes(filter.toLowerCase())
  );

  const action = async (name: string, act: string, method: "post" | "delete" = "post") => {
    setActionLoading(name);
    try {
      if (method === "delete") {
        await api.delete(`/api/bots/${name}`);
      } else {
        await api.post(`/api/bots/${name}/${act}`);
      }
      toast.success(`${act} ${name} — success`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `Failed to ${act} ${name}`);
    }
    setActionLoading(null);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Toolbar */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
            <input
              className="w-full rounded-lg border border-dark-600 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="Search bots…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <Button onClick={() => setShowCreate(true)} size="sm" className="shrink-0">
            <Plus className="h-4 w-4" /> <span className="hidden sm:inline">Create Bot</span><span className="sm:hidden">New</span>
          </Button>
        </div>
        <div className="flex gap-1 rounded-lg bg-dark-800 p-0.5 overflow-x-auto">
          {["", "running", "stopped", "frozen", "suspended"].map((s) => (
            <button
              key={s}
              onClick={() => { setStateFilter(s); setPage(1); }}
              className={`px-3 py-1.5 text-xs rounded-md transition-all whitespace-nowrap ${
                stateFilter === s ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"
              }`}
            >
              {s || "All"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={7} />
      ) : (
        <>
          <Table>
            <Thead>
              <tr>
                <Th>Name</Th>
                <Th>Mode</Th>
                <Th>Sessions</Th>
                <Th>Cycle</Th>
                <Th>Valid Until</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </Thead>
            <Tbody>
              {bots.length === 0 ? (
                <Tr><Td className="text-center py-8 text-dark-500" colSpan={7}>No bots found</Td></Tr>
              ) : (
                bots.map((bot) => (
                  <Tr key={bot.name} onClick={() => router.push(`/admin/adbots/${bot.name}`)}>
                    <Td className="font-medium text-dark-100">{bot.name}</Td>
                    <Td><Badge status={bot.mode} /></Td>
                    <Td>{bot.sessions_count}</Td>
                    <Td>{bot.cycle}s</Td>
                    <Td>{formatDate(bot.valid_till)}</Td>
                    <Td><Badge status={bot.running ? "running" : bot.frozen ? "frozen" : bot.suspended ? "suspended" : "stopped"} /></Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        {bot.running ? (
                          <Button variant="ghost" size="sm" onClick={() => action(bot.name, "stop")} loading={actionLoading === bot.name}>
                            <Square className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => action(bot.name, "start")} loading={actionLoading === bot.name}>
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => action(bot.name, "restart")}>
                          <RotateCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(bot.name)}>
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))
              )}
            </Tbody>
          </Table>
          {/* Pagination */}
          {(data?.pages || 1) > 1 && (
            <div className="flex justify-center gap-2">
              {Array.from({ length: data!.pages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`px-3 py-1 rounded text-sm ${p === page ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"}`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Delete confirm */}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await action(deleteTarget, "delete", "delete");
          setDeleteTarget(null);
        }}
        title="Delete Bot"
        message={`Are you sure you want to delete "${deleteTarget}"? Sessions will be returned to the free pool.`}
        confirmText="Delete"
      />

      {/* Create modal */}
      <CreateBotModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); mutate(); }} />
    </div>
  );
}

/* ───────────────────────── Creation Wizard ───────────────────────── */

interface CreateContext {
  free_sessions: number;
  group_files: { filename: string; lines: number }[];
  max_sessions: number;
}

interface WizardData {
  name: string;
  bot_token: string;
  bot_username: string;
  sessions_count: number;
  cycle: number;
  gap: number;
  mode: string;
  group_file: string;
  valid_till: string;
  renewal_price: number;
  skip_health_check: boolean;
  skip_chatlist_join: boolean;
}

type WizardStep = "loading" | "name" | "bot_token" | "sessions" | "timing" | "mode" | "group_file" | "validity" | "summary" | "creating" | "success" | "failed";

const CYCLE_PRESETS = [
  { label: "5 min", value: 300 },
  { label: "10 min", value: 600 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 hr", value: 3600 },
  { label: "2 hr", value: 7200 },
];

const GAP_PRESETS = [
  { label: "1s", value: 1 },
  { label: "3s", value: 3 },
  { label: "5s", value: 5 },
  { label: "8s", value: 8 },
  { label: "10s", value: 10 },
  { label: "15s", value: 15 },
];

const SESSION_PRESETS = [1, 2, 3, 5, 8, 10, 15, 20];

interface ProgressLine { message: string; ts: number; }

function CreateBotModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<WizardStep>("loading");
  const [ctx, setCtx] = useState<CreateContext | null>(null);
  const [data, setData] = useState<WizardData>({
    name: "", bot_token: "", bot_username: "", sessions_count: 1,
    cycle: 300, gap: 5, mode: "starter", group_file: "",
    valid_till: "", renewal_price: 0,
    skip_health_check: false, skip_chatlist_join: false,
  });
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);
  const [progressLines, setProgressLines] = useState<ProgressLine[]>([]);
  const [resultMsg, setResultMsg] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    progressEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLines]);

  const cleanup = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
  }, []);

  // Load context when opened
  useEffect(() => {
    if (!open) {
      cleanup();
      setStep("loading");
      setCtx(null);
      setData({ name: "", bot_token: "", bot_username: "", sessions_count: 1, cycle: 300, gap: 5, mode: "starter", group_file: "", valid_till: "", renewal_price: 0, skip_health_check: false, skip_chatlist_join: false });
      setError("");
      setProgressLines([]);
      setResultMsg("");
      return;
    }
    (async () => {
      try {
        const res = await api.get("/api/bots/create-context");
        setCtx(res.data);
        if (res.data.free_sessions === 0) {
          setError("No free sessions available. Add sessions first.");
        }
        setStep("name");
      } catch {
        setError("Failed to load creation data");
        setStep("name");
      }
    })();
  }, [open, cleanup]);

  const update = (partial: Partial<WizardData>) => setData((d) => ({ ...d, ...partial }));

  const connectWs = (botName: string): Promise<WebSocket | null> => {
    return new Promise(async (resolve) => {
      const session = await getSession();
      const token = (session as any)?.accessToken;
      if (!token) { resolve(null); return; }
      const wsBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/^http/, "ws");
      const ws = new WebSocket(`${wsBase}/ws/create/${encodeURIComponent(botName)}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => resolve(ws);
      ws.onmessage = (evt) => {
        try {
          const d = JSON.parse(evt.data);
          const msg = d.message || "";
          const status = d.status || "progress";
          if (status === "success") { setStep("success"); setResultMsg(msg); cleanup(); }
          else if (status === "failed") { setStep("failed"); setResultMsg(msg || "Creation failed"); cleanup(); }
          else if (status === "done") { setStep((p) => p === "creating" ? "success" : p); cleanup(); }
          else { setProgressLines((prev) => [...prev, { message: msg, ts: Date.now() }]); }
        } catch {}
      };
      ws.onerror = () => { setStep("failed"); setResultMsg("Lost connection to server"); cleanup(); resolve(null); };
      setTimeout(() => resolve(null), 5000);
    });
  };

  const submitCreation = async () => {
    setError("");
    try {
      const ws = await connectWs(data.name);
      if (!ws) { setError("Failed to connect for live updates"); return; }
      setStep("creating");
      setProgressLines([{ message: "Creation job queued...", ts: Date.now() }]);
      await api.post("/api/bots", {
        name: data.name,
        bot_token: data.bot_token,
        sessions_count: data.sessions_count,
        cycle: data.cycle,
        gap: data.gap,
        mode: data.mode,
        group_file: data.group_file,
        valid_till: data.valid_till,
        renewal_price: data.renewal_price,
        plan_name: "Custom",
        skip_health_check: data.skip_health_check,
        skip_chatlist_join: data.skip_chatlist_join,
      });
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to create bot");
      cleanup();
      setStep("summary");
    }
  };

  const validateToken = async () => {
    const token = data.bot_token.trim();
    if (!token) { setError("Enter a bot token"); return; }
    setValidating(true);
    setError("");
    try {
      const res = await api.post("/api/bots/validate-token", { bot_token: token });
      update({ bot_username: res.data.username, bot_token: token });
      setStep("sessions");
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Invalid token");
    }
    setValidating(false);
  };

  const canClose = step !== "creating";
  const stepIndex = ["name", "bot_token", "sessions", "timing", "mode", "group_file", "validity", "summary"].indexOf(step);
  const totalSteps = 8;

  /* ── Step Header ── */
  const StepHeader = ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div className="mb-5">
      {stepIndex >= 0 && (
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 h-1 rounded-full bg-dark-700 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${((stepIndex + 1) / totalSteps) * 100}%` }} />
          </div>
          <span className="text-[10px] text-dark-500 shrink-0">{stepIndex + 1}/{totalSteps}</span>
        </div>
      )}
      <h3 className="text-base font-semibold text-dark-100">{title}</h3>
      {subtitle && <p className="text-xs text-dark-500 mt-1">{subtitle}</p>}
    </div>
  );

  /* ── Navigation ── */
  const NavButtons = ({ onBack, onNext, nextLabel = "Continue", nextDisabled = false, nextLoading = false }: {
    onBack?: () => void; onNext: () => void; nextLabel?: string; nextDisabled?: boolean; nextLoading?: boolean;
  }) => (
    <div className="flex items-center justify-between pt-4 mt-4 border-t border-dark-800">
      {onBack ? (
        <Button variant="ghost" size="sm" onClick={onBack} type="button">Back</Button>
      ) : <div />}
      <Button size="sm" onClick={onNext} disabled={nextDisabled} loading={nextLoading}>{nextLabel}</Button>
    </div>
  );

  /* ── Tick toggle (skip-step options) ── */
  const TickOption = ({ label, hint, checked, onChange }: {
    label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
        checked ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"
      }`}
    >
      {checked
        ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />
      }
      <span>
        <span className={`block text-xs font-medium ${checked ? "text-warning" : "text-dark-300"}`}>{label}</span>
        {hint && <span className="block text-[11px] text-dark-500 mt-0.5">{hint}</span>}
      </span>
    </button>
  );

  /* ── Chip selector ── */
  const ChipSelect = <T extends string | number>({ options, value, onChange }: {
    options: { label: string; value: T }[]; value: T; onChange: (v: T) => void;
  }) => (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={String(o.value)} type="button" onClick={() => onChange(o.value)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
            value === o.value ? "border-accent bg-accent/10 text-accent" : "border-dark-700 bg-dark-800 text-dark-400 hover:border-dark-600"
          }`}
        >{o.label}</button>
      ))}
    </div>
  );

  const renderStep = () => {
    if (step === "loading") {
      return (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      );
    }

    if (step === "name") {
      return (
        <>
          <StepHeader title="Bot Name" subtitle="Enter an internal name for this bot (e.g. shop_promo)" />
          {ctx && (
            <div className="rounded-lg bg-dark-800 border border-dark-700/50 px-3 py-2 mb-4 flex items-center justify-between">
              <span className="text-xs text-dark-400">Available sessions</span>
              <span className={`text-sm font-mono font-bold ${ctx.free_sessions > 0 ? "text-accent" : "text-danger"}`}>{ctx.free_sessions}</span>
            </div>
          )}
          <Input
            label="Internal Name" id="cw-name" placeholder="e.g. buyer2"
            value={data.name} onChange={(e) => update({ name: e.target.value })}
            error={error}
            autoFocus
          />
          <NavButtons onNext={() => {
            if (!data.name.trim()) { setError("Enter a name"); return; }
            if (ctx && ctx.free_sessions === 0) { setError("No free sessions available"); return; }
            setError(""); setStep("bot_token");
          }} nextDisabled={!data.name.trim() || (ctx?.free_sessions === 0)} />
        </>
      );
    }

    if (step === "bot_token") {
      return (
        <>
          <StepHeader title="Bot Token" subtitle="Paste the token from @BotFather" />
          <Input
            label="Bot Token" id="cw-token" placeholder="123456:ABCdef..."
            value={data.bot_token} onChange={(e) => { update({ bot_token: e.target.value }); setError(""); }}
            error={error}
            autoFocus
          />
          {data.bot_username && (
            <div className="mt-2 rounded-lg bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs text-green-300">
              Verified: @{data.bot_username}
            </div>
          )}
          <NavButtons
            onBack={() => { setError(""); setStep("name"); }}
            onNext={validateToken}
            nextLabel="Validate & Continue"
            nextDisabled={!data.bot_token.trim()}
            nextLoading={validating}
          />
        </>
      );
    }

    if (step === "sessions") {
      const maxSessions = ctx?.max_sessions || 50;
      const presets = SESSION_PRESETS.filter((n) => n <= maxSessions);
      return (
        <>
          <StepHeader title="Sessions" subtitle={`How many sessions to assign (max ${maxSessions})`} />
          <div className="flex flex-wrap gap-1.5 mb-4">
            {presets.map((n) => (
              <button key={n} type="button" onClick={() => update({ sessions_count: n })}
                className={`rounded-lg border px-3.5 py-2.5 text-sm font-medium transition-all min-w-[48px] ${
                  data.sessions_count === n ? "border-accent bg-accent/10 text-accent" : "border-dark-700 bg-dark-800 text-dark-400 hover:border-dark-600"
                }`}
              >{n}</button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Input
              label="Custom" id="cw-sessions" type="number" min={1} max={maxSessions}
              value={data.sessions_count} onChange={(e) => update({ sessions_count: Math.min(maxSessions, Math.max(1, Number(e.target.value))) })}
              className="w-24"
            />
            <span className="text-xs text-dark-500 mt-5">sessions</span>
          </div>

          <div className="mt-5 space-y-2">
            <p className="text-[11px] font-medium text-dark-500 uppercase tracking-wider">Advanced — skip steps</p>
            <TickOption
              label="Skip session health check"
              hint="Use sessions even if they fail validation, instead of rejecting them (lets you assign dead/limited sessions)."
              checked={data.skip_health_check}
              onChange={(v) => update({ skip_health_check: v })}
            />
            <TickOption
              label="Skip default chatlist auto-join"
              hint="Don't auto-join the assigned sessions to the mode's default chatlist folders."
              checked={data.skip_chatlist_join}
              onChange={(v) => update({ skip_chatlist_join: v })}
            />
            {data.skip_health_check && (
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/20 px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                <span className="text-[11px] text-warning/90">Health check is skipped — bad or dead sessions can be assigned and the bot may be unstable.</span>
              </div>
            )}
          </div>

          <NavButtons
            onBack={() => { setError(""); setStep("bot_token"); }}
            onNext={() => { setError(""); setStep("timing"); }}
          />
        </>
      );
    }

    if (step === "timing") {
      return (
        <>
          <StepHeader title="Timing" subtitle="Set cycle interval and gap between posts" />
          <div className="space-y-5">
            <div>
              <label className="text-sm text-dark-300 mb-2 block font-medium">Cycle Interval</label>
              <ChipSelect options={CYCLE_PRESETS} value={data.cycle} onChange={(v) => update({ cycle: v })} />
              <div className="flex items-center gap-2 mt-3">
                <input type="number" min={60} value={data.cycle}
                  onChange={(e) => update({ cycle: Math.max(60, Number(e.target.value)) })}
                  className="w-28 rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                <span className="text-xs text-dark-500">sec (min 60)</span>
              </div>
            </div>
            <div>
              <label className="text-sm text-dark-300 mb-2 block font-medium">Gap between posts</label>
              <ChipSelect options={GAP_PRESETS} value={data.gap} onChange={(v) => update({ gap: v })} />
              <div className="flex items-center gap-2 mt-3">
                <input type="number" min={1} max={60} value={data.gap}
                  onChange={(e) => update({ gap: Math.min(60, Math.max(1, Number(e.target.value))) })}
                  className="w-28 rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
                <span className="text-xs text-dark-500">sec (1-60)</span>
              </div>
            </div>
          </div>
          <NavButtons
            onBack={() => setStep("sessions")}
            onNext={() => setStep("mode")}
          />
        </>
      );
    }

    if (step === "mode") {
      return (
        <>
          <StepHeader title="Mode" subtitle="Select the operating mode" />
          <div className="grid grid-cols-2 gap-3">
            {[
              { value: "starter", label: "Starter", desc: "Standard posting mode" },
              { value: "enterprise", label: "Enterprise", desc: "Advanced features" },
            ].map((m) => (
              <button key={m.value} type="button" onClick={() => update({ mode: m.value })}
                className={`rounded-xl border p-4 text-left transition-all ${
                  data.mode === m.value
                    ? "border-accent bg-accent/10 ring-1 ring-accent/30"
                    : "border-dark-700 bg-dark-800 hover:border-dark-600"
                }`}
              >
                <span className={`text-sm font-semibold ${data.mode === m.value ? "text-accent" : "text-dark-200"}`}>{m.label}</span>
                <p className="text-[11px] text-dark-500 mt-1">{m.desc}</p>
              </button>
            ))}
          </div>
          <NavButtons
            onBack={() => setStep("timing")}
            onNext={() => setStep("group_file")}
          />
        </>
      );
    }

    if (step === "group_file") {
      const files = ctx?.group_files || [];
      return (
        <>
          <StepHeader title="Group File" subtitle="Select the group list for posting" />
          {files.length === 0 ? (
            <div className="rounded-lg bg-dark-800 border border-dark-700 p-4 text-center">
              <p className="text-sm text-dark-400">No group files found</p>
              <p className="text-xs text-dark-500 mt-1">Create a .txt file in the groups/ folder</p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {files.map((f) => (
                <button key={f.filename} type="button" onClick={() => update({ group_file: f.filename })}
                  className={`w-full rounded-lg border px-3.5 py-3 text-left transition-all flex items-center justify-between ${
                    data.group_file === f.filename
                      ? "border-accent bg-accent/10 ring-1 ring-accent/30"
                      : "border-dark-700 bg-dark-800 hover:border-dark-600"
                  }`}
                >
                  <span className={`text-sm font-medium truncate ${data.group_file === f.filename ? "text-accent" : "text-dark-200"}`}>
                    {f.filename}
                  </span>
                  <span className="text-[11px] text-dark-500 shrink-0 ml-2">{f.lines} groups</span>
                </button>
              ))}
            </div>
          )}
          <NavButtons
            onBack={() => setStep("mode")}
            onNext={() => {
              if (!data.group_file && files.length > 0) { setError("Select a group file"); return; }
              setError(""); setStep("validity");
            }}
            nextDisabled={!data.group_file && files.length > 0}
          />
        </>
      );
    }

    if (step === "validity") {
      return (
        <>
          <StepHeader title="Validity & Price" subtitle="Set expiration date and renewal price" />
          <div className="space-y-4">
            <Input
              label="Valid Until" id="cw-valid" type="date"
              value={data.valid_till} onChange={(e) => update({ valid_till: e.target.value })}
              error={!data.valid_till && error ? error : undefined}
              autoFocus
            />
            <div>
              <label className="block text-sm font-medium text-dark-300 mb-1.5">Renewal Price (USD)</label>
              <div className="flex items-center gap-2">
                <span className="text-dark-400 text-sm">$</span>
                <input type="number" min={0} step={0.01} value={data.renewal_price}
                  onChange={(e) => update({ renewal_price: Math.max(0, Number(e.target.value)) })}
                  className="w-32 rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
              </div>
            </div>
          </div>
          <NavButtons
            onBack={() => setStep("group_file")}
            onNext={() => {
              if (!data.valid_till) { setError("Set a validity date"); return; }
              setError(""); setStep("summary");
            }}
          />
        </>
      );
    }

    if (step === "summary") {
      const rows: [string, string][] = [
        ["Name", data.name],
        ["Bot", `@${data.bot_username}`],
        ["Sessions", String(data.sessions_count)],
        ["Cycle / Gap", `${data.cycle}s / ${data.gap}s`],
        ["Mode", data.mode.charAt(0).toUpperCase() + data.mode.slice(1)],
        ["Group File", data.group_file || "—"],
        ["Valid Until", data.valid_till],
        ["Renewal", data.renewal_price > 0 ? `$${data.renewal_price}` : "—"],
        ["Health check", data.skip_health_check ? "Skipped" : "Enabled"],
        ["Chatlist auto-join", data.skip_chatlist_join ? "Skipped" : "Enabled"],
      ];
      return (
        <>
          <StepHeader title="Review & Create" subtitle="Confirm all details before proceeding" />
          <div className="rounded-xl border border-dark-700 bg-dark-800/50 divide-y divide-dark-700/50">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-dark-400">{k}</span>
                <span className="text-sm text-dark-100 font-medium truncate ml-4 text-right">{v}</span>
              </div>
            ))}
          </div>
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
          <NavButtons
            onBack={() => setStep("validity")}
            onNext={submitCreation}
            nextLabel="Create Bot"
          />
        </>
      );
    }

    if (step === "creating" || step === "success" || step === "failed") {
      return (
        <div className="space-y-4">
          <StepHeader title={step === "creating" ? "Creating Bot..." : step === "success" ? "Created!" : "Failed"} />
          <div className="rounded-lg bg-dark-950 border border-dark-700 p-3 max-h-64 overflow-y-auto font-mono text-xs space-y-1.5">
            {progressLines.map((line, i) => {
              const isIssue = /invalid|missing|not enough|restrict|cannot|failed|skip/i.test(line.message);
              const isLast = i === progressLines.length - 1;
              return (
                <div key={i} className="flex items-start gap-2 animate-fade-in">
                  {isLast && step === "creating" ? (
                    <Loader2 className="h-3.5 w-3.5 text-accent animate-spin shrink-0 mt-0.5" />
                  ) : isIssue ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                  )}
                  <span className={`break-all ${isIssue ? "text-warning" : "text-dark-300"}`}>{line.message}</span>
                </div>
              );
            })}
            <div ref={progressEndRef} />
          </div>
          {step === "success" && (
            <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-4 flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-green-400 shrink-0" />
              <p className="text-sm font-medium text-green-300">{resultMsg || "Bot created successfully"}</p>
            </div>
          )}
          {step === "failed" && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-4 flex items-center gap-3">
              <XCircle className="h-5 w-5 text-red-400 shrink-0" />
              <p className="text-sm font-medium text-red-300">{resultMsg || "Creation failed"}</p>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            {step === "creating" && (
              <p className="text-xs text-dark-500 flex items-center gap-2 mr-auto">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Please wait...
              </p>
            )}
            {(step === "success" || step === "failed") && (
              <Button onClick={onCreated} size="sm">{step === "success" ? "Done" : "Close"}</Button>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <Modal open={open} onClose={canClose ? onClose : () => {}} title="Create New Bot" size="lg">
      {renderStep()}
    </Modal>
  );
}
