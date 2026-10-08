import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

function LogoutButtonInner({ collapsed }: { collapsed: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const onClick = async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      queryClient.clear();
      navigate("/login", { replace: true });
    }
  };
  return (
    <button
      type="button"
      id="logout-button"
      onClick={onClick}
      aria-label="Log out"
      title={collapsed ? "Log out" : undefined}
      className={cn(
        "mt-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
      {!collapsed ? <span>Log out</span> : null}
    </button>
  );
}

/** Sidebar logout; rendered only in local auth mode (Cloudflare Access owns the session otherwise). */
export function LogoutButton({ collapsed }: { collapsed: boolean }) {
  const { authMode } = useSession();
  if (authMode !== "local") return null;
  return <LogoutButtonInner collapsed={collapsed} />;
}
