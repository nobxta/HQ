"use client";

import { useState, FormEvent } from "react";

const TOPICS = [
  "Sales and plan questions",
  "Existing customer support",
  "Billing and payment questions",
  "Technical setup assistance",
  "Account replacement request",
] as const;

const SUPPORT_EMAIL = "support@hqadz.io";

interface FormState {
  name: string;
  email: string;
  telegram: string;
  topic: string;
  message: string;
  existingCustomer: boolean;
  orderId: string;
  company: string; // honeypot
}

const INITIAL: FormState = {
  name: "",
  email: "",
  telegram: "",
  topic: TOPICS[0],
  message: "",
  existingCustomer: false,
  orderId: "",
  company: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ContactForm() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) next.name = "Name is required.";
    if (!form.email.trim()) next.email = "Email is required.";
    else if (!EMAIL_RE.test(form.email.trim())) next.email = "Enter a valid email address.";
    if (!form.message.trim()) next.message = "Message is required.";
    else if (form.message.trim().length < 10) next.message = "Message must be at least 10 characters.";
    if (form.existingCustomer && !form.orderId.trim()) next.orderId = "Order or subscription ID is required for existing customers.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setStatus("idle");

    // Honeypot: silently ignore bot submissions without showing an error.
    if (form.company.trim()) {
      setStatus("sent");
      return;
    }

    if (!validate()) {
      setStatus("error");
      return;
    }

    const lines = [
      `Name: ${form.name.trim()}`,
      `Email: ${form.email.trim()}`,
      form.telegram.trim() ? `Telegram: ${form.telegram.trim()}` : null,
      `Topic: ${form.topic}`,
      form.existingCustomer ? `Existing customer: yes` : null,
      form.existingCustomer && form.orderId.trim() ? `Order/Subscription ID: ${form.orderId.trim()}` : null,
      "",
      form.message.trim(),
    ].filter(Boolean);

    const subject = encodeURIComponent(`[HQAdz Contact] ${form.topic}`);
    const body = encodeURIComponent(lines.join("\n"));
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    setStatus("sent");
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-describedby="contact-form-note">
      {/* Honeypot field, hidden from real users */}
      <div className="absolute -left-[9999px]" aria-hidden="true">
        <label htmlFor="company">Company</label>
        <input
          id="company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.company}
          onChange={(e) => set("company", e.target.value)}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div className="space-y-1.5">
          <label htmlFor="name" className="text-[13px] font-medium text-white">
            Name <span className="text-[#5d5d66]">*</span>
          </label>
          <input
            id="name"
            type="text"
            required
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "name-error" : undefined}
            className="w-full bg-[#0e0e10] border border-[#1f1f22] focus:border-[#2AABEE] focus:outline-none rounded-md px-3.5 py-2.5 text-[14px] text-white placeholder:text-[#5d5d66] transition-colors"
            placeholder="Your name"
          />
          {errors.name && <p id="name-error" className="text-[12px] text-red-400">{errors.name}</p>}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="email" className="text-[13px] font-medium text-white">
            Email <span className="text-[#5d5d66]">*</span>
          </label>
          <input
            id="email"
            type="email"
            required
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            className="w-full bg-[#0e0e10] border border-[#1f1f22] focus:border-[#2AABEE] focus:outline-none rounded-md px-3.5 py-2.5 text-[14px] text-white placeholder:text-[#5d5d66] transition-colors"
            placeholder="you@example.com"
          />
          {errors.email && <p id="email-error" className="text-[12px] text-red-400">{errors.email}</p>}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <div className="space-y-1.5">
          <label htmlFor="telegram" className="text-[13px] font-medium text-white">
            Telegram username <span className="text-[#5d5d66]">(optional)</span>
          </label>
          <input
            id="telegram"
            type="text"
            value={form.telegram}
            onChange={(e) => set("telegram", e.target.value)}
            className="w-full bg-[#0e0e10] border border-[#1f1f22] focus:border-[#2AABEE] focus:outline-none rounded-md px-3.5 py-2.5 text-[14px] text-white placeholder:text-[#5d5d66] transition-colors"
            placeholder="@yourhandle"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="topic" className="text-[13px] font-medium text-white">
            Topic
          </label>
          <select
            id="topic"
            value={form.topic}
            onChange={(e) => set("topic", e.target.value)}
            className="w-full bg-[#0e0e10] border border-[#1f1f22] focus:border-[#2AABEE] focus:outline-none rounded-md px-3.5 py-2.5 text-[14px] text-white transition-colors"
          >
            {TOPICS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <input
          id="existingCustomer"
          type="checkbox"
          checked={form.existingCustomer}
          onChange={(e) => set("existingCustomer", e.target.checked)}
          className="w-4 h-4 rounded border-[#2e2e34] bg-[#0e0e10] accent-[#2AABEE]"
        />
        <label htmlFor="existingCustomer" className="text-[13.5px] text-[#c7c7cc]">
          I'm an existing customer
        </label>
      </div>

      {form.existingCustomer && (
        <div className="space-y-1.5">
          <label htmlFor="orderId" className="text-[13px] font-medium text-white">
            Order or subscription ID <span className="text-[#5d5d66]">*</span>
          </label>
          <input
            id="orderId"
            type="text"
            value={form.orderId}
            onChange={(e) => set("orderId", e.target.value)}
            aria-invalid={!!errors.orderId}
            aria-describedby={errors.orderId ? "orderId-error" : undefined}
            className="w-full bg-[#0e0e10] border border-[#1f1f22] focus:border-[#2AABEE] focus:outline-none rounded-md px-3.5 py-2.5 text-[14px] text-white placeholder:text-[#5d5d66] transition-colors"
            placeholder="e.g. order ID from your dashboard"
          />
          {errors.orderId && <p id="orderId-error" className="text-[12px] text-red-400">{errors.orderId}</p>}
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="message" className="text-[13px] font-medium text-white">
          Message <span className="text-[#5d5d66]">*</span>
        </label>
        <textarea
          id="message"
          required
          rows={5}
          value={form.message}
          onChange={(e) => set("message", e.target.value)}
          aria-invalid={!!errors.message}
          aria-describedby={errors.message ? "message-error" : undefined}
          className="w-full bg-[#0e0e10] border border-[#1f1f22] focus:border-[#2AABEE] focus:outline-none rounded-md px-3.5 py-2.5 text-[14px] text-white placeholder:text-[#5d5d66] transition-colors resize-y"
          placeholder="Tell us what you need help with"
        />
        {errors.message && <p id="message-error" className="text-[12px] text-red-400">{errors.message}</p>}
      </div>

      <button
        type="submit"
        className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium transition-opacity hover:opacity-90"
        style={{ background: "#2AABEE" }}
      >
        Send message
      </button>

      <p id="contact-form-note" className="text-[12px] text-[#5d5d66] leading-relaxed">
        This form prepares your message and opens your email app to send it to {SUPPORT_EMAIL}. Nothing is sent
        automatically from this page.
      </p>

      <div role="status" aria-live="polite">
        {status === "sent" && (
          <p className="text-[13px] text-emerald-400">
            Your email app should now be open with your message ready to send. If it didn't open, email us
            directly at {SUPPORT_EMAIL}.
          </p>
        )}
        {status === "error" && (
          <p className="text-[13px] text-red-400">
            Please fix the highlighted fields above before sending.
          </p>
        )}
      </div>
    </form>
  );
}
