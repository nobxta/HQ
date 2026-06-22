"use client";

import { useState, useEffect } from "react";
import { X, Clock, Bell, Info, Copy, Check, MessageCircle, Loader2 } from "lucide-react";

interface QueuedWaitingScreenProps {
  plan: { label: string; price: number; billing: string; durationDays: number };
  accessCode?: string;
  onClose: () => void;
  estimatedMinutes?: number;
  telegramSupportUrl?: string;
}

export default function QueuedWaitingScreen({
  plan,
  accessCode = "czV1IvmA",
  onClose,
  estimatedMinutes = 10,
  telegramSupportUrl = "https://t.me/hqadz_support",
}: QueuedWaitingScreenProps) {
  const [copied, setCopied] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifySaved, setNotifySaved] = useState(false);
  const [progressIdx, setProgressIdx] = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setProgressIdx(i => Math.min(i + 1, 3)), 1600);
    return () => clearInterval(iv);
  }, []);

  const copy = () => {
    navigator.clipboard.writeText(accessCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const saveNotification = () => {
    if (notifyEmail.trim()) {
      setNotifySaved(true);
    }
  };

  const estimatedTime = estimatedMinutes < 60
    ? `~${estimatedMinutes} min`
    : `~${(estimatedMinutes / 60).toFixed(1)} hours`;

  const steps = [
    { label: "Your request is confirmed", state: progressIdx >= 0 ? "done" : "todo" },
    { label: "Preparing AdBot resources", state: progressIdx >= 1 ? (progressIdx === 1 ? "active" : "done") : "todo" },
    { label: "Configuring your workspace", state: progressIdx >= 2 ? (progressIdx === 2 ? "active" : "done") : "todo" },
    { label: "Finalizing & unlocking access", state: progressIdx >= 3 ? "active" : "todo" },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 font-body" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-[#1f1f22] bg-[#0a0a0a] shadow-2xl" style={{ scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}>

        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-[#1f1f22] bg-[#0a0a0a]/95 backdrop-blur">
          <div>
            <p className="text-[14px] font-semibold text-white">{plan.label}</p>
            <p className="text-[11px] text-[#5d5d66]">${plan.price}/mo · {plan.durationDays} days</p>
          </div>
          <button onClick={onClose} className="text-[#8b8b93] hover:text-white transition-colors" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">

          {/* Spinner & Heading */}
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="w-20 h-20 rounded-full border-2 border-[#3BA8FF]/30 border-t-[#3BA8FF] animate-spin" />
            </div>
            <h2 className="text-[24px] font-semibold text-white">You're in queue!</h2>
            <p className="text-[14px] text-[#94A3B8] leading-relaxed">
              We're currently preparing your AdBot. Due to high demand, your setup is taking a little longer than usual.
            </p>
          </div>

          {/* Wait time & Notification cards */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-[#1f1f22] bg-[#0B1020] p-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-[#3BA8FF]" />
                <p className="text-[11px] text-[#5d5d66] uppercase tracking-wider">Estimated wait time</p>
              </div>
              <p className="text-[20px] font-semibold text-white">{estimatedTime}</p>
            </div>
            <div className="rounded-lg border border-[#1f1f22] bg-[#0B1020] p-4">
              <div className="flex items-center gap-2 mb-2">
                <Bell className="w-4 h-4 text-[#3BA8FF]" />
                <p className="text-[11px] text-[#5d5d66] uppercase tracking-wider">Notification</p>
              </div>
              <p className="text-[13px] text-white">You'll be notified here</p>
              <p className="text-[11px] text-[#5d5d66] mt-1">As soon as your AdBot is ready to go.</p>
            </div>
          </div>

          {/* Preparation Status */}
          <div className="rounded-lg border border-[#1f1f22] bg-[#0B1020] p-5 space-y-4">
            <p className="text-[11px] uppercase tracking-wider text-[#5d5d66]">Preparation Status</p>
            <div className="space-y-3">
              {steps.map((step, idx) => (
                <div key={step.label} className="flex items-start gap-3">
                  <div className="flex flex-col items-center mt-0.5">
                    {step.state === "done" && (
                      <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[#22C55E]/20 border border-[#22C55E]">
                        <Check className="w-3 h-3 text-[#22C55E]" />
                      </div>
                    )}
                    {step.state === "active" && (
                      <div className="w-5 h-5 rounded-full flex items-center justify-center bg-[#3BA8FF]/20 border border-[#3BA8FF] animate-pulse">
                        <div className="w-2 h-2 rounded-full bg-[#3BA8FF]" />
                      </div>
                    )}
                    {step.state === "todo" && (
                      <div className="w-5 h-5 rounded-full border border-[#3d3d44]" />
                    )}
                    {idx < 3 && <div className="w-0.5 h-6 bg-[#1f1f22]" />}
                  </div>
                  <div className="pt-0.5">
                    <p className={`text-[13px] font-medium ${step.state === "todo" ? "text-[#5d5d66]" : step.state === "active" ? "text-[#3BA8FF]" : "text-white"}`}>
                      {step.state === "active" && "⟳ "}{step.label}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* What's happening? */}
          <div className="rounded-lg border border-[#1f1f22] bg-[#0B1020] p-4 flex gap-3">
            <Info className="w-5 h-5 text-[#3BA8FF] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[13px] font-semibold text-white">What's happening?</p>
              <p className="text-[12px] text-[#94A3B8] mt-1.5 leading-relaxed">
                Our team is setting up powerful resources to make sure your AdBot performs at its best. Hang tight — it'll be worth the wait!
              </p>
            </div>
          </div>

          {/* Access Code */}
          <div className="rounded-lg border border-[#1f1f22] bg-[#0B1020] p-5 text-center space-y-3">
            <p className="text-[11px] uppercase tracking-wider text-[#5d5d66]">Access Code</p>
            <code className="block text-[32px] font-mono font-bold text-white tracking-[0.08em] letter-spacing-wide">
              {accessCode}
            </code>
            <button
              onClick={copy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold text-white transition-all hover:translate-y-[-2px]"
              style={{ background: "linear-gradient(135deg, #3BA8FF 0%, #2B8FD9 100%)" }}
            >
              {copied ? (
                <><Check className="w-4 h-4" /> Copied</>
              ) : (
                <><Copy className="w-4 h-4" /> Copy code</>
              )}
            </button>
            <p className="text-[11px] text-[#94A3B8]">
              Use this code to access your AdBot dashboard once everything is ready.
            </p>
          </div>

          {/* Notify Me When Ready */}
          <div className="space-y-3">
            <label className="text-[12px] font-semibold text-white block">Get notified when ready</label>
            <div className="flex gap-2">
              <input
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="Enter your email"
                className="flex-1 rounded-lg border border-[#1f1f22] bg-[#101012] px-3.5 py-2.5 text-[13px] text-white placeholder-[#5d5d66] outline-none focus:border-[#3BA8FF]/50 transition-colors"
              />
              <button
                onClick={saveNotification}
                disabled={!notifyEmail.trim() || notifySaved}
                className="px-4 rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: notifySaved ? "#22C55E" : "#3BA8FF" }}
              >
                {notifySaved ? "✓ Saved" : "Notify"}
              </button>
            </div>
          </div>

          {/* Contact Support - Telegram */}
          <a
            href={telegramSupportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full inline-flex items-center justify-center gap-2 text-[14px] font-semibold text-white py-3 rounded-lg transition-all hover:translate-y-[-2px] border border-[#3BA8FF]/30 hover:border-[#3BA8FF]/60 hover:bg-[#3BA8FF]/10"
          >
            <MessageCircle className="w-4 h-4" />
            Contact Support on Telegram
          </a>

        </div>
      </div>

      <style jsx>{`
        div::-webkit-scrollbar {
          width: 5px;
        }
        div::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 9999px;
        }
        div::-webkit-scrollbar-track {
          background: transparent;
        }
      `}</style>
    </div>
  );
}
