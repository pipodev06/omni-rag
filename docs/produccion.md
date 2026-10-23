# Pasar a producción con un dominio

El sistema ya está preparado: para publicarlo con tu dominio y HTTPS **solo se cambia `.env`**, sin tocar el código. Caddy obtiene y renueva automáticamente el certificado de Let's Encrypt.

```
Internet ──443──▶ caddy (HTTPS) ──▶ web (nginx) ──▶ api / worker / …
```

## Resumen: qué cambiar en `.env`

| Variable | Desarrollo local | Producción |
|---|---|---|
| `DOMAIN` | *(vacío)* | `rag.tuempresa.com` |
| `COMPOSE_PROFILES` | *(vacío)* | `https` |
| `WEB_BIND` | `0.0.0.0` | `127.0.0.1` (solo se entra por HTTPS) |
| `COOKIE_SECURE` | `auto` | `auto` (se activa sola por HTTPS) |
| `APP_PUBLIC_URL` | *(vacío → http://localhost:8000)* | *(vacío → https://DOMAIN)* |
| `SMTP_*` | vacío o Mailpit | tu proveedor de correo |
| Contraseñas, `JWT_SECRET` | de prueba | **nuevas y aleatorias** |

## Paso a paso

### 1. Servidor

Un VPS **x86-64** con Ubuntu 24.04 y al menos 4 vCPU / 8 GB (ver [requisitos.md](requisitos.md#qué-vps-contratar-cuando-lo-publiques)). Instala Docker:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # cierra sesión y vuelve a entrar
```

Con 8 GB de RAM, añade *swap* para absorber picos:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Cortafuegos: abre solo SSH, 80 y 443.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

> Docker publica sus puertos saltándose `ufw`. Por eso los puertos internos del proyecto escuchan en `127.0.0.1`, y en producción también la web (`WEB_BIND=127.0.0.1`).

### 2. DNS

En tu proveedor de dominio, crea un registro **A** `rag.tuempresa.com → IP del VPS` (y **AAAA** si tienes IPv6). Espera a que resuelva: `ping rag.tuempresa.com`.

### 3. Código y configuración

```bash
git clone <tu-repositorio> omni-rag && cd omni-rag
cp .env.example .env
nano .env
```

Rellena como mínimo:

```
POSTGRES_PASSWORD=<openssl rand -base64 32>
APP_DB_PASSWORD=<otro distinto>
JWT_SECRET=<openssl rand -base64 48>
SEED_ADMIN_USERNAME=tu-usuario
SEED_ADMIN_EMAIL=tu@email.com   # opcional
SEED_ADMIN_PASSWORD=<contraseña fuerte>
OPENROUTER_API_KEY=sk-or-v1-...

DOMAIN=rag.tuempresa.com
COMPOSE_PROFILES=https
WEB_BIND=127.0.0.1
```

Si migras desde tu equipo, puedes copiar tu `.env` local y cambiar solo esas líneas, pero **genera secretos nuevos** para producción.

### 4. Correo (recomendado)

Para enviar invitaciones y "¿Olvidaste la contraseña?" necesitas un servidor SMTP. Valen los de servicios de envío transaccional (Brevo, Mailgun, Amazon SES, Postmark, Resend…) o el SMTP de tu proveedor de correo:

```
SMTP_HOST=smtp.proveedor.com
SMTP_PORT=587
SMTP_SECURE=false        # true si el puerto es 465
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="RAG Tu Empresa <no-reply@tuempresa.com>"
```

Configura SPF y DKIM del dominio remitente según las instrucciones del proveedor, para que los correos no acaben en spam. Sin SMTP todo funciona igual, pero el administrador debe copiar y enviar a mano los enlaces de invitación.

**Valores de los proveedores más usados** (la contraseña va solo en el `.env` del servidor):

| Proveedor | `SMTP_HOST` | Puerto / `SMTP_SECURE` | `SMTP_USER` y `SMTP_PASSWORD` | `SMTP_FROM` |
|---|---|---|---|---|
| **Gmail** (cuenta propia, hasta ~500 envíos/día) | `smtp.gmail.com` | `587` / `false` | tu correo y una **contraseña de aplicación** (requiere verificación en dos pasos en Google; no vale la contraseña normal) | tiene que ser **la misma cuenta de Gmail**, Google reescribe cualquier otro remitente |
| **Brevo** (gratis ~300/día) | `smtp-relay.brevo.com` | `587` / `false` | el *login* SMTP que muestra Brevo (no su API key) y su *clave SMTP* | un remitente o dominio **verificado** en Brevo |
| **Correo de tu dominio** (Zoho, hosting, Google Workspace…) | el que indique el proveedor | `587` / `false` o `465` / `true` | el buzón completo y su contraseña | ese mismo buzón, p. ej. `no-reply@tuempresa.com` |

**Probar antes de invitar a nadie.** Con las variables ya en el `.env` y aplicadas con `docker compose up -d`:

```bash
docker compose exec api node dist/scripts/test-email.js tu@correo.com
```

Comprueba la conexión y las credenciales (`OK` o el error real del servidor) y envía un mensaje de prueba. Si no llega, mira el spam: es lo habitual hasta tener SPF/DKIM.

### 5. Arrancar

```bash
docker compose up -d --build
docker compose logs -f caddy     # verás cómo obtiene el certificado
```

Abre `https://rag.tuempresa.com`, entra con `SEED_ADMIN_USERNAME` y **cambia la contraseña** en *Mi cuenta*.

### 6. Copias de seguridad fuera del servidor

**Las copias automáticas ya existen**: el servicio `backup` guarda cada día en `./backups` la base de datos y los archivos (7 días) y comprueba cada copia restaurándola. Lo que hay que añadir en producción es una **segunda copia fuera del servidor**: si el disco o la máquina se pierden, `./backups` se pierde con ellos.

**Opción integrada (recomendada):** apunta `BACKUP_OFFSITE_DIR` a una carpeta que no esté en ese disco (disco USB, NAS montado o carpeta sincronizada con OneDrive, Drive o Dropbox) y actívala en `.env`:

```bash
BACKUP_OFFSITE=true
BACKUP_OFFSITE_DIR=/mnt/nas/rag-backups          # en Windows: D:/OneDrive/rag-backups
BACKUP_ENCRYPTION_PASSPHRASE=<frase larga y única>
```

Tras cada copia verificada, el servicio la copia allí y borra las de más de `BACKUP_KEEP_DAYS` días. **Pon siempre la frase de cifrado si la carpeta sale a la nube**: las copias contienen los datos de todos tus clientes. Guarda la frase en un gestor de contraseñas; sin ella no se pueden restaurar. Para descifrar una copia:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in db_AAAA-MM-DD_HHMM.dump.enc -out db.dump   # pide la frase
```

**Subirlas a Backblaze B2 (integrado):** el servicio `backup-b2` (rclone) sube cada 6 horas las copias cifradas de `BACKUP_OFFSITE_DIR` a un bucket de B2 y borra de allí las de más de 30 días.

1. En Backblaze, crea un bucket **privado** y una *Application Key* limitada a ese bucket (*App Keys → Add a New Application Key*; no uses la Master Key). Guarda el `keyID` y la `applicationKey`: esta última solo se muestra una vez.
2. En `.env`, además de `BACKUP_OFFSITE=true` y la frase de cifrado:
   ```bash
   COMPOSE_PROFILES=backblaze        # o https,backblaze si usas Caddy
   B2_KEY_ID=<keyID>
   B2_APPLICATION_KEY=<applicationKey>
   B2_BUCKET=<nombre del bucket>
   ```
3. `docker compose up -d` y comprueba con una subida inmediata: `docker compose run --rm backup-b2 --once`. Debe terminar con una línea `[b2] … sincronizado`. Si dice que no hay copias cifradas, falta la frase o aún no corrió ninguna copia (`docker compose exec backup sh /backup.sh --once`).

**Archivos subidos incrementales (recomendado con muchos GB).** Por defecto cada copia incluye un `.tgz` completo de todos los archivos: con 150 GB serían 150 GB nuevos cada día. Con estas dos líneas en el `.env`, la copia diaria lleva solo la base de datos y los archivos se sincronizan aparte, subiendo únicamente lo nuevo:

```bash
BACKUP_UPLOADS_TGZ=false
B2_SYNC_UPLOADS=true
```

- Los archivos viajan **cifrados** (contenido y nombres) con `BACKUP_ENCRYPTION_PASSPHRASE`; en Backblaze solo se ven nombres ilegibles. La frase es obligatoria para esta opción.
- Lo que se **borra en la aplicación** no se borra de Backblaze al instante: pasa a `archive/AAAA-MM-DD` y se conserva `B2_KEEP_DAYS` días (30). En la aplicación no se puede deshacer un borrado; la recuperación se hace así, desde el servidor:
  ```bash
  docker compose run --rm backup-b2 --archive                          # fechas con archivos borrados
  mkdir -p restore
  docker compose run --rm -v "$PWD/restore:/restore" backup-b2 --restore /restore archive/AAAA-MM-DD
  ```
  Dentro de `restore/` aparecen los archivos con su ruta (`<organización>/<documento>/nombre.pdf`). Para volver a tenerlo en la aplicación, súbelo de nuevo desde *Documentos*. Para restaurar solo una parte, añade la ruta: `current/<organización>/<documento>`.
- Un `.tgz` local de los archivos ya no existe en esta modalidad: la única copia de los archivos es la de Backblaze (el disco del servidor es el original).
- La primera sincronización sube todo (150 GB tardan horas); las siguientes, solo los cambios. Si `/uploads` aparece vacío (error de montaje) no se sincroniza nada, para no archivar todo por error.

**Horarios.** Por defecto la copia se hace cada 24 h contando desde que arrancó el contenedor `backup` (y de nuevo al recrearlo) y la subida a B2 cada 6 h. Para fijar la hora (Perú, UTC-5) añade al `.env`:

```bash
BACKUP_AT=03:00     # copia diaria a las 03:00
B2_AT=04:00         # subida diaria a las 04:00, después de la copia
```

`BACKUP_TZ` (por defecto `<-05>5`, Lima) cambia la zona; usa ese formato POSIX, por ejemplo `<-03>3` para Argentina. Con hora fija no se hace copia al arrancar el contenedor; para una inmediata: `docker compose exec backup sh /backup.sh --once`. Aplica con `docker compose up -d`; en los registros aparece `próxima copia a las 03:00 … dentro de N min`. Las marcas de tiempo de los registros y los nombres de archivo siguen en UTC.

Solo se suben archivos `.enc`: sin la frase de cifrado no sale nada del servidor. Para restaurar, baja los dos archivos del bucket (web de Backblaze o `rclone copy`), descífralos con el comando de arriba y sigue [operacion.md](operacion.md#restaurar-una-copia). Si el bucket tiene versiones o reglas de ciclo de vida propias, déjalas en «mantener solo la última versión»: el servicio ya borra definitivamente lo antiguo.

**Opción manual:** copia `./backups` con `rclone` a un almacenamiento S3 compatible o al *storage box* de tu proveedor con una tarea `cron` diaria (`0 4 * * * rclone sync /ruta/rag-project/backups remoto:rag-backups`). Esa copia no va cifrada salvo que lo configures tú.

Prueba alguna vez a restaurar en un servidor limpio (ver [operacion.md](operacion.md#restaurar-una-copia)).

## Si ya tienes un nginx (u otro proxy) en el servidor

Caddy necesita los puertos 80 y 443. Si ya los usa tu nginx, **no actives Caddy**: deja que tu nginx haga el HTTPS y reenvíe el tráfico al contenedor `web`.

**1. En `.env`** (no pongas `COMPOSE_PROFILES=https`):

```
DOMAIN=rag.tuempresa.com        # sigue siendo obligatorio: activa las comprobaciones de producción
COMPOSE_PROFILES=               # vacío: sin Caddy
WEB_BIND=127.0.0.1              # el contenedor solo escucha en este servidor
WEB_PORT=8000                   # cámbialo si el 8000 está ocupado
```

`DOMAIN` es lo que hace que la API exija secretos fuertes y 2FA al superadministrador, fuerce la cookie segura y use `https://DOMAIN` en los enlaces de los correos. Aunque no uses Caddy, hay que ponerlo.

**2. En tu nginx**, un `server` nuevo para el dominio (certificado con `certbot --nginx -d rag.tuempresa.com`):

```nginx
server {
    listen 443 ssl http2;
    server_name rag.tuempresa.com;
    # ssl_certificate / ssl_certificate_key: los añade certbot

    client_max_body_size 500m;                      # subida de documentos
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # SOBRESCRIBE: no uses $proxy_add_x_forwarded_for
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                             # las respuestas del chat llegan en streaming
        proxy_read_timeout 300s;
    }
}
server { listen 80; server_name rag.tuempresa.com; return 301 https://$host$request_uri; }
```

Si tu proxy corre **en Docker** (Nginx Proxy Manager, Traefik…) y solo está en su propia red, no alcanzará a `rag-web-1` y dará 502 (`could not be resolved`). Conecta la web a esa red con `docker-compose.override.example.yml` (cópialo como `docker-compose.override.yml` y apunta el proxy a `rag-web-1:80`). Usa siempre `docker compose up -d` sin `-f`, o el override se ignora.

Por qué cada línea importa:

| Línea | Si falta |
|---|---|
| `X-Forwarded-Proto $scheme` | Los enlaces y la detección de HTTPS fallan (la cookie igualmente va como segura gracias a `DOMAIN`). |
| `X-Forwarded-For $remote_addr` | La auditoría y los límites usarían una IP falsificable por el cliente. |
| `proxy_buffering off` | El chat no se ve palabra a palabra: llega de golpe al final. |
| `client_max_body_size` | Las subidas grandes dan `413`. |
| `Strict-Transport-Security` | Solo Caddy lo añade solo; con tu nginx hay que ponerlo tú. |

No añadas `Content-Security-Policy` ni `X-Frame-Options` en tu nginx: ya las envía la web y se duplicarían. Si tu nginx sirve otras aplicaciones, no toques nada de ellas: el dominio nuevo es un `server` aparte.

## Actualizar a una nueva versión

```bash
cd omni-rag
git pull
docker compose up -d --build
```

Las migraciones de la base de datos se aplican solas al arrancar. Antes de actualizar, haz una copia manual: `docker compose exec backup sh /backup.sh --once`.

## Probar la configuración HTTPS en local

Con `DOMAIN=localhost` y `COMPOSE_PROFILES=https`, Caddy usa un certificado propio de prueba en `https://localhost`. El navegador avisará de que no es de confianza; es normal en local.

## Lista de comprobación

- [ ] `DOMAIN`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en `.env`.
- [ ] Contraseñas y `JWT_SECRET` nuevos y aleatorios (con dominio, la API no arranca si siguen siendo los del ejemplo).
- [ ] Solo los puertos 22, 80 y 443 abiertos.
- [ ] Antivirus ClamAV valorado (`COMPOSE_PROFILES=…,antivirus` y `CLAMAV_HOST=clamav`): recomendable si los usuarios suben archivos de terceros.
- [ ] Correo SMTP configurado (SPF/DKIM) y probado con una invitación.
- [ ] Contraseña del superadministrador cambiada y **verificación en dos pasos activada** (con un dominio real la exige el sistema; en local nunca. Se puede desactivar con `REQUIRE_SUPERADMIN_2FA=false`, aunque no se recomienda).
- [ ] Copia **fuera del servidor** activada (`BACKUP_OFFSITE=true` con carpeta externa y frase de cifrado). Las copias locales ya se hacen y se verifican solas: busca `VERIFICADA` en `docker compose logs backup`.
- [ ] Créditos de OpenRouter y límites diarios por organización revisados.
- [ ] Monitorización de `https://tu-dominio/api/health` (por ejemplo con Uptime Kuma o un servicio externo).
