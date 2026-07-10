"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, EyeOff, AlertCircle } from "lucide-react";

/**
 * Renders a live Telegram post preview using Telegram's official embed widget
 * (telegram-widget.js + data-telegram-post).
 *
 * IMPORTANT: Telegram only renders PUBLIC posts of the form t.me/<username>/<id>.
 * Private-channel links (t.me/c/123456/789), invite links (t.me/+..., /joinchat,
 * /addlist) and username-only links have no embeddable post, so we detect those
 * and show an explanatory note instead of an endless spinner.
 */

type Parsed =
  | { ok: true; value: string; url: string }
  | { ok: false; reason: string };

export function parseTelegramPostUrl(raw: string): Parsed {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { ok: false, reason: "Enter a link to preview." };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }

  const allowedHosts = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: "Use a t.me link." };
  }

  const parts = url.pathname.split("/").filter(Boolean);

  // Private channel (t.me/c/<internal id>/<msg>) — not embeddable.
  if (parts[0]?.toLowerCase() === "c") {
    return { ok: false, reason: "Private-channel links can't be previewed (only public t.me/name/123 posts)." };
  }
  // Invite / join links — no single post to embed.
  if (parts[0]?.startsWith("+") || ["joinchat", "addlist"].includes(parts[0]?.toLowerCase())) {
    return { ok: false, reason: "Invite links can't be previewed — paste a public post link." };
  }

  if (
    parts.length !== 2 ||
    !/^[a-zA-Z0-9_]{4,32}$/.test(parts[0]) ||
    !/^\d+$/.test(parts[1])
  ) {
    return { ok: false, reason: "Preview needs a public post link like t.me/name/123." };
  }

  return {
    ok: true,
    value: `${parts[0]}/${parts[1]}`,
    url: `https://t.me/${parts[0]}/${parts[1]}`,
  };
}

export default function TelegramPostPreview({
  url,
  className = "",
}: {
  url: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "blocked">("loading");
  const parsed = parseTelegramPostUrl(url);
  const value = parsed.ok ? parsed.value : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !value) return;

    host.replaceChildren();
    setStatus("loading");

    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-post", value);
    script.setAttribute("data-width", "100%");
    script.setAttribute("data-dark", "1");
    script.setAttribute("data-color", "2AABEE");
    script.setAttribute("data-dark-color", "2AABEE");

    const observer = new MutationObserver(() => {
      if (host.querySelector("iframe")) {
        setStatus("loaded");
        observer.disconnect();
      }
    });
    observer.observe(host, { childList: true, subtree: true });

    host.appendChild(script);

    const timeout = window.setTimeout(() => {
      if (!host.querySelector("iframe")) setStatus("blocked");
    }, 10000);

    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      host.replaceChildren();
    };
  }, [value]);

  if (!parsed.ok) {
    return (
      <div className={`flex items-start gap-2 rounded-lg border border-dashed border-dark-600 bg-dark-900 px-3 py-2.5 ${className}`}>
        {url.trim() ? (
          <AlertCircle className="h-3.5 w-3.5 text-amber-400/80 shrink-0 mt-0.5" />
        ) : (
          <EyeOff className="h-3.5 w-3.5 text-dark-500 shrink-0 mt-0.5" />
        )}
        <p className="text-xs text-dark-400 leading-relaxed">{parsed.reason}</p>
      </div>
    );
  }

  return (
    <div className={`relative rounded-lg overflow-hidden ${className}`}>
      {status !== "loaded" && (
        <div className="flex items-center gap-2 rounded-lg border border-dark-700 bg-dark-900 px-3 py-6 justify-center">
          {status === "loading" ? (
            <>
              <Loader2 className="h-4 w-4 text-accent animate-spin" />
              <span className="text-xs text-dark-400">Loading preview…</span>
            </>
          ) : (
            <>
              <AlertCircle className="h-4 w-4 text-amber-400/80" />
              <span className="text-xs text-dark-400">Post unavailable or preview blocked.</span>
            </>
          )}
        </div>
      )}
      <div
        ref={hostRef}
        className={status === "loaded" ? "block" : "sr-only"}
        aria-live="polite"
      />
    </div>
  );
}
