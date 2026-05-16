"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getPortalSession } from "@/lib/portal-api";
import PortalSidebar from "@/components/portal/PortalSidebar";
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
        <header className="sticky top-0 z-30 flex items-center border-b border-dark-700/50 bg-dark-950/80 backdrop-blur-xl px-4 sm:px-6 py-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-dark-400 hover:text-dark-200 p-1.5 -ml-1.5 rounded-lg hover:bg-dark-800 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>
        <main className="p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
