import { Button } from "@/components/ui/button";

/** Root route errorElement: renders without the shell, never the RR default. */
export default function RouteError() {
  return (
    <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">The page failed to load. Reloading usually fixes it.</p>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
