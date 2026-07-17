/**
 * Runtime backend (API base URL) switcher — LOCAL DEV ONLY.
 *
 * Why this exists: `NEXT_PUBLIC_API_URL` is inlined at build time, so pointing the
 * frontend at a different backend normally means rebuilding. This lets you flip the
 * backend at runtime (localStorage) while testing on your own machine — e.g. run the
 * frontend on localhost but hit the real VPS backend to test the renewal gateway.
 *
 * SAFETY: The override is honored *only* when the page is served from a local dev host
 * (localhost / 127.0.0.1 / LAN IP / *.local). On the live public domain (hqadz.io) the
 * override is ignored completely and the switcher UI never renders — so a visitor can
 * never repoint the production backend, and nothing needs to be stripped before deploy.
 */

/** Backend served at build time. Also the hard default on any non-local host. */
const DEFAULT_API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const STORAGE_KEY = "dev_api_base_override";

export type BackendPreset = { label: string; url: string; hint?: string };

/** The two backends you switch between while testing. */
export const BACKEND_PRESETS: BackendPreset[] = [
  { label: "Localhost", url: "http://localhost:8000", hint: "Local FastAPI on this PC" },
  { label: "Home VPS", url: "https://api.hqadz.io", hint: "Live backend on the VPS" },
];

/**
 * True only when this page is being served from a local dev machine. This is the single
 * gate for both showing the switcher and honoring any stored override. On a real domain
 * it returns false, so production always uses DEFAULT_API no matter what is in localStorage.
 */
export function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h.endsWith(".local") ||
    /^192\.168\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** The backend the app should talk to right now. */
export function getApiBase(): string {
  // Server-side render, or any non-local host → always the build-time backend.
  if (!isLocalDevHost()) return DEFAULT_API;
  try {
    const override = window.localStorage.getItem(STORAGE_KEY);
    if (override && /^https?:\/\//.test(override)) return override;
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return DEFAULT_API;
}

/** Persist a chosen backend (no-op off local dev host). */
export function setApiBase(url: string): void {
  if (!isLocalDevHost()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, url.replace(/\/+$/, ""));
  } catch {
    /* ignore */
  }
}

/** Clear the override → back to DEFAULT_API. */
export function clearApiBase(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** The build-time default, for display ("reset to default"). */
export function getDefaultApiBase(): string {
  return DEFAULT_API;
}
