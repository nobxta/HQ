import axios from "axios";
import { getSession, signOut } from "next-auth/react";
import { getApiBase } from "./api-base";

const api = axios.create({
  baseURL: getApiBase(),
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
});

// Attach bearer token from NextAuth session
api.interceptors.request.use(async (config) => {
  // Resolve backend at request time so the dev backend switcher takes effect live.
  config.baseURL = getApiBase();
  if (typeof window !== "undefined") {
    const session = await getSession();
    // If refresh token expired, sign out immediately
    if ((session as any)?.error === "RefreshTokenExpired") {
      await signOut({ callbackUrl: "/login" });
      return Promise.reject(new Error("Session expired"));
    }
    if ((session as any)?.accessToken) {
      config.headers.Authorization = `Bearer ${(session as any).accessToken}`;
    }
  }
  return config;
});

// Handle 401 — try to refresh session before signing out
let isRefreshing = false;
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401 && typeof window !== "undefined" && !isRefreshing) {
      isRefreshing = true;
      try {
        // Force NextAuth to refresh the session (triggers jwt callback which auto-refreshes)
        const session = await getSession();
        if ((session as any)?.error === "RefreshTokenExpired") {
          await signOut({ callbackUrl: "/login" });
        } else if ((session as any)?.accessToken) {
          // Retry the original request with new token
          err.config.headers.Authorization = `Bearer ${(session as any).accessToken}`;
          isRefreshing = false;
          return api.request(err.config);
        } else {
          await signOut({ callbackUrl: "/login" });
        }
      } catch {
        await signOut({ callbackUrl: "/login" });
      }
      isRefreshing = false;
    }
    return Promise.reject(err);
  }
);

export default api;
