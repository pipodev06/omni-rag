import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoginPage } from "@/pages/LoginPage";
import { ForgotPasswordPage, LinkPage } from "@/pages/AuthLinkPages";

// Cada página se descarga solo cuando se visita (carga inicial más ligera).
const ChatPage = lazy(() => import("@/pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const DocumentsPage = lazy(() => import("@/pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })));
const UsersPage = lazy(() => import("@/pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const UsagePage = lazy(() => import("@/pages/UsagePage").then((m) => ({ default: m.UsagePage })));
const PlatformPage = lazy(() => import("@/pages/PlatformPage").then((m) => ({ default: m.PlatformPage })));
const QualityPage = lazy(() => import("@/pages/QualityPage").then((m) => ({ default: m.QualityPage })));
const AuditPage = lazy(() => import("@/pages/AuditPage").then((m) => ({ default: m.AuditPage })));
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
  // Con 2FA obligatorio, el superadministrador solo puede ir a Mi cuenta hasta activarlo.
  if (data.mfaSetupRequired && location.pathname !== "/cuenta") return <Navigate to="/cuenta" replace />;
  return (
    <ErrorBoundary>
      <Suspense fallback={<FullScreenLoader />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** Pantalla de login; con sesión iniciada lleva a la página que se quería ver. */
function LoginRoute() {
  const { data, isLoading } = useSession();
  const from = (useLocation().state as { from?: string } | null)?.from;
  if (isLoading) return <FullScreenLoader />;
  // El dueño de la plataforma aterriza en el selector de organizaciones; el resto, en el chat.
  if (data) return <Navigate to={data.mfaSetupRequired ? "/cuenta" : from && from !== "/login" ? from : data.user.isSuperadmin ? "/organizaciones" : "/chat"} replace />;
  return <LoginPage />;
}

export function App() {
  const user = useSession().data?.user;

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/recuperar" element={<ForgotPasswordPage />} />
      <Route path="/activar" element={<LinkPage />} />
      <Route path="/restablecer" element={<LinkPage />} />
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
        <Route path="/calidad" element={<Protected allow={user?.role === "admin"}><QualityPage /></Protected>} />
        <Route path="/auditoria" element={<Protected allow={user?.role === "admin"}><AuditPage /></Protected>} />
        <Route path="/consumo" element={<Protected allow={user?.role === "admin"}><UsagePage /></Protected>} />
        <Route path="/organizaciones" element={<Protected allow={user?.isSuperadmin === true}><PlatformPage /></Protected>} />
        <Route path="/cuenta" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
