import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";

export interface Quota {
  used: number;
  /** Preguntas permitidas por día; 0 = sin límite. */
  limit: number;
  level: "ok" | "warn" | "full" | "unlimited";
  warnPercent: number;
}

/** Cuota diaria de preguntas de la organización (para avisar antes de llegar al tope). */
export function useQuota() {
  return useQuery({ queryKey: ["quota"], queryFn: () => api.get<Quota>("/quota"), staleTime: 60_000 });
}
