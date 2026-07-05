import useSWR from "swr";
import portalApi, { getPortalSession } from "../portal-api";

const fetcher = (url: string) =>
  portalApi.get(url).then((r) => r.data).catch((e) => {
    if (e?.response?.status === 404) return null;
    throw e;
  });

function useSession() {
  return getPortalSession();
}

// A parsed session object can still be missing/blank fields (e.g. telegram_id defaulting to 0)
// if login stored an incomplete session. Firing a request with telegram_id=0 doesn't fail loudly —
// the API 422s it every single poll forever, silently, while the UI just shows stale/frozen data
// from the last time the session was actually valid. Treat a falsy bot_name/telegram_id the same
// as "no session" so we stop hammering the API and the page can show a clear "log in again" state.
function validSession(s: ReturnType<typeof getPortalSession>) {
  return s && s.bot_name && s.telegram_id ? s : null;
}

export function usePortalBot() {
  const s = validSession(useSession());
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}?telegram_id=${s.telegram_id}` : null;
  return useSWR(key, fetcher, { refreshInterval: 5000, shouldRetryOnError: false });
}

export function usePortalStats() {
  const s = validSession(useSession());
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}/stats?telegram_id=${s.telegram_id}` : null;
  return useSWR(key, fetcher, { refreshInterval: 10000, shouldRetryOnError: false });
}

export function usePortalLogs(lines = 100) {
  const s = validSession(useSession());
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}/logs?telegram_id=${s.telegram_id}&lines=${lines}` : null;
  return useSWR(key, fetcher, { refreshInterval: 3000, shouldRetryOnError: false });
}

export function usePortalOrders() {
  const s = validSession(useSession());
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}/orders?telegram_id=${s.telegram_id}` : null;
  return useSWR(key, fetcher, { refreshInterval: 30000, shouldRetryOnError: false });
}

// Exposed so pages can distinguish "session invalid, stop retrying" from "still loading" and show
// a proper "please log in again" message instead of a frozen/stale UI.
export function usePortalSessionValid(): boolean {
  return !!validSession(useSession());
}
