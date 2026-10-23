import { describe, expect, it } from "vitest";
import { describeDevice } from "./device";

describe("describeDevice", () => {
  it("reconoce navegadores y sistemas habituales", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toEqual({ label: "Chrome en Windows", mobile: false });
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toEqual({ label: "Edge en Windows", mobile: false });
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toEqual({ label: "Firefox en Linux", mobile: false });
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toEqual({ label: "Safari en iOS", mobile: true });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toEqual({ label: "Chrome en Android", mobile: true });
  });

  it("no falla sin User-Agent o con uno desconocido", () => {
    expect(describeDevice(null).label).toBe("Dispositivo desconocido");
    expect(describeDevice("curl/8.0").label).toBe("Dispositivo desconocido");
  });
});
