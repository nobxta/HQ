"use client";
import { useState, useEffect } from "react";
import { useOrders, usePendingOrders } from "@/lib/hooks/usePayments";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { CheckCircle, Search, Ban, RotateCw, Copy, Check, Hammer, AlertTriangle, Square, CheckSquare } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDateTime, formatUSD, truncate } from "@/lib/utils";

interface OrderRow {
  order_id: string; user_id?: number | string; status: string; source?: string;
  order_type?: string;
  plan_name?: string; plan_mode?: string; mode?: string; duration_days?: number;
  amount_usd?: number; base_amount_usd?: number; coupon?: string; coupon_type?: string; coupon_value?: number;
  payment_id?: string; pay_currency?: string; pay_amount?: string | number; amount_received?: number;
  pay_address?: string; network?: string; tx_hash?: string; invoice_expires_at?: string;
  ref_name?: string; ref_email?: string; ref_username?: string;
  bot_name?: string; web_token?: string; creation_step?: string; queued?: boolean;
  created_at?: string; paid_at?: string; bot_username?: string;
  is_temppay?: boolean; is_replacement?: boolean; real_name?: string; session_file?: string;
  job_id?: string; replacement_count?: number; session_names?: string[];
}

// Payment kind â†’ label, accent color and how to describe the purchased item. Every payment
// (new AdBot purchase, renewal/extension, session replacement) is classified here so the table
// is not hard-wired to "AdBot plan" any more.
function paymentKind(o: OrderRow): { key: string; label: string; cls: string } {
  const t = (o.order_type || "purchase").toLowerCase();
  if (o.is_replacement || t === "replacement")
    return { key: "replacement", label: "Replacement", cls: "bg-purple-500/15 text-purple-300 border-purple-500/30" };
  if (t === "renewal")
    return { key: "renewal", label: "Renewal", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
  return { key: "purchase", label: "New AdBot", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
}

// What the money bought â€” shown in the "Item" column, type-aware.
function itemLabel(o: OrderRow): string {
  const kind = paymentKind(o).key;
  if (kind === "replacement") {
    const count = o.replacement_count || o.session_names?.length || 1;
    const names = o.session_names?.length ? o.session_names.join(", ") : o.real_name;
    return names ? `${count} session${count === 1 ? "" : "s"} Â· ${names}` : "Session replacement";
  }
  if (kind === "renewal") {
    const dur = o.duration_days ? `${o.duration_days}d` : "";
    return [`Renewal`, o.bot_name, dur].filter(Boolean).join(" Â· ");
  }
  const plan = o.plan_name || "AdBot";
  return o.plan_mode ? `${plan} (${o.plan_mode})` : plan;
}

function Row({ label, value, mono = false }: { label: string; value: any; mono?: boolean }) {
  if (value === undefined || value === null || value === "" || value === 0) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-[12px] text-dark-500 flex-shrink-0">{label}</span>
      <span className={`text-[12px] text-dark-100 text-right break-all ${mono ? "font-mono" : ""}`}>{String(value)}</span>
    </div>
  );
}

export default function PaymentsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, mutate } = useOrders(statusFilter, page, typeFilter);
  const { data: pending } = usePendingOrders();
  const [markPaidTarget, setMarkPaidTarget] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [detail, setDetail] = useState<OrderRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [recreateTarget, setRecreateTarget] = useState<OrderRow | null>(null);
  const [recreateSkipHealth, setRecreateSkipHealth] = useState(false);
  const [recreateSkipChatlist, setRecreateSkipChatlist] = useState(false);
  const [stats, setStats] = useState<{ total: number; revenue_usd: number; completed: number; pending: number; expired: number } | null>(null);

  useEffect(() => {
    api.get("/api/orders/stats").then((r) => setStats(r.data)).catch(() => {});
  }, [data]);

  const orders: OrderRow[] = ((data?.items || []) as OrderRow[]).filter(
    (o) => !search || o.order_id.includes(search) || String(o.user_id || "").includes(search) || (o.payment_id || "").includes(search)
  );

  // An order can be rebuilt when it's stuck waiting for stock: pending_creation
  // (low sessions / bad token), or a web order that's paid+queued (no token yet).
  const canRecreate = (o: OrderRow) =>
    o.status === "pending_creation" || (o.source === "web" && o.status === "paid" && !!o.queued);

  // Rows that aren't real orders.json entries: live Shop Bot invoices and replacement-queue
  // rows. Order actions (sync/mark-paid/cancel/recreate) don't apply to them.
  const isReadOnly = (o: OrderRow) => !!o.is_temppay || !!o.is_replacement;

  const doAction = async (orderId: string, action: "mark-paid" | "cancel" | "recreate", body?: any) => {
    setActionLoading(true);
    try {
      await api.post(`/api/orders/${orderId}/${action}`, body);
      toast.success(`Order ${orderId} â€” ${action}`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `Failed: ${action}`);
    }
    setActionLoading(false);
  };

  const openRecreate = (o: OrderRow) => {
    setRecreateSkipHealth(false);
    setRecreateSkipChatlist(false);
    setRecreateTarget(o);
  };

  const confirmRecreate = async () => {
    if (!recreateTarget) return;
    await doAction(recreateTarget.order_id, "recreate", {
      skip_health_check: recreateSkipHealth,
      skip_chatlist_join: recreateSkipChatlist,
    });
    setRecreateTarget(null);
    setDetail(null);
  };

  const syncOrder = async (orderId: string) => {
    setSyncing(true);
    try {
      const { data: r } = await api.post(`/api/orders/${orderId}/sync`);
      if (r.synced) {
        toast.success(`Synced â€” provider says: ${r.provider_status || "?"}${r.confirmed ? " (confirmed)" : ""}`);
        if (r.order) setDetail(r.order);
      } else {
        toast(r.reason || "Nothing to sync");
      }
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Sync failed");
    }
    setSyncing(false);
  };

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const cryptoAmount = (o: OrderRow) =>
    o.pay_amount ? `${o.pay_amount} ${(o.pay_currency || "").toUpperCase()}` : "â€”";

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Compact metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Revenue", value: formatUSD(stats?.revenue_usd || 0), sub: `${stats?.completed || 0} completed`, color: "text-success" },
          { label: "Pending", value: stats?.pending ?? (pending?.total || 0), sub: "awaiting / building", color: "text-warning" },
          { label: "Expired", value: stats?.expired || 0, sub: "expired / cancelled", color: "text-danger" },
          { label: "Total Orders", value: stats?.total ?? (data?.total || 0), sub: `${orders.length} on this page`, color: "text-accent" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-dark-850 px-4 py-3">
            <p className="text-[11px] text-dark-500 uppercase tracking-wider">{c.label}</p>
            <p className={`text-xl font-bold mt-0.5 ${c.color}`}>{c.value}</p>
            <p className="text-[10px] text-dark-600 mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Status breakdown bar */}
      {stats && stats.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex h-1.5 rounded-full overflow-hidden bg-dark-800">
            <div className="bg-success" style={{ width: `${(stats.completed / stats.total) * 100}%` }} />
            <div className="bg-warning" style={{ width: `${(stats.pending / stats.total) * 100}%` }} />
            <div className="bg-danger" style={{ width: `${(stats.expired / stats.total) * 100}%` }} />
          </div>
          <div className="flex items-center gap-4 text-[10px] text-dark-500">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-success" /> Completed {stats.completed}</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-warning" /> Pending {stats.pending}</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-danger" /> Expired {stats.expired}</span>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
          <input
            className="w-full rounded-lg border border-dark-600 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder="Search by order ID, user ID, or payment IDâ€¦"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-dark-800 p-0.5 overflow-x-auto">
          {["", "pending", "payment_waiting", "confirming", "paid", "pending_creation", "completed", "cancelled", "expired"].map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`px-3 py-1.5 text-xs rounded-md transition-all whitespace-nowrap ${
                statusFilter === s ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"
              }`}
            >
              {s || "All"}
            </button>
          ))}
        </div>
        {/* Payment-type filter â€” separates new AdBot purchases, renewals, and session replacements. */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-dark-500 uppercase tracking-wider shrink-0">Type</span>
          <div className="flex gap-1 rounded-lg bg-dark-800 p-0.5 overflow-x-auto">
            {[
              { v: "", label: "All types" },
              { v: "purchase", label: "New AdBot" },
              { v: "renewal", label: "Renewal" },
              { v: "replacement", label: "Replacement" },
            ].map((t) => (
              <button
                key={t.v}
                onClick={() => { setTypeFilter(t.v); setPage(1); }}
                className={`px-3 py-1.5 text-xs rounded-md transition-all whitespace-nowrap ${
                  typeFilter === t.v ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={8} />
      ) : (
        <>
          <Table>
            <Thead>
              <tr>
                <Th>Order ID</Th>
                <Th>Type</Th>
                <Th>Item</Th>
                <Th>USD</Th>
                <Th>Crypto</Th>
                <Th>Status</Th>
                <Th>Date</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </Thead>
            <Tbody>
              {orders.length === 0 ? (
                <Tr><Td className="text-center py-8 text-dark-500" colSpan={8}>No orders found</Td></Tr>
              ) : (
                orders.map((o) => {
                  const kind = paymentKind(o);
                  return (
                  <Tr key={o.order_id} className="cursor-pointer hover:bg-dark-800/40" onClick={() => setDetail(o)}>
                    <Td className="font-mono text-xs text-accent">{truncate(o.order_id, 12)}</Td>
                    <Td>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${kind.cls}`}>
                        {kind.label}
                      </span>
                    </Td>
                    <Td className="text-xs text-dark-200"><span className="block max-w-[200px] truncate" title={itemLabel(o)}>{itemLabel(o)}</span></Td>
                    <Td className="font-medium">{formatUSD(o.amount_usd)}</Td>
                    <Td className="text-xs">{cryptoAmount(o)}</Td>
                    <Td><Badge status={o.status} /></Td>
                    <Td className="text-xs">{formatDateTime(o.created_at || "")}</Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        {o.is_temppay ? (
                          <span className="text-[10px] text-dark-500 whitespace-nowrap" title="Live Shop Bot invoice â€” becomes an order once payment confirms">
                            Bot invoice
                          </span>
                        ) : o.is_replacement ? (
                          <span className="text-[10px] text-dark-500 whitespace-nowrap" title="Session-replacement payment â€” managed from the AdBot's replacements, not here">
                            Replacement
                          </span>
                        ) : (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => syncOrder(o.order_id)} title="Sync from NOWPayments">
                              <RotateCw className="h-3.5 w-3.5 text-accent" />
                            </Button>
                            {canRecreate(o) && (
                              <Button variant="ghost" size="sm" onClick={() => openRecreate(o)} title="Recreate bot">
                                <Hammer className="h-3.5 w-3.5 text-warning" />
                              </Button>
                            )}
                            {!["completed", "cancelled"].includes(o.status) && (
                              <>
                                <Button variant="ghost" size="sm" onClick={() => setMarkPaidTarget(o.order_id)} title="Mark Paid">
                                  <CheckCircle className="h-3.5 w-3.5 text-success" />
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setCancelTarget(o.order_id)} title="Cancel">
                                  <Ban className="h-3.5 w-3.5 text-danger" />
                                </Button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </Td>
                  </Tr>
                  );
                })
              )}
            </Tbody>
          </Table>
          {(data?.pages || 1) > 1 && (
            <div className="flex justify-center gap-2">
              {Array.from({ length: data!.pages }, (_, i) => i + 1).map((p) => (
                <button key={p} onClick={() => setPage(p)}
                  className={`px-3 py-1 rounded text-sm ${p === page ? "bg-accent text-white" : "text-dark-400 hover:text-dark-200"}`}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Detail panel â€” NOWPayments style */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Payment details" size="md">
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${paymentKind(detail).cls}`}>
                  {paymentKind(detail).label}
                </span>
                <Badge status={detail.status} />
              </div>
              {detail.is_temppay ? (
                <span className="text-[11px] text-dark-500">Live Shop Bot invoice</span>
              ) : detail.is_replacement ? (
                <span className="text-[11px] text-dark-500">Session replacement</span>
              ) : (
                <Button variant="secondary" size="sm" loading={syncing} onClick={() => syncOrder(detail.order_id)}>
                  <RotateCw className="h-3.5 w-3.5" /> Sync now
                </Button>
              )}
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-dark-900/50 px-4 py-2 divide-y divide-white/[0.04]">
              <Row label="Order ID" value={detail.order_id} mono />
              <Row label="Payment ID" value={detail.payment_id} mono />
              <Row label="Type" value={paymentKind(detail).label} />
              <Row label="Source" value={detail.source} />
              {detail.is_replacement ? (
                <>
                  <Row label="Item" value={`${detail.replacement_count || detail.session_names?.length || 1} session replacement${(detail.replacement_count || detail.session_names?.length || 1) === 1 ? "" : "s"}`} />
                  <Row label="AdBot" value={detail.bot_name} />
                  <Row label={(detail.replacement_count || detail.session_names?.length || 1) === 1 ? "Session" : "Sessions"} value={detail.session_names?.length ? detail.session_names.join(", ") : (detail.real_name || detail.session_file)} />
                </>
              ) : (
                <>
                  {paymentKind(detail).key === "renewal" && <Row label="AdBot" value={detail.bot_name} />}
                  <Row label="Plan" value={`${detail.plan_name || ""}${detail.plan_mode ? ` (${detail.plan_mode})` : ""}`} />
                  <Row label="Duration" value={detail.duration_days ? `${detail.duration_days} days` : ""} />
                </>
              )}
              <Row label="Original price" value={detail.amount_usd != null ? `${formatUSD(detail.amount_usd)} USD` : ""} />
              {detail.coupon ? <Row label="Coupon" value={`${detail.coupon} (${detail.coupon_type === "fixed" ? `-${formatUSD(detail.coupon_value)}` : `-${detail.coupon_value}%`})`} /> : null}
              <Row label="Pay price" value={detail.pay_amount ? `${detail.pay_amount} ${(detail.pay_currency || "").toUpperCase()}` : ""} />
              <Row label="Actually paid" value={`${detail.amount_received || 0} ${(detail.pay_currency || "").toUpperCase()}`} />
              <Row label="Network" value={detail.network} />
            </div>

            {(detail.pay_address || detail.tx_hash) && (
              <div className="rounded-xl border border-white/[0.06] bg-dark-900/50 px-4 py-2 divide-y divide-white/[0.04]">
                {detail.pay_address && (
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-[12px] text-dark-500">Payin address</span>
                    <button onClick={() => copy(detail.pay_address!, "addr")} className="flex items-center gap-1.5 text-[11px] font-mono text-emerald-400 break-all text-right hover:text-emerald-300">
                      {truncate(detail.pay_address, 28)} {copied === "addr" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </div>
                )}
                <Row label="Tx hash" value={detail.tx_hash} mono />
              </div>
            )}

            {(detail.ref_name || detail.ref_email || detail.ref_username || detail.bot_name || detail.web_token) && (
              <div className="rounded-xl border border-white/[0.06] bg-dark-900/50 px-4 py-2 divide-y divide-white/[0.04]">
                <Row label="Reference name" value={detail.ref_name} />
                <Row label="Email" value={detail.ref_email} />
                <Row label="Telegram" value={detail.ref_username} />
                <Row label="Bot name" value={detail.bot_name} />
                <Row label="Bot username" value={detail.bot_username ? `@${detail.bot_username}` : ""} />
                {detail.web_token && (
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-[12px] text-dark-500">Access code</span>
                    <button onClick={() => copy(detail.web_token!, "tok")} className="flex items-center gap-1.5 text-[12px] font-mono text-accent hover:text-accent/80">
                      {detail.web_token} {copied === "tok" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </div>
                )}
                {!canRecreate(detail) && <Row label="Build step" value={detail.creation_step} />}
              </div>
            )}

            {canRecreate(detail) && detail.creation_step && (
              <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div>
                  <p className="text-[11px] font-medium text-warning uppercase tracking-wider">Stuck in queue</p>
                  <p className="text-xs text-dark-200 mt-0.5 break-words">{detail.creation_step}</p>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-white/[0.06] bg-dark-900/50 px-4 py-2 divide-y divide-white/[0.04]">
              <Row label="Created at" value={detail.created_at ? formatDateTime(detail.created_at) : ""} />
              <Row label="Paid at" value={detail.paid_at ? formatDateTime(detail.paid_at) : ""} />
              <Row label="Invoice expires" value={detail.invoice_expires_at ? formatDateTime(detail.invoice_expires_at) : ""} />
            </div>

            {detail.is_temppay ? (
              <p className="text-[11px] text-dark-500 text-center pt-1">
                This is a live Shop Bot invoice. It becomes a manageable order once the buyer pays, or moves to Expired if the window closes.
              </p>
            ) : detail.is_replacement ? (
              <p className="text-[11px] text-dark-500 text-center pt-1">
                This is a session-replacement payment. It's processed automatically on confirmation and managed from the AdBot's replacements â€” no order actions here.
              </p>
            ) : (
              <>
                {canRecreate(detail) && (
                  <Button variant="secondary" size="sm" className="w-full" onClick={() => openRecreate(detail)}>
                    <Hammer className="h-3.5 w-3.5 text-warning" /> Recreate bot (keeps access code)
                  </Button>
                )}

                {!["completed", "cancelled"].includes(detail.status) && (
                  <div className="flex gap-2 pt-1">
                    <Button variant="primary" size="sm" className="flex-1" onClick={() => { setMarkPaidTarget(detail.order_id); }}>
                      <CheckCircle className="h-3.5 w-3.5" /> Mark paid
                    </Button>
                    <Button variant="ghost" size="sm" className="flex-1" onClick={() => { setCancelTarget(detail.order_id); }}>
                      <Ban className="h-3.5 w-3.5 text-danger" /> Cancel
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!markPaidTarget}
        onClose={() => setMarkPaidTarget(null)}
        onConfirm={async () => { if (markPaidTarget) await doAction(markPaidTarget, "mark-paid"); setMarkPaidTarget(null); }}
        title="Mark as Paid"
        message={`Manually mark order "${markPaidTarget}" as paid? This will trigger bot creation.`}
        confirmText="Mark Paid"
        variant="primary"
        loading={actionLoading}
      />
      <ConfirmModal
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={async () => { if (cancelTarget) await doAction(cancelTarget, "cancel"); setCancelTarget(null); }}
        title="Cancel Order"
        message={`Cancel order "${cancelTarget}"? This cannot be undone.`}
        confirmText="Cancel Order"
        loading={actionLoading}
      />

      {/* Recreate modal â€” pick which steps to skip */}
      <Modal open={!!recreateTarget} onClose={() => setRecreateTarget(null)} title="Recreate Bot" size="sm">
        {recreateTarget && (
          <div className="space-y-4">
            <p className="text-xs text-dark-400">
              Rebuild the bot for order <span className="font-mono text-dark-200">{truncate(recreateTarget.order_id, 16)}</span>.
              {recreateTarget.creation_step && (
                <span className="block mt-2 rounded-lg bg-warning/10 border border-warning/20 px-2.5 py-2 text-[11px] text-warning">
                  {recreateTarget.creation_step}
                </span>
              )}
            </p>
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-dark-500 uppercase tracking-wider">Skip steps</p>
              <button type="button" onClick={() => setRecreateSkipHealth((v) => !v)}
                className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  recreateSkipHealth ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"
                }`}
              >
                {recreateSkipHealth ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" /> : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />}
                <span>
                  <span className={`block text-xs font-medium ${recreateSkipHealth ? "text-warning" : "text-dark-300"}`}>Skip session health check</span>
                  <span className="block text-[11px] text-dark-500 mt-0.5">Use sessions even if they'd normally fail validation (lets bad/dead sessions through).</span>
                </span>
              </button>
              <button type="button" onClick={() => setRecreateSkipChatlist((v) => !v)}
                className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  recreateSkipChatlist ? "border-warning/40 bg-warning/5" : "border-dark-700 bg-dark-800 hover:border-dark-600"
                }`}
              >
                {recreateSkipChatlist ? <CheckSquare className="h-4 w-4 text-warning shrink-0 mt-0.5" /> : <Square className="h-4 w-4 text-dark-500 shrink-0 mt-0.5" />}
                <span>
                  <span className={`block text-xs font-medium ${recreateSkipChatlist ? "text-warning" : "text-dark-300"}`}>Skip default chatlist auto-join</span>
                  <span className="block text-[11px] text-dark-500 mt-0.5">Don't auto-join assigned sessions to the mode's default chatlist folders.</span>
                </span>
              </button>
            </div>
            <div className="flex gap-2 pt-1">
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setRecreateTarget(null)}>Cancel</Button>
              <Button variant="primary" size="sm" className="flex-1" loading={actionLoading} onClick={confirmRecreate}>
                <Hammer className="h-3.5 w-3.5" /> Recreate
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

