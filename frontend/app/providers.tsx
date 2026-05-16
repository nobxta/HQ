"use client";
import { SessionProvider } from "next-auth/react";
import { Toaster } from "react-hot-toast";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: "#252533",
            color: "#ececf1",
            border: "1px solid rgba(74,74,90,0.5)",
            borderRadius: "12px",
            fontSize: "14px",
          },
          success: { iconTheme: { primary: "#00cec9", secondary: "#fff" } },
          error: { iconTheme: { primary: "#ff6b6b", secondary: "#fff" } },
        }}
      />
    </SessionProvider>
  );
}
