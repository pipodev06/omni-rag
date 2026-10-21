import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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

/**
 * Cierra la sesión en la interfaz. Primero se marca "sin sesión" y después se
 * descartan los datos del usuario anterior. No usar `qc.clear()`: borraría la
 * consulta de sesión que están observando las rutas, y unas verían la sesión
 * vieja y otras ninguna (bucle infinito entre /login y /chat).
 */
export function clearSession(qc: QueryClient) {
  qc.setQueryData(["session"], null);
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
}

/**
 * Cambia de organización (entrar o salir del modo soporte). Se recarga la
 * página entera para que nada (datos en memoria, avisos en tiempo real) se
 * quede con la organización anterior.
 */
export function switchOrganization(to = "/chat") {
  window.location.assign(to);
}

/** Usuario actual (solo usar dentro de páginas protegidas). */
export function useCurrentUser() {
  const { data } = useSession();
  if (!data) throw new Error("useCurrentUser fuera de una sesión");
  return data;
}
