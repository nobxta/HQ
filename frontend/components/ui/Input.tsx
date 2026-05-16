"use client";
import { cn } from "@/lib/utils";
import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-dark-300">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={id}
        className={cn(
          "w-full rounded-lg border bg-dark-800 px-3 py-2 text-sm text-dark-100 placeholder:text-dark-500",
          "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-all",
          error ? "border-danger" : "border-dark-600",
          className
        )}
        {...props}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
);

Input.displayName = "Input";
export default Input;
