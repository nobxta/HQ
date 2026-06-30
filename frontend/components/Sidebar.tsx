"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import BrandMark from "@/components/BrandMark";
import { useState } from "react";
import {
  LayoutDashboard, Bot, HardDrive, FolderOpen,
  CreditCard, Tag, Settings, Megaphone, Shield, X,
  ChevronDown, HelpCircle, KeyRound,
} from "lucide-react";

const mainNav = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/adbots", label: "AdBots", icon: Bot },
  { href: "/admin/sessions", label: "Sessions", icon: HardDrive },
  { href: "/admin/groups", label: "Groups", icon: FolderOpen },
];

const manageNav = [
  { href: "/admin/payments", label: "Payments", icon: CreditCard },
  { href: "/admin/plans", label: "Plans", icon: Tag },
  { href: "/admin/tokens", label: "Bot Tokens", icon: KeyRound },
  { href: "/admin/support", label: "Support", icon: HelpCircle },
  { href: "/admin/broadcast", label: "Broadcast", icon: Megaphone },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const [manageOpen, setManageOpen] = useState(true);

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  const NavItem = ({ href, label, icon: Icon }: { href: string; label: string; icon: any }) => {
    const active = isActive(href);
    return (
      <Link
        key={href}
        href={href}
        onClick={onClose}
        className={cn(
          "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200",
          active
            ? "bg-gradient-to-r from-accent/20 to-accent/5 text-white shadow-lg shadow-accent/5"
            : "text-dark-500 hover:text-dark-200 hover:bg-dark-800/60"
        )}
      >
        <div className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg transition-all",
          active
            ? "bg-accent text-white shadow-md shadow-accent/30"
            : "bg-dark-800/80 text-dark-500 group-hover:text-dark-300 group-hover:bg-dark-800"
        )}>
          <Icon className="h-4 w-4" />
        </div>
        {label}
        {active && (
          <div className="ml-auto h-1.5 w-1.5 rounded-full bg-accent shadow-sm shadow-accent/50" />
        )}
      </Link>
    );
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
          "fixed left-0 top-0 z-50 h-screen w-64 border-r border-dark-700/30 bg-dark-950 flex flex-col transition-transform duration-300 ease-out",
          "lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-5 py-5">
          <div className="flex items-center gap-3">
            <div>
              <BrandMark height={20} />
              <p className="text-[10px] uppercase tracking-[0.2em] text-dark-600 font-medium mt-1">Admin Panel</p>
            </div>
          </div>
          <button onClick={onClose} className="lg:hidden text-dark-400 hover:text-dark-200 p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main nav */}
        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
          <p className="px-3 pt-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-dark-600">
            Main
          </p>
          {mainNav.map((item) => (
            <NavItem key={item.href} {...item} />
          ))}

          {/* Manage section - collapsible */}
          <button
            onClick={() => setManageOpen(!manageOpen)}
            className="flex items-center justify-between w-full px-3 pt-5 pb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-dark-600 hover:text-dark-400 transition-colors"
          >
            Manage
            <ChevronDown className={cn(
              "h-3 w-3 transition-transform duration-200",
              !manageOpen && "-rotate-90"
            )} />
          </button>
          {manageOpen && manageNav.map((item) => (
            <NavItem key={item.href} {...item} />
          ))}
        </nav>

        {/* Footer */}
        <div className="mx-3 mb-3 rounded-xl bg-gradient-to-br from-accent/10 via-dark-900 to-violet-500/5 border border-accent/10 p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-8 w-8 rounded-lg bg-accent/20 flex items-center justify-center">
              <Shield className="h-4 w-4 text-accent" />
            </div>
            <div>
              <p className="text-xs font-semibold text-dark-200">HQAdz Pro</p>
              <p className="text-[10px] text-dark-600">v2.0 · Admin</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
