import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { Radio, Eye, BellRing, HeartPulse, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession, isOperator } from "@/lib/session";
import { LogoutButton } from "@/components/LogoutButton";
import { LogoMark } from "@/components/LogoMark";
import { SessionExpiredBanner } from "@/components/SessionExpiredBanner";
import { pageTitle } from "@/lib/page-title";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LiveProvider, useLive } from "@/api/ws";
import { useUnseenMatches } from "@/api/queries";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Order matters: operator-only items are last so the mobile bottom nav's first
// 4 slots are always the items every role can reach; the rest go in "More".
const NAV_ITEMS = [
  { to: "/matches", label: "Matches", icon: BellRing, operatorOnly: false, group: "Monitoring" },
  { to: "/watches", label: "Watches", icon: Eye, operatorOnly: false, group: "Monitoring" },
  { to: "/sources", label: "Sources", icon: Radio, operatorOnly: false, group: "Monitoring" },
  { to: "/health", label: "Health", icon: HeartPulse, operatorOnly: false, group: "Monitoring" },
];

const BOTTOM_NAV_MAX_PRIMARY = 4;

/** Unread-matches pill: hidden at 0, "9+" above nine. */
function UnreadBadge({ count, noun = "matches" }: { count: number; noun?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} unread ${noun}`}
      className="absolute -right-2 -top-1.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] font-semibold leading-4 text-destructive-foreground"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function WsStatus({ status }: { status: "connecting" | "open" | "closed" }) {
  const label = status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  const dotClass = status === "open" ? "bg-success" : status === "connecting" ? "bg-muted-foreground" : "bg-warning";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </span>
  );
}

function SidebarNavLink({ to, label, icon: Icon, collapsed, badge = 0 }: { to: string; label: string; icon: typeof BellRing; collapsed: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
          collapsed && "justify-center px-0",
          isActive
            ? "bg-primary/10 text-foreground"
            : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative shrink-0">
            <Icon className={cn("h-5 w-5", isActive && "text-primary")} aria-hidden="true" />
            <UnreadBadge count={badge} noun="matches" />
          </span>
          {!collapsed ? <span className="truncate">{label}</span> : null}
        </>
      )}
    </NavLink>
  );
}

function BrandMark({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn("mb-4 flex items-center gap-2 px-2", collapsed && "justify-center px-0")}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <LogoMark className="h-4 w-4" />
      </span>
      {!collapsed ? <span className="truncate text-base font-semibold">Feedhound</span> : null}
    </div>
  );
}

export function AppShell() {
  return (
    <LiveProvider>
      <AppShellContent />
    </LiveProvider>
  );
}

function AppShellContent() {
  const { me, needsLogin } = useSession();
  const { status } = useLive();
  // Mounted once here, so it refetches on load and on every WS reconnect
  // (invalidateAfterReconnect) and the badge stays fresh everywhere.
  const { data: unseenCount } = useUnseenMatches();
  const location = useLocation();
  useEffect(() => {
    document.title = pageTitle(location.pathname, unseenCount ?? 0);
  }, [location.pathname, unseenCount]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(location.pathname);
  if (location.pathname !== prevPathname) {
    setPrevPathname(location.pathname);
    setMoreOpen(false);
  }
  const items = NAV_ITEMS.filter((item) => !item.operatorOnly || isOperator(me));
  const primaryItems = items.length > BOTTOM_NAV_MAX_PRIMARY ? items.slice(0, BOTTOM_NAV_MAX_PRIMARY) : items;
  const restItems = items.length > BOTTOM_NAV_MAX_PRIMARY ? items.slice(BOTTOM_NAV_MAX_PRIMARY) : [];
  const isRestActive = restItems.some((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
  const currentItem = [...items]
    .sort((a, b) => b.to.length - a.to.length)
    .find((i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`));
  const currentLabel = currentItem?.label ?? "Feedhound";
  const currentGroup = currentItem?.group ?? "";

  if (needsLogin) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {/* Sidebar >=1024px */}
      <aside className="sticky top-0 z-30 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r bg-card p-4 lg:flex">
        <BrandMark collapsed={false} />
        <nav className="flex flex-1 flex-col gap-1" aria-label="Primary">
          {items.map((item) => (
            <SidebarNavLink key={item.to} {...item} collapsed={false} badge={item.to === "/matches" ? unseenCount ?? 0 : 0} />
          ))}
        </nav>
        <LogoutButton collapsed={false} />
      </aside>

      {/* Icon rail 768-1023px */}
      <aside className="sticky top-0 z-30 hidden h-dvh w-16 shrink-0 flex-col items-center overflow-y-auto border-r bg-card py-4 md:flex lg:hidden">
        <BrandMark collapsed />
        <nav className="flex flex-1 flex-col items-center gap-1" aria-label="Primary">
          {items.map((item) => (
            <SidebarNavLink key={item.to} {...item} collapsed badge={item.to === "/matches" ? unseenCount ?? 0 : 0} />
          ))}
        </nav>
        <LogoutButton collapsed />
      </aside>

      <div className="flex h-dvh min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="sticky top-0 z-20">
        <SessionExpiredBanner />
        {/* Topbar 56px */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-card px-4 sm:px-6 lg:px-8">
          <span className="truncate text-sm font-semibold md:hidden">{currentLabel}</span>
          <span className="hidden truncate text-xs font-medium uppercase tracking-wide text-muted-foreground md:inline">{currentGroup}</span>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <WsStatus status={status} />
            {me ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-medium uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    {me.email.slice(0, 1)}
                    <span className="sr-only">User menu</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48 p-3 text-xs">
                  <p className="truncate font-medium">{me.email}</p>
                  <p className="mt-0.5 text-muted-foreground">{me.role}</p>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </header>
        </div>

        <main
          className={cn(
            "mx-auto w-full min-w-0 flex-1 px-4 py-4 pb-24 sm:px-6 sm:py-6 md:pb-6 lg:px-8 lg:py-8",
            "max-w-[1280px]",
          )}
        >
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* Bottom nav <768px */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-14 justify-around border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Primary"
      >
        {primaryItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            aria-label={label}
            className={({ isActive }) =>
              cn(
                "flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
                isActive ? "text-foreground" : "text-muted-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative shrink-0">
                  <Icon className={cn("h-5 w-5", isActive && "text-primary")} aria-hidden="true" />
                  {to === "/matches" ? <UnreadBadge count={unseenCount ?? 0} /> : null}
                </span>
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
        {restItems.length > 0 ? (
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="More"
                aria-current={isRestActive ? "page" : undefined}
                className={cn(
                  "flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
                  isRestActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <MoreHorizontal className={cn("h-5 w-5", isRestActive && "text-primary")} aria-hidden="true" />
                <span>More</span>
              </button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle>More</SheetTitle>
              <nav className="flex flex-col gap-1" aria-label="More">
                {restItems.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    aria-label={label}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-md px-3 py-3 text-sm font-medium",
                        isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-surface-2",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon className={cn("h-5 w-5", isActive && "text-primary")} aria-hidden="true" />
                        {label}
                      </>
                    )}
                  </NavLink>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        ) : null}
      </nav>
    </div>
  );
}
