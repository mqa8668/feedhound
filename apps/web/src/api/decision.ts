import { useQuery } from "@tanstack/react-query";
import type { Capabilities, FitItem, PriceDistribution } from "@feedhound/core/deal-decision";
import { api, ApiError } from "./client";
import type { PriceQualifier } from "./types";

export interface DecisionDto {
  postId: string;
  capabilities: Capabilities;
  price: { vnd: number | null; qualifier: PriceQualifier | null; suspect: boolean };
  verdict: { text: string; pct: number | null; n: number; medianVnd: number | null; confidence: "high" | "medium" | "low" | null };
  specs: { key: string; label: string; value: string }[];
  comparables: {
    postId: string;
    title: string;
    url: string;
    sourceName: string;
    priceVnd: number;
    deltaPct: number;
    year: number | null;
    odoKm: number | null;
    region: string | null;
    at: string;
  }[];
  distribution: PriceDistribution | null;
  percentile: number | null;
  fit: { watchId: string; watchName: string; items: FitItem[] }[];
  seller: { label: string | null; sellPosts90: number; repostCount: number };
}

const noRetry404 = (count: number, err: unknown): boolean => !(err instanceof ApiError && err.status === 404) && count < 2;

export function useDecision(id: string | undefined) {
  return useQuery({
    queryKey: ["decision", id],
    queryFn: () => api.get<DecisionDto>(`/posts/${id}/decision`),
    enabled: Boolean(id),
    retry: noRetry404,
  });
}

