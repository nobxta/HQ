import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import axios from "axios";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export const authOptions: NextAuthOptions = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },  // 30 days
  providers: [
    CredentialsProvider({
      name: "Admin Login",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
        code: { label: "Code", type: "password" },
        access_token: { label: "Token", type: "text" },
        refresh_token: { label: "Refresh", type: "text" },
      },
      async authorize(credentials) {
        // Mode 1: Pre-authenticated (unified login already validated)
        if (credentials?.access_token && credentials?.refresh_token) {
          return {
            id: credentials.username || "admin",
            name: credentials.username || "admin",
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token,
          };
        }

        // Mode 2: Code-only login (unified)
        if (credentials?.code) {
          try {
            const { data } = await axios.post(`${API_URL}/api/portal/unified-login`, {
              code: credentials.code,
            });
            if (data.role === "admin") {
              return {
                id: "admin",
                name: "admin",
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
              };
            }
            return null; // Not admin
          } catch {
            return null;
          }
        }

        // Mode 3: Legacy username/password
        if (!credentials?.username || !credentials?.password) return null;
        try {
          const { data } = await axios.post(`${API_URL}/api/auth/login`, {
            username: credentials.username,
            password: credentials.password,
          });
          return {
            id: credentials.username,
            name: credentials.username,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.accessToken = (user as any).accessToken;
        token.refreshToken = (user as any).refreshToken;
        // Set expiry: access token lasts 24h, refresh before it expires
        token.accessTokenExpires = Date.now() + 23 * 60 * 60 * 1000; // 23h
      }

      // If access token hasn't expired, return as-is
      if (Date.now() < (token.accessTokenExpires as number || 0)) {
        return token;
      }

      // Access token expired — try to refresh using refresh token
      try {
        const { data } = await axios.post(`${API_URL}/api/auth/refresh`, {
          refresh_token: token.refreshToken,
        });
        token.accessToken = data.access_token;
        token.refreshToken = data.refresh_token;
        token.accessTokenExpires = Date.now() + 23 * 60 * 60 * 1000;
        token.error = undefined;
      } catch {
        // Refresh token is also expired — force re-login
        token.error = "RefreshTokenExpired";
      }

      return token;
    },
    async session({ session, token }) {
      (session as any).accessToken = token.accessToken;
      (session as any).refreshToken = token.refreshToken;
      (session as any).error = token.error;
      return session;
    },
  },
};
