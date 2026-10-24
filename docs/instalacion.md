# Instalación paso a paso

## 1. Requisitos

| Recurso | Mínimo | Recomendado |
|---|---|---|
| Docker + Docker Compose v2 | Docker 24+ | la última versión |
| RAM para Docker | 6 GB (sin re-ranker) | **8 GB** (configuración por defecto) |
| Disco | 20 GB | 40 GB + 2–3 veces el tamaño de tus documentos |
| CPU | 4 núcleos x86-64 | 4–8 núcleos |
| Internet | Para descargar imágenes y modelos la primera vez, y para OpenRouter | |

Medido con todo en marcha: ≈ 5,2 GB en reposo y ≈ 6,9 GB de pico (procesando un PDF de 30 páginas mientras se pregunta). Detalle por servicio, perfiles para 6/8/16 GB y recomendaciones de VPS en **[requisitos.md](requisitos.md)**.

### Windows

- Instala **Docker Desktop** con el motor **WSL 2** y ábrelo antes de usar `docker`. Si `docker version` no muestra la sección *Server*, el motor no está en marcha: abre Docker Desktop y espera a *Engine running*. Si no arranca, ejecuta `wsl --update` y `wsl --shutdown` en PowerShell y vuelve a abrirlo.
- Docker (WSL 2) usa por defecto la mitad de la RAM. Para fijar 8 GB (suficiente para la configuración por defecto), crea `C:\Users\<usuario>\.wslconfig` con estas líneas y ejecuta `wsl --shutdown`:
  ```ini
  [wsl2]
  memory=8GB
  swap=4GB
  processors=4
  ```
- En PowerShell: `Copy-Item .env.example .env` y `notepad .env`. Para generar secretos: `[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))`. Usa `curl.exe` en lugar de `curl`.
- Si aparece `ports are not available ... Intento de acceso a un socket no permitido`, el puerto está ocupado o reservado por Windows: cambia `WEB_PORT`, `DB_PORT`, o `EMBEDDINGS_PORT` en `.env`.

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
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | Tu cuenta de superadministrador (contraseña de 10 caracteres o más). `SEED_ADMIN_EMAIL` es opcional; si no defines el usuario, se toma la parte del email anterior a `@` |
| `OPENROUTER_API_KEY` | Tu clave de OpenRouter (siguiente apartado) |

Para generar secretos:

```bash
openssl rand -base64 48
```

> ⚠️ Cambia `POSTGRES_PASSWORD` **antes** del primer arranque. Después, PostgreSQL ya la tiene guardada en el volumen y cambiarla en `.env` no tiene efecto (ver [operacion.md](operacion.md#cambiar-contraseñas-de-la-base-de-datos)).

El resto de variables están explicadas en `.env.example` y tienen valores por defecto razonables.

## 3. Clave y privacidad en OpenRouter

> OpenRouter es el proveedor de LLM por defecto. Si prefieres Groq, Google, OpenAI, DeepSeek o un servidor propio (o varios a la vez, con respaldo entre ellos), mira [operacion.md → Proveedores de LLM](operacion.md#proveedores-de-llm-openrouter-groq-google-openai-deepseek-servidor-propio).

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

Si el build falla con `EAI_AGAIN registry.npmjs.org` (el DNS del servidor es solo IPv6 y la red de build de Docker no lo alcanza), usa en su lugar `sh deploy/build.sh`: construye las imágenes con la red del servidor y luego levanta todo. No sirve poner `network: host` en el compose, porque `docker compose` lo ejecuta con buildx bake, que exige un permiso que no puede pasar.

Al arrancar, la API:
1. aplica las migraciones de la base de datos (crea tablas, políticas y el usuario `rag_app`);
2. si no hay usuarios, crea tu superadministrador en la organización interna «Plataforma» (no es un cliente y no se puede borrar).

El servicio de embeddings descarga el modelo (~1 GB) la primera vez. Comprueba que todo responde:

```bash
curl http://localhost:8000/api/health
# {"ok":true,"services":{"database":"ok","embeddings":"ok","docling":"ok","openrouter":"configurado"}}
```

## 5. Primeros pasos en la interfaz

1. Abre <http://localhost:8000> y entra con `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`.
2. **Mi cuenta:** cambia la contraseña inicial.
3. **Organizaciones:** crea una organización por cliente (también la tuya para probar), con el nombre que quieras y su administrador. Pásale sus credenciales. Entras en cualquiera con «Entrar como soporte»; tu cuenta no pertenece a ninguna.
4. Como administrador de cada organización (o entrando como soporte):
   - **Documentos → + Nueva colección** (ya existe una llamada *General*).
   - Arrastra archivos. Un PDF de pocas páginas tarda segundos; uno escaneado y largo, minutos.
   - **Usuarios → + Nuevo usuario:** elige el rol y sus colecciones.
5. **Chat:** pregunta. Despliega las fuentes `[1]` para ver el fragmento original.

## 6. Comprobar la instalación con la prueba de humo

```bash
node scripts/smoke-test.mjs --url http://localhost:8000 \
  --email "$SEED_ADMIN_USERNAME" --password "$SEED_ADMIN_PASSWORD" \
  --files ruta/a/un.pdf,ruta/a/otro.docx \
  --question "Una pregunta cuya respuesta esté en esos archivos"
```

Crea dos organizaciones temporales, sube los archivos, comprueba el aislamiento entre ellas y los permisos de un lector, y hace una pregunta real al LLM (gasta 1 petición de OpenRouter; usa `--skip-chat true` para evitarlo). Al terminar desactiva las organizaciones de prueba.

## 7. Probar los correos en local (opcional)

Para ver los correos de invitación y de "¿Olvidaste la contraseña?" sin enviarlos de verdad, activa Mailpit en `.env`:

```
COMPOSE_PROFILES=correo-pruebas
SMTP_HOST=mailpit
SMTP_PORT=1025
```

`docker compose up -d` y abre la bandeja en <http://localhost:8025>. Sin correo configurado todo funciona igual: al invitar a alguien verás el enlace para copiarlo.

## 8. Publicarlo con tu dominio y HTTPS

Cuando tengas un servidor y un dominio, solo hay que cambiar `.env` (`DOMAIN`, `COMPOSE_PROFILES=https`…): **[produccion.md](produccion.md)**.
