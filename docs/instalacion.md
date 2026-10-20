# Instalación paso a paso

## 1. Requisitos

| Recurso | Mínimo | Recomendado |
|---|---|---|
| Docker + Docker Compose v2 | Docker 24+ | la última versión |
| RAM libre | 6 GB | 8 GB o más |
| Disco | 8 GB | 20 GB + el tamaño de tus documentos |
| CPU | 4 núcleos | 8 núcleos (la ingesta y el OCR van más rápido) |
| Internet | Para descargar imágenes y el modelo la primera vez, y para OpenRouter | |

Uso medido con el sistema en reposo: embeddings ≈ 3,2 GB, Docling ≈ 1,3 GB y el resto < 200 MB. Docling usa más memoria mientras convierte PDF grandes.

## 2. Configuración (`.env`)

```bash
cp .env.example .env
```

Edita `.env` y cambia al menos:

| Variable | Qué poner |
|---|---|
| `POSTGRES_PASSWORD` | Contraseña larga y aleatoria (dueño de la base de datos) |
| `APP_DB_PASSWORD` | Otra contraseña distinta (usuario `rag_app` de la aplicación) |
| `JWT_SECRET` | Secreto aleatorio de 32 caracteres o más |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Tu cuenta de superadministrador (contraseña de 10 caracteres o más) |
| `OPENROUTER_API_KEY` | Tu clave de OpenRouter (siguiente apartado) |

Para generar secretos:

```bash
openssl rand -base64 48
```

> ⚠️ Cambia `POSTGRES_PASSWORD` **antes** del primer arranque. Después, PostgreSQL ya la tiene guardada en el volumen y cambiarla en `.env` no tiene efecto (ver [operacion.md](operacion.md#cambiar-contraseñas-de-la-base-de-datos)).

El resto de variables están explicadas en `.env.example` y tienen valores por defecto razonables.

## 3. Clave y privacidad en OpenRouter

1. Crea una cuenta en <https://openrouter.ai> y una clave en <https://openrouter.ai/keys>. Pégala en `OPENROUTER_API_KEY`.
2. **Límite diario:** sin compras, los modelos gratuitos admiten **50 peticiones al día** para toda la cuenta. Con una compra única de **10 USD** en créditos sube a **1.000 al día** de forma permanente, y los modelos `:free` no gastan esos créditos. Para uso con clientes es prácticamente imprescindible.
3. **Privacidad:** en <https://openrouter.ai/settings/privacy> se configura qué proveedores se pueden usar. Muchos modelos gratuitos solo están disponibles si se permiten proveedores que pueden **registrar o usar los textos enviados**. Si los bloqueas, verás errores del tipo *"No endpoints found matching your data policy"*.
   - En cada pregunta se envían al LLM **fragmentos de los documentos** del cliente.
   - Si los documentos son confidenciales, valora con tu cliente si esto es aceptable, o usa modelos de pago con política de no retención para esa organización.
   - Los embeddings y la lectura de documentos son locales: esos datos **nunca** salen del servidor.
4. **Modelos:** `LLM_MODELS` es una lista en orden de preferencia; si uno falla o está saturado se prueba el siguiente. Los modelos gratuitos cambian a menudo. Consulta los disponibles en <https://openrouter.ai/models?max_price=0> o con:
   ```bash
   curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"[^"]*:free"'
   ```

## 4. Arrancar

```bash
docker compose up -d --build
docker compose ps          # todos los servicios deben estar "running"
docker compose logs -f api # ver el arranque de la API
```

Al arrancar, la API:
1. aplica las migraciones de la base de datos (crea tablas, políticas y el usuario `rag_app`);
2. si no hay usuarios, crea la organización inicial y tu superadministrador.

El servicio de embeddings descarga el modelo (~1 GB) la primera vez. Comprueba que todo responde:

```bash
curl http://localhost:8000/api/health
# {"ok":true,"services":{"database":"ok","embeddings":"ok","docling":"ok","openrouter":"configurado"}}
```

## 5. Primeros pasos en la interfaz

1. Abre <http://localhost:8000> y entra con `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
2. **Mi cuenta:** cambia la contraseña inicial.
3. **Organizaciones:** crea una organización por cliente, indicando su administrador. Pásale sus credenciales.
4. Como administrador de cada organización (o con tu propia organización):
   - **Documentos → + Nueva colección** (ya existe una llamada *General*).
   - Arrastra archivos. Un PDF de pocas páginas tarda segundos; uno escaneado y largo, minutos.
   - **Usuarios → + Nuevo usuario:** elige el rol y sus colecciones.
5. **Chat:** pregunta. Despliega las fuentes `[1]` para ver el fragmento original.

## 6. Comprobar la instalación con la prueba de humo

```bash
node scripts/smoke-test.mjs --url http://localhost:8000 \
  --email "$SEED_ADMIN_EMAIL" --password "$SEED_ADMIN_PASSWORD" \
  --files ruta/a/un.pdf,ruta/a/otro.docx \
  --question "Una pregunta cuya respuesta esté en esos archivos"
```

Crea dos organizaciones temporales, sube los archivos, comprueba el aislamiento entre ellas y los permisos de un lector, y hace una pregunta real al LLM (gasta 1 petición de OpenRouter; usa `--skip-chat true` para evitarlo). Al terminar desactiva las organizaciones de prueba.

## 7. Acceso desde otras máquinas / HTTPS

Por defecto la web escucha en el puerto `8000` de todas las interfaces. Para usarla en red o en internet:

- Pon delante un proxy con HTTPS (Caddy, Traefik, nginx + Let's Encrypt) que apunte a `:8000`.
- Pon `COOKIE_SECURE=true` y `APP_PUBLIC_URL=https://tu-dominio`.
- Revisa la lista de [operacion.md → Producción](operacion.md#lista-para-producción).
