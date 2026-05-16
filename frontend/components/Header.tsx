"use client";
import { signOut, useSession } from "next-auth/react";
import { LogOut, Menu, ChevronDown } from "lucide-react";
import { usePathname } from "next/navigation";

const pageTitles: Record<string, string> = {
  "/admin": "Dashboard",
  "/admin/adbots": "AdBots",
  "/admin/sessions": "Sessions",
  "/admin/groups": "Groups",
  "/admin/payments": "Payments",
  "/admin/plans": "Plans",
  "/admin/broadcast": "Broadcast",
  "/admin/settings": "Settings",
};

interface HeaderProps {
  onMenuToggle: () => void;
}

export default function Header({ onMenuToggle }: HeaderProps) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const title = Object.entries(pageTitles).find(([k]) =>
    k === "/admin" ? pathname === "/admin" : pathname.startsWith(k)
  )?.[1] || "Admin";

  const userName = session?.user?.name || "Admin";
  const initials = userName.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);

  return (
    <header className="sticky top-0 z-30 border-b border-dark-700/30 bg-dark-950/90 backdrop-blur-xl">
      <div className="flex items-center justify-between px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuToggle}
            className="lg:hidden text-dark-400 hover:text-dark-200 p-1.5 -ml-1.5 rounded-lg hover:bg-dark-800 transition-colors"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h2 className="text-lg sm:text-xl font-semibold text-dark-100">{title}</h2>
        </div>

        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-accent/80 to-violet-500 flex items-center justify-center text-white text-xs font-bold shadow-md shadow-accent/10">
            {initials}
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-medium text-dark-200 leading-tight">{userName}</p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="p-1.5 rounded-lg text-dark-500 hover:text-dark-300 hover:bg-dark-800/50 transition-all"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
