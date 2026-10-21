import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/pages/LoginPage";

// Cada página se descarga solo cuando se visita (carga inicial más ligera).
const ChatPage = lazy(() => import("@/pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const DocumentsPage = lazy(() => import("@/pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })));
const UsersPage = lazy(() => import("@/pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const UsagePage = lazy(() => import("@/pages/UsagePage").then((m) => ({ default: m.UsagePage })));
const PlatformPage = lazy(() => import("@/pages/PlatformPage").then((m) => ({ default: m.PlatformPage })));
const AccountPage = lazy(() => import("@/pages/AccountPage").then((m) => ({ default: m.AccountPage })));

function FullScreenLoader() {
  return (
    <div className="grid h-full place-items-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
    </div>
  );
}

/** Solo deja pasar si hay sesión (y, opcionalmente, si se cumple una condición de permisos). */
function Protected({ children, allow = true }: { children: ReactNode; allow?: boolean }) {
  const { data, isLoading } = useSession();
  const location = useLocation();
  if (isLoading) return <FullScreenLoader />;
  if (!data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!allow) return <Navigate to="/chat" replace />;
  return <Suspense fallback={<FullScreenLoader />}>{children}</Suspense>;
}

export function App() {
  const { data, isLoading } = useSession();
  const user = data?.user;

  return (
    <Routes>
      <Route path="/login" element={isLoading ? <FullScreenLoader /> : data ? <Navigate to="/chat" replace /> : <LoginPage />} />
      <Route
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/documentos" element={<DocumentsPage />} />
        <Route path="/documentos/:collectionId" element={<DocumentsPage />} />
        <Route path="/usuarios" element={<Protected allow={user?.role === "admin"}><UsersPage /></Protected>} />
        <Route path="/consumo" element={<Protected allow={user?.role === "admin"}><UsagePage /></Protected>} />
        <Route path="/organizaciones" element={<Protected allow={user?.isSuperadmin === true}><PlatformPage /></Protected>} />
        <Route path="/cuenta" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
