/**
 * Descarga un archivo que genera la API (un ZIP, por ejemplo) dejando que el navegador lo guarde directamente en disco,
 * sin cargarlo en memoria. La sesión va en la cookie, así que basta con un enlace.
 */
export function startDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
