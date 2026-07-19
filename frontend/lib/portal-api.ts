import axios from "axios";
import toast from "react-hot-toast";
import { getApiBase, applyBackend } from "./api-base";

const portalApi = axios.create({
  baseURL: getApiBase(),
  headers: { "Content-Type": "application/json" },
});

portalApi.interceptors.request.use((config) => {
  // Resolve backend at request time so the dev backend switcher takes effect live.
  // On localhost this routes through the same-origin dev proxy to sidestep CORS.
  applyBackend(config);
  if (typeof window !== "undefined") {
    const session = localStorage.getItem("portal_session");
    if (session) {
      const { access_token } = JSON.parse(session);
      config.headers.Authorization = `Bearer ${access_token}`;
    }
  }
  return config;
});

portalApi.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error?.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("portal_session");
      window.location.href = "/login";
    }
    // Frozen bot: the server blocks every action with a marked 403. Show one clean
    // "read-only" notice (deduped) and strip the marker so component catches read nicely.
    const detail = error?.response?.data?.detail;
    if (
      error?.response?.status === 403 &&
      typeof detail === "string" &&
      detail.startsWith("BOT_FROZEN:")
    ) {
      const msg = detail.replace(/^BOT_FROZEN:\s*/, "");
      if (typeof window !== "undefined") {
        toast.error(msg, { id: "bot-frozen", duration: 6000, icon: "🧊" });
      }
      if (error.response?.data) error.response.data.detail = msg;
    }
    return Promise.reject(error);
  }
);

export default portalApi;

export function getPortalSession() {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("portal_session");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      access_token: string;
      refresh_token: string;
      bot_name: string;
      telegram_id: number;
    };
  } catch {
    return null;
  }
}

export function setPortalSession(data: {
  access_token: string;
  refresh_token: string;
  bot_name: string;
  telegram_id: number;
}) {
  localStorage.setItem("portal_session", JSON.stringify(data));
}

export function clearPortalSession() {
  localStorage.removeItem("portal_session");
}
