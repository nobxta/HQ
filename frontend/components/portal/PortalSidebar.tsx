"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { clearPortalSession, getPortalSession } from "@/lib/portal-api";
import {
  LayoutDashboard, Terminal, Link2, List,
  Settings, CreditCard, Shield, LogOut, X, Users,
} from "lucide-react";

const nav = [
  { href: "/user/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/user/accounts", label: "Accounts", icon: Users },
  { href: "/user/logs", label: "Live Logs", icon: Terminal },
  { href: "/user/campaign", label: "Campaign", icon: Link2 },
  { href: "/user/chatlist", label: "Chat List", icon: List },
  { href: "/user/settings", label: "Settings", icon: Settings },
  { href: "/user/billing", label: "Billing", icon: CreditCard },
];

interface PortalSidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function PortalSidebar({ open, onClose }: PortalSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<ReturnType<typeof getPortalSession>>(null);

  useEffect(() => {
    setSession(getPortalSession());
  }, []);

  const handleLogout = () => {
    clearPortalSession();
    router.push("/login");
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "fixed left-0 top-0 z-50 h-screen w-60 border-r border-dark-700/50 bg-dark-950 flex flex-col transition-transform duration-300 ease-out",
          "lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between px-5 py-5 border-b border-dark-700/50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent">
              <Shield className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-white truncate">{session?.bot_name || "AdBot"}</h1>
              <p className="text-[10px] uppercase tracking-widest text-dark-500">Control Panel</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-dark-400 hover:text-dark-200 p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-accent/10 text-accent border border-accent/20"
                    : "text-dark-400 hover:text-dark-200 hover:bg-dark-800"
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-dark-700/50 px-3 py-3 space-y-2">
          {session && (
            <div className="px-3 py-2 rounded-lg bg-dark-800/50 text-xs text-dark-400">
              <span className="text-dark-500">ID:</span> {session.telegram_id}
            </div>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-sm font-medium text-dark-400 hover:text-danger hover:bg-danger/5 transition-all"
          >
            <LogOut className="h-4 w-4" /> Logout
          </button>
        </div>
      </aside>
    </>
  );
}
