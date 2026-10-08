import { Button } from "@/components/ui/button";

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
}

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <p className="text-sm font-medium text-destructive">Unable to load</p>
      <p className="max-w-sm text-sm text-muted-foreground">{messageFor(error)}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
