import { Link, useLocation } from "react-router-dom";

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="max-w-full break-all font-mono text-sm text-muted-foreground">{pathname}</p>
      <Link to="/" className="mt-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
        Back to Overview
      </Link>
    </div>
  );
}
