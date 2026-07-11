"use client";
import { useState } from "react";
import { useCoupons, CouponData } from "@/lib/hooks/useCoupons";
import { usePlans } from "@/lib/hooks/usePlans";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { Ticket, Plus, Edit, Trash2, Save } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { useForm } from "react-hook-form";
import { formatUSD, formatDate } from "@/lib/utils";

const EMPTY_FORM = {
  type: "percent" as "percent" | "fixed",
  value: 0,
  active: true,
  starts_at: "",
  expires_at: "",
  max_redemptions: "",
  max_per_user: "",
  min_order_usd: "",
  max_order_usd: "",
  billing: "both" as "week" | "month" | "both",
  applies_to: [] as string[],
  note: "",
};

function discountLabel(c: Pick<CouponData, "type" | "value">): string {
  return c.type === "fixed" ? `-${formatUSD(c.value)}` : `-${c.value}%`;
}

export default function CouponsPage() {
  const { data, isLoading, mutate } = useCoupons();
  const { data: plansData } = usePlans();
  const [editCode, setEditCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteCode, setDeleteCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const coupons = data || {};
  const codes = Object.keys(coupons);
  const allPlanIds = Object.values(plansData || {}).flat().map((p: any) => p.id as string);

  const handleDelete = async () => {
    if (!deleteCode) return;
    setBusy(true);
    try {
      await api.delete(`/api/system/coupons/${deleteCode}`);
      toast.success("Coupon deleted");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to delete coupon");
    }
    setBusy(false);
    setDeleteCode(null);
  };

  const handleToggleActive = async (code: string, coupon: CouponData) => {
    try {
      await api.put(`/api/system/coupons/${code}`, { ...coupon, active: !coupon.active });
      toast.success(coupon.active ? "Coupon disabled" : "Coupon enabled");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to update coupon");
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-dark-100">Coupons</h2>
          <p className="text-sm text-dark-400 mt-1">{codes.length} coupon{codes.length !== 1 ? "s" : ""} configured</p>
        </div>
        <Button size="sm" onClick={() => { setCreating(true); setEditCode(null); }}>
          <Plus className="h-3.5 w-3.5" /> New Coupon
        </Button>
      </div>

      {isLoading ? (
        <TableSkeleton />
      ) : codes.length === 0 ? (
        <Card className="text-center py-12">
          <Ticket className="h-10 w-10 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-400">No coupons yet</p>
        </Card>
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Code</Th>
              <Th>Discount</Th>
              <Th>Uses</Th>
              <Th>Scope</Th>
              <Th>Window</Th>
              <Th>Active</Th>
              <Th></Th>
            </Tr>
          </Thead>
          <Tbody>
            {codes.map((code) => {
              const c = coupons[code];
              return (
                <Tr key={code}>
                  <Td className="font-mono font-semibold text-dark-100">{code}</Td>
                  <Td>{discountLabel(c)}</Td>
                  <Td>
                    {c.redeemed_count}{c.max_redemptions != null ? ` / ${c.max_redemptions}` : ""}
                    {c.max_per_user != null && <span className="text-dark-500"> · {c.max_per_user}/user</span>}
                  </Td>
                  <Td className="text-xs text-dark-400">
                    {c.applies_to.length ? c.applies_to.join(", ") : "All plans"}
                    {c.billing !== "both" && <span> · {c.billing}ly</span>}
                  </Td>
                  <Td className="text-xs text-dark-400">
                    {c.starts_at ? formatDate(c.starts_at) : "—"} → {c.expires_at ? formatDate(c.expires_at) : "No expiry"}
                  </Td>
                  <Td>
                    <button
                      onClick={() => handleToggleActive(code, c)}
                      className={`text-xs px-2 py-1 rounded-full font-medium ${c.active ? "bg-success/10 text-success" : "bg-dark-700 text-dark-400"}`}
                    >
                      {c.active ? "Active" : "Disabled"}
                    </button>
                  </Td>
                  <Td>
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => { setEditCode(code); setCreating(false); }} className="p-1.5 rounded-md hover:bg-dark-700 text-dark-400 hover:text-dark-200 transition-colors">
                        <Edit className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteCode(code)} className="p-1.5 rounded-md hover:bg-danger/10 text-dark-400 hover:text-danger transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
      )}

      {(creating || editCode) && (
        <CouponEditor
          code={editCode}
          coupon={editCode ? coupons[editCode] : null}
          existingCodes={codes}
          allPlanIds={allPlanIds}
          onClose={() => { setCreating(false); setEditCode(null); }}
          onSave={async (code, body) => {
            try {
              if (editCode) {
                await api.put(`/api/system/coupons/${editCode}`, body);
                toast.success("Coupon updated");
              } else {
                await api.post(`/api/system/coupons/${code}`, body);
                toast.success("Coupon created");
              }
              mutate();
              setCreating(false);
              setEditCode(null);
            } catch (e: any) {
              toast.error(e?.response?.data?.detail || "Failed to save coupon");
            }
          }}
        />
      )}

      <ConfirmModal
        open={!!deleteCode}
        onClose={() => setDeleteCode(null)}
        onConfirm={handleDelete}
        loading={busy}
        title="Delete Coupon"
        message={`Remove coupon "${deleteCode}"? This can't be undone.`}
        confirmText="Delete"
      />
    </div>
  );
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function CouponEditor({
  code, coupon, existingCodes, allPlanIds, onClose, onSave,
}: {
  code: string | null;
  coupon: CouponData | null;
  existingCodes: string[];
  allPlanIds: string[];
  onClose: () => void;
  onSave: (code: string, body: any) => Promise<void>;
}) {
  const isNew = !code;
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm({
    defaultValues: {
      code: code || "",
      type: coupon?.type || EMPTY_FORM.type,
      value: coupon?.value ?? EMPTY_FORM.value,
      active: coupon?.active ?? EMPTY_FORM.active,
      starts_at: coupon?.starts_at || "",
      expires_at: coupon?.expires_at || "",
      max_redemptions: coupon?.max_redemptions ?? "",
      max_per_user: coupon?.max_per_user ?? "",
      min_order_usd: coupon?.min_order_usd ?? "",
      max_order_usd: coupon?.max_order_usd ?? "",
      billing: coupon?.billing || EMPTY_FORM.billing,
      applies_to: coupon?.applies_to || [],
      note: coupon?.note || "",
    },
  });
  const [loading, setLoading] = useState(false);
  const type = watch("type");
  const appliesTo = watch("applies_to");

  const togglePlan = (id: string) => {
    const next = appliesTo.includes(id) ? appliesTo.filter((p) => p !== id) : [...appliesTo, id];
    setValue("applies_to", next);
  };

  const onSubmit = async (data: any) => {
    setLoading(true);
    const body = {
      type: data.type,
      value: Number(data.value) || 0,
      active: !!data.active,
      starts_at: data.starts_at || null,
      expires_at: data.expires_at || null,
      max_redemptions: data.max_redemptions === "" ? null : Number(data.max_redemptions),
      max_per_user: data.max_per_user === "" ? null : Number(data.max_per_user),
      min_order_usd: data.min_order_usd === "" ? null : Number(data.min_order_usd),
      max_order_usd: data.max_order_usd === "" ? null : Number(data.max_order_usd),
      billing: data.billing,
      applies_to: data.applies_to,
      note: data.note || "",
    };
    await onSave((data.code || "").trim().toUpperCase(), body);
    setLoading(false);
  };

  return (
    <Modal open onClose={onClose} title={isNew ? "New Coupon" : `Edit "${code}"`} size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* Code & discount */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Code & Discount</p>
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Code"
              placeholder="WELCOME20"
              disabled={!isNew}
              className="uppercase"
              error={errors.code?.message as string}
              {...register("code", {
                required: "Code is required",
                validate: (v) => !existingCodes.includes(v.trim().toUpperCase()) || "A coupon with this code already exists",
              })}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-dark-300">Type</label>
              <select {...register("type")} className="w-full rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed ($)</option>
              </select>
            </div>
            <Input
              label={type === "fixed" ? "Value ($)" : "Value (%)"}
              type="number" step="0.01"
              {...register("value", { valueAsNumber: true, min: 0, max: type === "percent" ? 100 : undefined })}
              error={errors.value?.message as string}
            />
          </div>
        </div>

        {/* Time frame */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Time Frame</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Starts (optional)" type="date" {...register("starts_at")} />
            <Input label="Expires (optional)" type="date" {...register("expires_at")} />
          </div>
          <div className="flex gap-2 mt-2">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" onClick={() => setValue("expires_at", daysFromNow(d))}
                className="text-xs px-2.5 py-1 rounded-md bg-dark-700 hover:bg-dark-600 text-dark-300">
                +{d}d
              </button>
            ))}
          </div>
        </div>

        {/* Usage limits */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Usage Limits <span className="text-dark-500 font-normal">(blank = unlimited)</span></p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Max total redemptions" type="number" {...register("max_redemptions")} />
            <Input label="Max uses per user" type="number" {...register("max_per_user")} />
          </div>
        </div>

        {/* Order amount range */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Order Amount Range <span className="text-dark-500 font-normal">(blank = no limit)</span></p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Minimum order ($)" type="number" step="0.01" {...register("min_order_usd")} />
            <Input label="Maximum order ($)" type="number" step="0.01" {...register("max_order_usd")} />
          </div>
          <p className="text-xs text-dark-500 mt-1">
            A hard payment-provider floor also applies automatically, so a discount can never bring an order below the minimum payable amount.
          </p>
        </div>

        {/* Scope */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Scope</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {allPlanIds.length === 0 && <p className="text-xs text-dark-500">No plans configured</p>}
            {allPlanIds.map((id) => (
              <button key={id} type="button" onClick={() => togglePlan(id)}
                className={`text-xs px-2.5 py-1 rounded-md border ${appliesTo.includes(id) ? "bg-accent/20 border-accent text-accent" : "bg-dark-800 border-dark-600 text-dark-400"}`}>
                {id}
              </button>
            ))}
          </div>
          <p className="text-xs text-dark-500 mb-3">{appliesTo.length === 0 ? "No plans selected = applies to all plans" : `Restricted to: ${appliesTo.join(", ")}`}</p>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-dark-300">Billing cycle</label>
            <select {...register("billing")} className="w-full rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
              <option value="both">Weekly & Monthly</option>
              <option value="week">Weekly only</option>
              <option value="month">Monthly only</option>
            </select>
          </div>
        </div>

        <Input label="Note (optional)" placeholder="Black Friday 2026" {...register("note")} />

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" loading={loading}>
            <Save className="h-4 w-4" /> {isNew ? "Create" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
