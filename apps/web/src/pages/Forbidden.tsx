import { useSession } from "@/lib/session";

export default function Forbidden() {
  const { error } = useSession();
  const notProvisioned = error?.code === "not_provisioned";

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-xl font-semibold">403 — Forbidden</h1>
      <p className="text-sm text-muted-foreground">
        {notProvisioned ? "Ask an operator to add you." : "You do not have access to this page."}
      </p>
    </div>
  );
}
