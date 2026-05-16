"use client";
import { usePortalBot, usePortalOrders } from "@/lib/hooks/usePortal";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { CreditCard, Calendar, Tag } from "lucide-react";
import { formatDate, formatDateTime, formatUSD } from "@/lib/utils";

export default function UserBillingPage() {
  const { data: bot, isLoading } = usePortalBot();
  const { data: ordersData } = usePortalOrders();

  if (isLoading) return <PageSkeleton />;
  if (!bot) return <div className="text-center py-20 text-dark-400">Bot not found</div>;

  const orders = ordersData?.orders || [];
  const plan = bot.plan || {};

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">
      <h1 className="text-xl sm:text-2xl font-bold text-dark-100">Billing</h1>

      {/* Current Plan */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <Card>
          <CardHeader><CardTitle>Current Plan</CardTitle></CardHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-3 mb-3 sm:mb-4">
              <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-accent/10 shrink-0">
                <Tag className="h-5 w-5 sm:h-6 sm:w-6 text-accent" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-dark-100 truncate">{bot.plan_name || "Custom Plan"}</h3>
                <p className="text-xs sm:text-sm text-dark-400">{bot.mode} mode</p>
              </div>
            </div>
            <div className="space-y-2 text-sm">
              {([
                ["Sessions", plan.sessions || bot.sessions_count],
                ["Cycle", `${plan.cycle || bot.cycle}s`],
                ["Gap", `${plan.gap || bot.gap}s`],
              ] as [string, any][]).map(([k, v]) => (
                <div key={k} className="flex justify-between py-1.5 border-b border-dark-800 last:border-0">
                  <span className="text-dark-400">{k}</span>
                  <span className="text-dark-200 font-medium">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>Subscription</CardTitle></CardHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 sm:p-4 rounded-lg bg-dark-800/50 border border-dark-700">
              <Calendar className="h-5 w-5 text-accent shrink-0" />
              <div className="min-w-0">
                <p className="text-xs sm:text-sm text-dark-300">Valid Until</p>
                <p className="text-base sm:text-lg font-bold text-dark-100 truncate">{formatDate(bot.valid_till) || "—"}</p>
              </div>
            </div>
            <a
              href="/user/settings"
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
            >
              <CreditCard className="h-3.5 w-3.5" />
              Extend plan in Settings
            </a>
          </div>
        </Card>
      </div>

      {/* Order History */}
      <Card>
        <CardHeader><CardTitle>Order History ({orders.length})</CardTitle></CardHeader>
        {orders.length === 0 ? (
          <div className="text-center py-6 sm:py-8">
            <CreditCard className="h-7 w-7 sm:h-8 sm:w-8 mx-auto text-dark-600 mb-2" />
            <p className="text-sm text-dark-500">No orders found</p>
          </div>
        ) : (
          <div className="space-y-3 sm:hidden">
            {orders.map((order: any) => (
              <div key={order.order_id} className="rounded-lg bg-dark-800/50 border border-dark-700/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-dark-400">{order.order_id?.slice(0, 8)}…</span>
                  <Badge status={order.status} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-dark-200">{order.plan_name || order.order_type}</span>
                  <span className="text-sm font-medium text-dark-100">
                    {order.amount_usd ? formatUSD(order.amount_usd) : "—"}
                  </span>
                </div>
                <div className="text-xs text-dark-500">
                  {formatDateTime(order.created_at)}
                  {order.paid_at && <span> · Paid {formatDateTime(order.paid_at)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {orders.length > 0 && (
          <div className="hidden sm:block overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-dark-700">
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Order ID</th>
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Type</th>
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Plan</th>
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Amount</th>
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Status</th>
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Created</th>
                  <th className="text-left py-2 px-3 text-dark-400 font-medium text-xs whitespace-nowrap">Paid</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order: any) => (
                  <tr key={order.order_id} className="border-b border-dark-800/50">
                    <td className="py-2 px-3 font-mono text-xs text-dark-300">{order.order_id?.slice(0, 8)}…</td>
                    <td className="py-2 px-3 text-dark-300">{order.order_type}</td>
                    <td className="py-2 px-3 text-dark-300">{order.plan_name || "—"}</td>
                    <td className="py-2 px-3 font-medium text-dark-200">
                      {order.amount_usd ? formatUSD(order.amount_usd) : "—"}
                      {order.pay_currency && <span className="text-dark-500 text-xs ml-1">({order.pay_currency})</span>}
                    </td>
                    <td className="py-2 px-3"><Badge status={order.status} /></td>
                    <td className="py-2 px-3 text-xs text-dark-400">{formatDateTime(order.created_at)}</td>
                    <td className="py-2 px-3 text-xs text-dark-400">{order.paid_at ? formatDateTime(order.paid_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
