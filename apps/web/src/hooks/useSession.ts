import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, ApiError, type Session } from "@/api";

/** Sesión actual. `data === null` significa "no ha iniciado sesión". */
export function useSession() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        return await api.get<Session>("/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Cualquier 401 de la API (sesión caducada) lleva a la pantalla de login.
  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(["session"], null);
    window.addEventListener("rag:unauthorized", onUnauthorized);
    return () => window.removeEventListener("rag:unauthorized", onUnauthorized);
  }, [qc]);

  return query;
}

/** Usuario actual (solo usar dentro de páginas protegidas). */
export function useCurrentUser() {
  const { data } = useSession();
  if (!data) throw new Error("useCurrentUser fuera de una sesión");
  return data;
}
