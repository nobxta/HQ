import axios from "axios";
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
