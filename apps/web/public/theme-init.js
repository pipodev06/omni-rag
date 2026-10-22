// Aplica el tema (claro/oscuro) ANTES del primer pintado, para que al recargar no haya un
// destello del tema claro. Mantén la misma lógica que `src/lib/theme.tsx` (clave «rag-theme»).
// Es un archivo aparte (no un <script> en línea) porque la CSP solo permite scripts del propio sitio.
(function () {
  try {
    var stored = localStorage.getItem("rag-theme");
    var dark = stored === "dark" || (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    if (dark) root.classList.add("dark");
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {
    /* sin almacenamiento: se queda el tema por defecto */
  }
})();
