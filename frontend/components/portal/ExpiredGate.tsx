"use client";
import { useRouter } from "next/navigation";
import { Lock, RefreshCw, AlertTriangle } from "lucide-react";
import Button from "@/components/ui/Button";

interface ExpiredGateProps {
  /** Whether the plan is expired (server-authoritative `expired` flag). */
  expired: boolean;
  /** Hours left in the 48h grace window before the bot is removed. null = not yet tracked. */
  graceHoursLeft?: number | null;
}

/**
 * Full-screen blur-lock shown over the portal when the plan has expired. The user can no longer
 * operate the bot; the only action is Renew, which routes to the existing renewal wizard
 * (/user/billing/renew). The layout hides this gate on /user/billing so renewal stays reachable.
 */
export default function ExpiredGate({ expired, graceHoursLeft }: ExpiredGateProps) {
  const router = useRouter();
  if (!expired) return null;

  const hrs = typeof graceHoursLeft === "number" ? graceHoursLeft : null;
  const inGrace = hrs !== null && hrs > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Scrim that blurs everything behind it */}
      <div className="absolute inset-0 bg-dark-950/70 backdrop-blur-md" aria-hidden />

      <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-danger/20 bg-[#0b0b12] p-7 text-center shadow-2xl animate-fade-in">
        {/* Ambient glows */}
        <div className="pointer-events-none absolute -right-16 -top-20 h-40 w-40 rounded-full bg-danger/15 blur-[70px]" />
        <div className="pointer-events-none absolute -bottom-20 -left-16 h-36 w-36 rounded-full bg-accent/15 blur-[70px]" />

        <div className="relative">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-danger/25 bg-danger/10">
            <Lock className="h-6 w-6 text-danger" />
          </div>

          <h2 className="text-xl font-black text-white">Plan expired</h2>

          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-dark-300">
            Your AdBot plan has expired and posting has stopped. Renew now to restore your bot with
            the same accounts.
          </p>

          {inGrace ? (
            <div className="mt-5 flex items-center justify-center gap-2 rounded-2xl border border-warning/20 bg-warning/[0.06] px-4 py-3 text-xs font-semibold text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                About <span className="font-bold text-white tabular-nums">{hrs}h</span> left to renew
                before your bot is removed.
              </span>
            </div>
          ) : (
            <div className="mt-5 flex items-center justify-center gap-2 rounded-2xl border border-danger/20 bg-danger/[0.06] px-4 py-3 text-xs font-semibold text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Renew soon — your bot will be removed once the grace period ends.</span>
            </div>
          )}

          <Button
            size="lg"
            className="mt-6 h-12 w-full rounded-xl font-bold"
            onClick={() => router.push("/user/billing/renew")}
          >
            <RefreshCw className="h-4 w-4" />
            Renew Now
          </Button>
        </div>
      </div>
    </div>
  );
}
