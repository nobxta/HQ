"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getPortalSession } from "@/lib/portal-api";
import PortalSidebar from "@/components/portal/PortalSidebar";
import NotificationBell from "@/components/portal/NotificationBell";
import MobileBottomNav from "@/components/portal/MobileBottomNav";
import { Menu } from "lucide-react";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const session = getPortalSession();
    if (!session) router.replace("/login");
  }, [router]);

  return (
    <div className="flex min-h-screen">
      <PortalSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 lg:ml-60 min-w-0">
        {/* Header bar — always visible with notification bell */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-dark-700/50 bg-dark-950/80 backdrop-blur-xl px-4 sm:px-6 py-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-dark-400 hover:text-dark-200 p-1.5 -ml-1.5 rounded-lg hover:bg-dark-800 transition-colors lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          {/* Spacer on desktop where hamburger is hidden */}
          <div className="hidden lg:block" />
          {/* Notification bell — always visible */}
          <NotificationBell />
        </header>
        <main className="p-4 sm:p-6 pb-28 lg:pb-6">{children}</main>
      </div>
      <MobileBottomNav />
    </div>
  );
}
