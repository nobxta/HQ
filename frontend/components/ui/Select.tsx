"use client";
import { cn } from "@/lib/utils";
import { SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, id, options, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-dark-300">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={id}
        className={cn(
          "w-full rounded-lg border bg-dark-800 px-3 py-2 text-sm text-dark-100",
          "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-all",
          error ? "border-danger" : "border-dark-600",
          className
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
);

Select.displayName = "Select";
export default Select;
