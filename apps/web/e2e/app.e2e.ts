import { expect, test, type Page } from "@playwright/test";
import { readState } from "./helpers";

/*
 * Recorrido principal de un administrador de organización, con la interfaz real: entrar, subir un documento, enviarlo a
 * la papelera y restaurarlo, ver sus sesiones, preguntar en el chat (solo con E2E_CHAT=1: gasta una petición del modelo)
 * y cerrar sesión. Las pruebas van en orden y comparten la organización temporal de global-setup.
 */
test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const docName = `nota-e2e-${stamp}.txt`;
const docTitle = `nota-e2e-${stamp}`;

async function login(page: Page, user = readState().username, password = readState().password) {
  await page.goto("/login");
  await page.getByLabel("Usuario o correo").fill(user);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("rechaza una contraseña incorrecta", async ({ page }) => {
  await login(page, readState().username, "no-es-la-clave-123");
  await expect(page.getByText("Usuario o contraseña incorrectos")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("entra y llega al chat", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByPlaceholder("Escribe tu pregunta…")).toBeVisible();
});

test("sube un documento y se procesa", async ({ page }) => {
  await login(page);
  await page.goto("/documentos");
  const text = `Nota interna ${stamp}: la reunión anual de la empresa es el 12 de marzo en la sala Andes.`;
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: docName, mimeType: "text/plain", buffer: Buffer.from(text) });
  await expect(page.getByText(/1 archivo en cola para procesar/)).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: docTitle });
  await expect(row).toBeVisible();
  await expect(row.getByText("Listo")).toBeVisible({ timeout: 120_000 });
});

test("envía el documento a la papelera y lo restaura", async ({ page }) => {
  await login(page);
  await page.goto("/documentos");
  await page.getByRole("checkbox", { name: `Seleccionar «${docTitle}»` }).click();
  await page.getByRole("button", { name: "Enviar a la papelera" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Enviar 1 a la papelera" }).click();
  await expect(page.getByText("1 documento enviado a la papelera")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: docTitle })).toHaveCount(0);

  await page.getByRole("link", { name: "Papelera" }).click();
  const trashed = page.getByRole("row").filter({ hasText: docTitle });
  await expect(trashed).toBeVisible();
  await trashed.getByRole("button", { name: "Restaurar" }).click();
  await expect(trashed).toHaveCount(0);

  await page.goto("/documentos");
  await expect(page.getByRole("row").filter({ hasText: docTitle })).toBeVisible();
});

test("Mi cuenta muestra la sesión actual", async ({ page }) => {
  await login(page);
  await page.goto("/cuenta");
  await expect(page.getByText("Esta sesión")).toBeVisible();
});

test("responde en el chat con una cita del documento", async ({ page }) => {
  test.skip(process.env.E2E_CHAT !== "1", "E2E_CHAT=1 para probar el chat (gasta una petición del modelo)");
  test.setTimeout(120_000);
  await login(page);
  await page.getByPlaceholder("Escribe tu pregunta…").fill("¿Cuándo es la reunión anual de la empresa?");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByText(/12 de marzo/).last()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/Fuentes (citadas|consultadas)/)).toBeVisible();
});

test("cierra sesión", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/chat/);
  await page.getByRole("button", { name: /Admin E2E/ }).click();
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL(/\/login/);
  // La sesión queda revocada: volver atrás no reabre la aplicación.
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/login/);
});
