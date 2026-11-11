# Instalación paso a paso

## 1. Requisitos

| Recurso | Mínimo | Recomendado |
|---|---|---|
| Docker + Docker Compose v2 | Docker 24+ | la última versión |
| RAM para Docker | 6 GB (perfil Pequeño, sin re-ranker) | **8 GB** (perfil Mediano, por defecto) |
| Disco | 20 GB | 40 GB + 2–3 veces el tamaño de tus documentos |
| CPU | 2 núcleos x86-64 (4 para el perfil Mediano) | 4–8 núcleos |
| Internet | Para descargar imágenes y modelos la primera vez, y para OpenRouter | |

Medido con todo en marcha: ≈ 5,2 GB en reposo y ≈ 6,9 GB de pico (procesando un PDF de 30 páginas mientras se pregunta). Detalle por servicio, perfiles Pequeño / Mediano / Grande (`bash deploy/perfil.sh mediano`) y recomendaciones de VPS en **[requisitos.md](requisitos.md)**.

### Windows

- Instala **Docker Desktop** con el motor **WSL 2** y ábrelo antes de usar `docker`. Si `docker version` no muestra la sección *Server*, el motor no está en marcha: abre Docker Desktop y espera a *Engine running*. Si no arranca, ejecuta `wsl --update` y `wsl --shutdown` en PowerShell y vuelve a abrirlo.
- Docker (WSL 2) usa por defecto la mitad de la RAM. Para fijar 8 GB (suficiente para la configuración por defecto), crea `C:\Users\<usuario>\.wslconfig` con estas líneas y ejecuta `wsl --shutdown`:
  ```ini
  [wsl2]
  memory=8GB
  swap=4GB
  processors=4
  ```
- Usa `curl.exe` en lugar de `curl` en PowerShell.
- PostgreSQL no arranca sobre una carpeta de un disco de Windows: antes del primer arranque, `Copy-Item docker-compose.volumenes.example.yml docker-compose.override.yml` para usar volúmenes de Docker.
- Si aparece `ports are not available ... Intento de acceso a un socket no permitido`, el puerto está ocupado o reservado por Windows: crea un `.env` con `WEB_PORT`, `DB_PORT` o `EMBEDDINGS_PORT` distintos.

## 2. Arrancar sin configurar nada

```bash
docker compose up -d
docker compose logs api | grep -A2 "CONFIGURACIÓN INICIAL"   # el código de un solo uso
```

No hace falta `.env`. En el primer arranque:

1. Al arrancar la base de datos se generan las contraseñas internas de la base de datos y la clave de las sesiones (`JWT_SECRET`), y se guardan en `./data/secretos`, junto a los demás datos (`./data/postgres`, `./data/uploads`…). **Guarda esa carpeta**: no va en las copias de seguridad.
2. La API aplica las migraciones y, como aún no hay usuarios, escribe en sus registros un **código de un solo uso**.
3. Abre <http://localhost:8000>: en lugar del login sale la **Configuración inicial**. Escribe el código, tu usuario y tu contraseña: se crea el superadministrador (en la organización interna «Plataforma», que no es un cliente) y entras.
4. En **Organizaciones** aparece la lista **Primeros pasos**: clave de un proveedor de modelos de lenguaje (lo único imprescindible), modelos de los planes, correo, copias fuera del servidor y la primera organización. Todo se hace en la web, en *Sistema → Configuración* y *Sistema → Copias*.

Qué valores son imprescindibles, cuáles se recomiendan y por qué tienen el valor por defecto que tienen: **[configuracion-inicial.md](configuracion-inicial.md)**.

**El `.env` es opcional.** Sirve para fijar valores (lo escrito ahí manda y sale bloqueado en la pantalla) y para lo que no está en la pantalla: dominio, puertos, recursos, modelo de embeddings. Se crea con `cp .env.example .env`. Una instalación automatizada puede crear el superadministrador con `SEED_ADMIN_USERNAME` y `SEED_ADMIN_PASSWORD` en vez de la pantalla.

> Una instalación anterior que ya tenía `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` y `JWT_SECRET` en el `.env` sigue igual: lo escrito manda sobre lo generado. No las borres del `.env`: la base seguiría con las antiguas.

## 3. Clave y privacidad en OpenRouter

