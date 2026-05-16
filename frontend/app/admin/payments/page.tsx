"use client";
import { useState } from "react";
import { useOrders, usePendingOrders } from "@/lib/hooks/usePayments";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import ConfirmModal from "@/components/ConfirmModal";
import StatCard from "@/components/StatCard";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { DollarSign, Clock, CheckCircle, Search, Ban, CreditCard, RotateCw } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDateTime, formatUSD, truncate } from "@/lib/utils";

export default function PaymentsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, mutate } = useOrders(statusFilter, page);
  const { data: pending } = usePendingOrders();
  const [markPaidTarget, setMarkPaidTarget] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const orders = (data?.items || []).filter(
    (o) => !search || o.order_id.includes(search) || String(o.user_id).includes(search)
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

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard title="Pending Orders" value={pending?.total || 0} icon={Clock} color="text-warning" />
        <StatCard title="Total Orders" value={data?.total || 0} icon={CreditCard} color="text-accent" />
        <StatCard title="This Page" value={orders.length} icon={CheckCircle} color="text-success" />
      </div>

      {/* Toolbar */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
          <input
            className="w-full rounded-lg border border-dark-600 bg-dark-800 pl-9 pr-3 py-2 text-sm text-dark-100 placeholder:text-dark-500 focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder="Search by order ID or user ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-dark-800 p-0.5 overflow-x-auto">
          {["", "pending", "waiting_payment", "confirming", "completed", "cancelled", "expired"].map((s) => (
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
        <TableSkeleton rows={8} cols={7} />
      ) : (
        <>
          <Table>
            <Thead>
              <tr>
                <Th>Order ID</Th>
                <Th>User</Th>
                <Th>Plan</Th>
                <Th>Amount</Th>
                <Th>Currency</Th>
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
                  <Tr key={o.order_id}>
                    <Td className="font-mono text-xs">{truncate(o.order_id, 12)}</Td>
                    <Td>{o.user_id || "—"}</Td>
                    <Td>{o.plan_name || "—"}</Td>
                    <Td className="font-medium">{formatUSD(o.amount_usd)}</Td>
                    <Td>{o.pay_currency || "—"}</Td>
                    <Td><Badge status={o.status} /></Td>
                    <Td className="text-xs">{formatDateTime(o.created_at)}</Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1">
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
