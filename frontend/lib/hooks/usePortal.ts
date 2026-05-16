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

export function usePortalBot() {
  const s = useSession();
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}?telegram_id=${s.telegram_id}` : null;
  return useSWR(key, fetcher, { refreshInterval: 5000, shouldRetryOnError: false });
}

export function usePortalStats() {
  const s = useSession();
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}/stats?telegram_id=${s.telegram_id}` : null;
  return useSWR(key, fetcher, { refreshInterval: 10000, shouldRetryOnError: false });
}

export function usePortalLogs(lines = 100) {
  const s = useSession();
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}/logs?telegram_id=${s.telegram_id}&lines=${lines}` : null;
  return useSWR(key, fetcher, { refreshInterval: 3000, shouldRetryOnError: false });
}

export function usePortalOrders() {
  const s = useSession();
  const key = s ? `/api/portal/bot/${encodeURIComponent(s.bot_name)}/orders?telegram_id=${s.telegram_id}` : null;
  return useSWR(key, fetcher, { refreshInterval: 30000, shouldRetryOnError: false });
}