> OpenRouter es el proveedor de LLM por defecto. Si prefieres Groq, Google, OpenAI, DeepSeek o un servidor propio (o varios a la vez, con respaldo entre ellos), mira [operacion.md → Proveedores de LLM](operacion.md#proveedores-de-llm-openrouter-groq-google-openai-deepseek-servidor-propio).

1. Crea una cuenta en <https://openrouter.ai> y una clave en <https://openrouter.ai/keys>. Pégala en *Sistema → Configuración → Modelos de lenguaje* (o en `OPENROUTER_API_KEY` del `.env`).
2. **Límite diario:** sin compras, los modelos gratuitos admiten **50 peticiones al día** para toda la cuenta. Con una compra única de **10 USD** en créditos sube a **1.000 al día** de forma permanente, y los modelos `:free` no gastan esos créditos. Para uso con clientes es prácticamente imprescindible.
3. **Privacidad:** en <https://openrouter.ai/settings/privacy> se configura qué proveedores se pueden usar. Muchos modelos gratuitos solo están disponibles si se permiten proveedores que pueden **registrar o usar los textos enviados**. Si los bloqueas, verás errores del tipo *"No endpoints found matching your data policy"*.
   - En cada pregunta se envían al LLM **fragmentos de los documentos** del cliente.
   - Si los documentos son confidenciales, valora con tu cliente si esto es aceptable, o usa modelos de pago con política de no retención para esa organización.
   - Los embeddings y la lectura de documentos son locales: esos datos **nunca** salen del servidor.
4. **Modelos:** `LLM_MODELS` es una lista en orden de preferencia; si uno falla o está saturado se prueba el siguiente. Los modelos gratuitos cambian a menudo. Consulta los disponibles en <https://openrouter.ai/models?max_price=0> o con:
   ```bash
   curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"[^"]*:free"'
   ```

## 4. Construir las imágenes en la propia máquina (opcional)

`docker compose up -d` descarga las imágenes ya hechas (`ghcr.io/pipodev06/omni-rag-*`). Para construirlas desde el código (desarrollo o una máquina sin acceso a GHCR):

```bash
docker compose up -d --build
docker compose ps          # todos los servicios deben estar "running"
docker compose logs -f api # ver el arranque de la API
```

Si el build falla con `EAI_AGAIN registry.npmjs.org` (el DNS del servidor es solo IPv6 y la red de build de Docker no lo alcanza), usa en su lugar `sh deploy/build.sh`: construye las imágenes con la red del servidor y luego levanta todo. No sirve poner `network: host` en el compose, porque `docker compose` lo ejecuta con buildx bake, que exige un permiso que no puede pasar.

Con un enlace lento (descargas de unos 50 KB/s) el build tarda más y `build.sh` ya usa descargas más prudentes y más reintentos de `pnpm` (`PNPM_NETWORK_CONCURRENCY`, `PNPM_FETCH_RETRIES`). Antes de construir, `build.sh` comprueba que el servidor resuelve `registry.npmjs.org` y, si no, avisa. La solución permanente es fijar un DNS por IPv4 en el servidor (no en el proyecto):

```bash
sudo mkdir -p /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNS=1.1.1.1 8.8.8.8\nFallbackDNS=1.0.0.1 8.8.4.4\nDomains=~.\n' | sudo tee /etc/systemd/resolved.conf.d/dns-ipv4.conf
sudo systemctl restart systemd-resolved
```

Los contenedores ya salen con Cloudflare y Google por defecto (`DNS_PRIMARY`, `DNS_SECONDARY`).

Al arrancar, la API:
1. aplica las migraciones de la base de datos (crea tablas, políticas y el usuario `rag_app`);
2. si no hay usuarios, escribe el código de la configuración inicial en sus registros (o, con `SEED_ADMIN_*` en el `.env`, crea directamente el superadministrador).

El servicio de embeddings descarga el modelo (~1 GB) la primera vez. Comprueba que todo responde:

```bash
curl http://localhost:8000/api/health
# {"ok":true,"services":{"database":"ok","embeddings":"ok","docling":"ok","openrouter":"configurado"}}
```

## 5. Primeros pasos en la interfaz

1. Abre <http://localhost:8000> y completa la configuración inicial (apartado 2).
2. **Organizaciones → Primeros pasos:** escribe la clave de un proveedor de modelos y revisa los modelos del plan.
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
