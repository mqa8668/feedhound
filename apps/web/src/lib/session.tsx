import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useMe } from "@/api/queries";
import { api, ApiError } from "@/api/client";
import type { MeDto } from "@/api/types";

export type AuthMode = "local" | "cf-access";

export interface AuthStatus {
  mode: AuthMode;
  authenticated: boolean;
}

interface SessionContextValue {
  me: MeDto | undefined;
  isLoading: boolean;
  error: ApiError | null;
  /** `local` or `cf-access`; undefined until `/api/auth/status` answers. */
  authMode: AuthMode | undefined;
  /** Local mode and the visitor has no valid session: send them to /login. */
  needsLogin: boolean;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function useAuthStatus() {
  return useQuery({ queryKey: ["auth-status"], queryFn: () => api.get<AuthStatus>("/auth/status"), retry: false, staleTime: 60_000 });
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading, error } = useMe();
  const status = useAuthStatus();
  const apiError = error instanceof ApiError ? error : null;
  const authMode = status.data?.mode;
  const needsLogin = authMode === "local" && !data && (apiError?.status === 401 || status.data?.authenticated === false);
  const value = React.useMemo<SessionContextValue>(
    () => ({ me: data, isLoading, error: apiError, authMode, needsLogin }),
    [data, isLoading, apiError, authMode, needsLogin],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

export function isOperator(me: MeDto | undefined): boolean {
  return me?.role === "operator";
}
