import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkError, reloadOnce } from "@/lib/reload";

/** Evita la pantalla en blanco si una página falla: muestra el error y un botón para recargar. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
    if (isChunkError(error)) reloadOnce();
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunk = isChunkError(this.state.error);
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm space-y-3 text-center">
          <TriangleAlert className="mx-auto size-8 text-muted-foreground" />
          <p className="font-medium">{chunk ? "Hay una versión nueva de la aplicación" : "Algo ha fallado al mostrar esta página"}</p>
          <p className="text-sm text-muted-foreground">
            {chunk ? "Recarga la página para usarla." : "Recarga la página. Si vuelve a pasar, avisa al administrador."}
          </p>
          <Button onClick={() => window.location.reload()}>
            <RefreshCw /> Recargar
          </Button>
        </div>
      </div>
    );
  }
}
