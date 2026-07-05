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

// telegram_id: 0 is a legitimate value here — bots with no owner_id assigned yet are intentionally
// accessible with telegram_id=0 (see api/routers/user_portal.py `_get_user_bot`: telegram_id==0 is
// allowed when owner_id in (None, 0)). Only a missing bot_name (or no session at all) means the
// session itself is unusable — don't require telegram_id to be truthy.
function validSession(s: ReturnType<typeof getPortalSession>) {
  return s && s.bot_name ? s : null;
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
