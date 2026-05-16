"use client";
import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shield, Key, Loader2, Eye, EyeOff } from "lucide-react";
import Button from "@/components/ui/Button";
import portalApi, { setPortalSession } from "@/lib/portal-api";
import { Suspense } from "react";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoLogging, setAutoLogging] = useState(false);

  useEffect(() => {
    const urlToken = searchParams.get("token");
    if (urlToken) {
      setAutoLogging(true);
      loginWithCode(urlToken);
    }
  }, [searchParams]);

  const loginWithCode = async (inputCode: string) => {
    const trimmed = inputCode.trim();
    if (!trimmed) { setError("Enter your access code"); return; }

    setError("");
    setLoading(true);

    try {
      const { data } = await portalApi.post("/api/portal/unified-login", { code: trimmed });

      if (data.role === "admin") {
        // Admin → sign in via next-auth (sets session cookie for middleware)
        const result = await signIn("credentials", {
          redirect: false,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        });
        if (result?.error) {
          setError("Admin login failed");
          setLoading(false);
          setAutoLogging(false);
        } else {
          router.push("/admin");
        }
      } else {
        // User → store portal session, redirect to user dashboard
        setPortalSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          bot_name: data.bot_name,
          telegram_id: data.telegram_id,
        });
        router.replace("/user/dashboard");
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Invalid code");
      setAutoLogging(false);
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginWithCode(code);
  };

  if (autoLogging) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-dark-950 p-4">
        <div className="text-center space-y-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-lg shadow-accent/20 mx-auto">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <div className="flex items-center gap-2 text-dark-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Signing in...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark-950 p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent shadow-lg shadow-accent/20 mb-4">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">HQAdz Panel</h1>
          <p className="text-sm text-dark-400 mt-1">Enter your access code to continue</p>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-danger/10 border border-danger/20 px-3 py-2">
            <p className="text-sm text-danger">{error}</p>
          </div>
        )}

        {/* Login form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-dark-700/50 bg-dark-850 p-5 sm:p-6 space-y-4"
        >
          <div>
            <label htmlFor="code" className="block text-xs font-medium text-dark-400 mb-1.5">
              Access Code
            </label>
            <div className="relative">
              <input
                id="code"
                type={showCode ? "text" : "password"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter code"
                autoFocus
                autoComplete="off"
                className="w-full rounded-lg border border-dark-600 bg-dark-950 px-3 py-2.5 pr-10 text-sm text-dark-200 placeholder:text-dark-600 focus:outline-none focus:ring-2 focus:ring-accent/40 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowCode(!showCode)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300 transition-colors"
              >
                {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <Button type="submit" className="w-full" loading={loading}>
            <Key className="h-4 w-4" /> Sign In
          </Button>

          <p className="text-[10px] text-dark-600 text-center">
            Your access code was provided when your bot was created.
          </p>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-dark-950">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
