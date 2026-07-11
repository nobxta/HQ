"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { getPortalSession } from "@/lib/portal-api";
import PortalSidebar from "@/components/portal/PortalSidebar";
import NotificationBell from "@/components/portal/NotificationBell";
import MobileBottomNav from "@/components/portal/MobileBottomNav";
import { Menu, CalendarDays } from "lucide-react";

const PAGE_TITLES: Record<string, string> = {
  "/user/dashboard": "Dashboard",
  "/user/accounts": "Accounts",
  "/user/logs": "Live Logs",
  "/user/campaign": "Campaigns",
  "/user/chatlist": "Chat List",
  "/user/auto-reply": "Auto Reply",
  "/user/settings": "Settings",
  "/user/billing": "Billing",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const session = getPortalSession();
    if (!session) router.replace("/login");
  }, [router]);

  useEffect(() => {
    setNow(new Date());
    const iv = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(iv);
  }, []);

  const pageTitle = PAGE_TITLES[pathname] ||
    Object.entries(PAGE_TITLES).find(([href]) => pathname.startsWith(href + "/"))?.[1] || "";

  return (
    <div className="flex min-h-screen">
      <PortalSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 lg:ml-60 min-w-0">
        {/* Header bar — always visible with notification bell */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-dark-700/50 bg-dark-950/80 backdrop-blur-xl px-4 sm:px-6 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-dark-400 hover:text-dark-200 p-1.5 -ml-1.5 rounded-lg hover:bg-dark-800 transition-colors lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            {pageTitle && <h1 className="text-lg font-bold text-white truncate">{pageTitle}</h1>}
          </div>
          <div className="flex items-center gap-3">
            {/* Live date / time pill — desktop */}
            {now && (
              <div className="hidden md:flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2 text-[13px] font-medium text-dark-300">
                <CalendarDays className="h-4 w-4 text-dark-400" />
                <span className="text-dark-200">{now.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
                <span className="h-3 w-px bg-white/[0.1]" />
                <span className="text-dark-200 tabular-nums">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            )}
            {/* Notification bell — always visible */}
            <NotificationBell />
          </div>
        </header>
        <main className="p-4 sm:p-6 pb-28 lg:pb-6">{children}</main>
      </div>
      <MobileBottomNav />
    </div>
  );
}
