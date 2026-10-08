import { Button } from "@/components/ui/button";
import { useSessionExpired } from "@/lib/session-expired";

export function SessionExpiredBanner() {
  const expired = useSessionExpired();
  if (!expired) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b bg-warning px-4 py-2 text-sm font-medium text-warning-foreground sm:px-6 lg:px-8"
    >
      <span>Your session expired.</span>
      <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
