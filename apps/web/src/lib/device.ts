/** Describe el dispositivo de una sesión a partir del User-Agent: «Chrome en Windows». */
export function describeDevice(userAgent: string | null): { label: string; mobile: boolean } {
  if (!userAgent) return { label: "Dispositivo desconocido", mobile: false };
  const browser =
    /Edg\//.test(userAgent) ? "Edge"
    : /OPR\/|Opera/.test(userAgent) ? "Opera"
    : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : null;
  const os =
    /Android/.test(userAgent) ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
    : /CrOS/.test(userAgent) ? "ChromeOS"
    : /Linux/.test(userAgent) ? "Linux"
    : null;
  const mobile = os === "Android" || os === "iOS";
  if (browser && os) return { label: `${browser} en ${os}`, mobile };
  return { label: browser ?? os ?? "Dispositivo desconocido", mobile };
}
