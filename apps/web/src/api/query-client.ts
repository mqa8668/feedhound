import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { markSessionExpired } from "@/lib/session-expired";

const isExpired = (error: unknown): boolean => error instanceof ApiError && error.code === "session_expired";

function onError(error: unknown): void {
  if (isExpired(error)) markSessionExpired();
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => !isExpired(error) && failureCount < 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
