"use client";
import { useState, useEffect } from "react";
import { useOrders, usePendingOrders } from "@/lib/hooks/usePayments";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { CheckCircle, Search, Ban, RotateCw, Copy, Check } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDateTime, formatUSD, truncate } from "@/lib/utils";

interface OrderRow {
  order_id: string; user_id?: number | string; status: string; source?: string;
  plan_name?: string; plan_mode?: string; mode?: string; duration_days?: number;
  amount_usd?: number; base_amount_usd?: number; coupon?: string; coupon_percent?: number;
  payment_id?: string; pay_currency?: string; pay_amount?: string | number; amount_received?: number;
  pay_address?: string; network?: string; tx_hash?: string; invoice_expires_at?: string;
  ref_name?: string; ref_email?: string; ref_username?: string;
  bot_name?: string; web_token?: string; creation_step?: string; queued?: boolean;
  created_at?: string; paid_at?: string; bot_username?: string;
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
  const [page, setPage] = useState(1);
  const { data, isLoading, mutate } = useOrders(statusFilter, page);
  const { data: pending } = usePendingOrders();
  const [markPaidTarget, setMarkPaidTarget] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [detail, setDetail] = useState<OrderRow | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total: number; revenue_usd: number; completed: number; pending: number; expired: number } | null>(null);

  useEffect(() => {
    api.get("/api/orders/stats").then((r) => setStats(r.data)).catch(() => {});
  }, [data]);

  const orders: OrderRow[] = ((data?.items || []) as OrderRow[]).filter(
    (o) => !search || o.order_id.includes(search) || String(o.user_id || "").includes(search) || (o.payment_id || "").includes(search)
  );

  const doAction = async (orderId: string, action: "mark-paid" | "cancel") => {
    setActionLoading(true);
    try {
      await api.post(`/api/orders/${orderId}/${action}`);
      toast.success(`Order ${orderId} — ${action}`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `Failed: ${action}`);
    }
    setActionLoading(false);
  };

  const syncOrder = async (orderId: string) => {
    setSyncing(true);
    try {
      const { data: r } = await api.post(`/api/orders/${orderId}/sync`);
      if (r.synced) {
        toast.success(`Synced — provider says: ${r.provider_status || "?"}${r.confirmed ? " (confirmed)" : ""}`);
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
    o.pay_amount ? `${o.pay_amount} ${(o.pay_currency || "").toUpperCase()}` : "—";

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
            placeholder="Search by order ID, user ID, or payment ID…"
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
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={8} />
      ) : (
        <>
          <Table>
            <Thead>
              <tr>
                <Th>Order ID</Th>
                <Th>Payment ID</Th>
                <Th>Plan</Th>
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
                orders.map((o) => (
                  <Tr key={o.order_id} className="cursor-pointer hover:bg-dark-800/40" onClick={() => setDetail(o)}>
                    <Td className="font-mono text-xs text-accent">{truncate(o.order_id, 12)}</Td>
                    <Td className="font-mono text-xs">{o.payment_id ? truncate(String(o.payment_id), 12) : "—"}</Td>
                    <Td>{o.plan_name || "—"}</Td>
                    <Td className="font-medium">{formatUSD(o.amount_usd)}</Td>
                    <Td className="text-xs">{cryptoAmount(o)}</Td>
                    <Td><Badge status={o.status} /></Td>
                    <Td className="text-xs">{formatDateTime(o.created_at || "")}</Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" onClick={() => syncOrder(o.order_id)} title="Sync from NOWPayments">
                          <RotateCw className="h-3.5 w-3.5 text-accent" />
                        </Button>
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
                      </div>
                    </Td>
                  </Tr>
                ))
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

      {/* Detail panel — NOWPayments style */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Payment details" size="md">
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Badge status={detail.status} />
              <Button variant="secondary" size="sm" loading={syncing} onClick={() => syncOrder(detail.order_id)}>
                <RotateCw className="h-3.5 w-3.5" /> Sync now
              </Button>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-dark-900/50 px-4 py-2 divide-y divide-white/[0.04]">
              <Row label="Order ID" value={detail.order_id} mono />
              <Row label="Payment ID" value={detail.payment_id} mono />
              <Row label="Source" value={detail.source} />
              <Row label="Plan" value={`${detail.plan_name || ""}${detail.plan_mode ? ` (${detail.plan_mode})` : ""}`} />
              <Row label="Duration" value={detail.duration_days ? `${detail.duration_days} days` : ""} />
              <Row label="Original price" value={detail.amount_usd != null ? `${formatUSD(detail.amount_usd)} USD` : ""} />
              {detail.coupon ? <Row label="Coupon" value={`${detail.coupon} (-${detail.coupon_percent}%)`} /> : null}
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
                <Row label="Build step" value={detail.creation_step} />
              </div>
            )}

            <div className="rounded-xl border border-white/[0.06] bg-dark-900/50 px-4 py-2 divide-y divide-white/[0.04]">
              <Row label="Created at" value={detail.created_at ? formatDateTime(detail.created_at) : ""} />
              <Row label="Paid at" value={detail.paid_at ? formatDateTime(detail.paid_at) : ""} />
              <Row label="Invoice expires" value={detail.invoice_expires_at ? formatDateTime(detail.invoice_expires_at) : ""} />
            </div>

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
    </div>
  );
}
