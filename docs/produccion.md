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

**Configurarlo desde la pantalla.** *Sistema → Copias* (solo el superadministrador) permite cambiar los horarios, los días de retención, la copia externa y los datos de Backblaze sin editar el `.env` ni reiniciar: el servicio de copias relee los ajustes cada minuto (las claves de B2 llegan a `backup-b2` en unos 5 minutos, porque el worker las deja en un archivo cada ciclo del monitor) y el botón *Hacer copia ahora* lanza una copia inmediata. **Una variable escrita (no vacía) en el `.env` manda** sobre la pantalla y allí aparece bloqueada; `.env.example` trae esos ajustes comentados para que se puedan editar en la pantalla. Lo que sigue explica las variables, que siguen funcionando igual.

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

**Elegir y cambiar el destino desde la pantalla (`BACKUP_TARGETS_DIR`).** `BACKUP_OFFSITE_DIR` es una sola carpeta fijada en el `.env`. Para elegir el disco desde *Sistema → Copias → Cambiar destino* (por ejemplo, un USB o un NAS), define `BACKUP_TARGETS_DIR` con la carpeta del servidor **que contiene** los discos; cada subcarpeta (hasta dos niveles) es un destino posible. La pantalla muestra el espacio libre de cada una y avisa con «Mismo disco que el servidor» si no protege de la pérdida del disco.

- **Linux (USB o NAS):** monta el disco de forma permanente con su UUID en `/etc/fstab` (opción `nofail`, para que el servidor arranque aunque el disco no esté), por ejemplo en `/mnt/usb1`, y pon `BACKUP_TARGETS_DIR=/mnt` en el `.env`. Crea dentro del disco la carpeta de las copias (`/mnt/usb1/omni`) o deja que la pantalla la cree.
- **Windows (Docker Desktop):** `BACKUP_TARGETS_DIR=D:/` (la unidad del USB o del disco; debe estar compartida con Docker Desktop en *Settings → Resources → File sharing*). Los destinos son las carpetas de esa unidad.
- Aplica con `docker compose up -d`. Si no la defines, `./backups-targets` queda vacía y la pantalla explica que falta la variable.
- **No montes la unidad entera:** apunta `BACKUP_TARGETS_DIR` a una carpeta **dedicada** (por ejemplo `/mnt/usb1/omni-copias`, no `/mnt` ni `D:/`). El servicio solo ofrece como destino lo que hay dentro de esa carpeta, pero el contenedor puede leer y escribir en todo lo que montes: cuanto menos montes, menos puede dañar un fallo o una orden mal formada.
- Docker puede no ver un disco montado **después** de arrancar el servicio `backup`: tras conectar o desconectar un disco, `docker compose restart backup` si la pantalla no lo detecta (la lista de destinos se recalcula cada 5 minutos, y al pedir un cambio de destino).

*Cambiar de destino.* El modal pide la carpeta (una de la lista o una subcarpeta nueva dentro de una existente) y la casilla *Llevar las copias existentes a la nueva carpeta*. Si la marcas, el servicio copia todas las copias a la nueva carpeta, las compara byte a byte y **solo si todo coincide borra las antiguas**; si algo falla no borra nada y la orden queda como fallida con el motivo. Si no la marcas, solo las copias nuevas van a la carpeta nueva y las anteriores se quedan donde estaban. Antes de aceptar se comprueba que la carpeta admite escritura y que hay espacio. El destino elegido es el que usa también `backup-b2`. Volver a elegir el destino actual confirma el disco (útil tras cambiar de USB).

*Destino desconectado.* Si el disco no está o ya no es el mismo que antes, la copia local **sigue haciéndose**, no se escribe en ninguna carpeta alternativa y la pantalla muestra «el destino externo no está conectado»; el monitor avisa por correo (alerta `backup-offsite`, si `ALERT_EMAIL` está configurado). Al reconectar el disco se retoma solo en un minuto (tras `docker compose restart backup` si Docker no lo ve); las copias que se hicieron mientras estaba desconectado solo existen en `./backups` hasta la próxima copia o hasta pulsar *Hacer copia ahora*.

*Protecciones del servicio de copias.* Solo borra archivos con el nombre exacto que él mismo pone (`db_AAAA-MM-DD_HHMM.dump`, `.dump.enc`, `.dump.fallida`, `uploads_AAAA-MM-DD_HHMM.tgz` y `.tgz.enc`); un `db_clientes.xlsx` tuyo en esa carpeta no se toca. Antes de cada copia comprueba que hay en `./backups` al menos el doble de espacio que ocupó la última; si no, falla con un mensaje claro. Las órdenes de la pantalla sin atender en 6 horas se cierran como «Caducada». Al mover copias a otro destino se niega a seguir si origen y destino son la misma carpeta (por ejemplo, por un enlace simbólico). El contenedor `backup` corre sin las capacidades de root salvo `DAC_OVERRIDE` y `FOWNER`; `find`, `df` y `stat` sobre los discos externos llevan un tope de 20 segundos para que un disco colgado no bloquee el servicio.

**Subirlas a Backblaze B2 (integrado):** el servicio `backup-b2` (rclone) sube cada 6 horas las copias cifradas de `BACKUP_OFFSITE_DIR` a un bucket de B2 y borra de allí las de más de 30 días.

1. En Backblaze, crea un bucket **privado** y una *Application Key* limitada a ese bucket (*App Keys → Add a New Application Key*; no uses la Master Key). Guarda el `keyID` y la `applicationKey`: esta última solo se muestra una vez.
2. En `.env`, además de `BACKUP_OFFSITE=true` y la frase de cifrado:
   ```bash
   B2_KEY_ID=<keyID>
   B2_APPLICATION_KEY=<applicationKey>
   B2_BUCKET=<nombre del bucket>
   ```
   Alternativa: deja esas tres variables fuera del `.env` y escríbelas en *Sistema → Copias* (la clave se guarda cifrada); el servicio `backup-b2` (siempre en marcha) espera sin hacer nada hasta que estén completas. B2 es opcional: sin configurar, la pantalla lo muestra como «No configurado» y no hay alertas.
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

`BACKUP_TZ` (por defecto `<-05>5`, Lima) cambia la zona; usa ese formato POSIX, por ejemplo `<-03>3` para Argentina. Con hora fija, al arrancar el contenedor solo se hace copia si la última tiene más de 24 h (el servidor estaba apagado o parado a esa hora), y `backup-b2` sube a los 5 minutos las copias que aún no estén en B2. Para una copia inmediata: `docker compose exec backup sh /backup.sh --once`. Aplica con `docker compose up -d` (o cámbialo en *Sistema → Copias*, sin reiniciar); en los registros aparece `próxima copia a las 03:00 … dentro de N min`. Las marcas de tiempo de los registros y los nombres de archivo siguen en UTC.

Solo se suben archivos `.enc`: sin la frase de cifrado no sale nada del servidor. Para restaurar, baja los dos archivos del bucket (web de Backblaze o `rclone copy`), descífralos con el comando de arriba y sigue [operacion.md](operacion.md#restaurar-una-copia). Si el bucket tiene versiones o reglas de ciclo de vida propias, déjalas en «mantener solo la última versión»: el servicio ya borra definitivamente lo antiguo.

**Opción manual:** copia `./backups` con `rclone` a un almacenamiento S3 compatible o al *storage box* de tu proveedor con una tarea `cron` diaria (`0 4 * * * rclone sync /ruta/rag-project/backups remoto:rag-backups`). Esa copia no va cifrada salvo que lo configures tú.

**Dónde ver si funcionan:** Sistema → Copias (solo el superadministrador) muestra la última copia y su verificación, la próxima hora, si van a la carpeta externa cifradas y el estado de B2, con el error exacto si algo falla (por ejemplo, las variables de B2 vacías). `backup.sh` deja ese estado en `./backups/.estado.json` y `b2-sync.sh` en el volumen `backup-status`; el worker lo lee cada 5 minutos y el monitor avisa si la última copia o la última subida fallaron (alertas `backup` y `backup-b2`) o si la copia externa no se pudo hacer (`backup-offsite`). `backup.sh` deja además la lista de destinos posibles en `./backups/.destinos.json`. Una copia que falla no deja ningún `db_*.dump`: queda como `.dump.fallida` y no cuenta como copia reciente.

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

Si tu proxy corre **en Docker** (Nginx Proxy Manager, Traefik…) y solo está en su propia red, no alcanzará a `rag-web-1` y dará 502 (`could not be resolved`). Conecta la web a esa red con `docker-compose.override.example.yml` (cópialo como `docker-compose.override.yml` y apunta el proxy a `rag-web-1:80`). Usa siempre `docker compose up -d` sin `-f`, o el override se ignora. Ese mismo archivo trae una segunda parte para guardar los datos en carpetas (`./data`) en vez de volúmenes de Docker, recomendada si el servidor se limpia con `prune` ([operacion.md](operacion.md#dónde-viven-los-datos)).

Por qué cada línea importa:

| Línea | Si falta |
|---|---|
| `X-Forwarded-Proto $scheme` | Los enlaces y la detección de HTTPS fallan (la cookie igualmente va como segura gracias a `DOMAIN`). |
| `X-Forwarded-For $remote_addr` | La auditoría y los límites usarían una IP falsificable por el cliente. |
| `proxy_buffering off` | El chat no se ve palabra a palabra: llega de golpe al final. |
| `client_max_body_size` | Las subidas grandes dan `413`. |
| `Strict-Transport-Security` | Solo Caddy lo añade solo; con tu nginx hay que ponerlo tú. |

**La IP real del usuario.** No hay que configurar nada. El nginx del contenedor `web` confía en `X-Forwarded-For` solo cuando se lo envía un proxy de una red privada (`10.x`, `172.16–31.x`, `192.168.x`, `127.0.0.1`): Caddy, Nginx Proxy Manager, el túnel de Cloudflare o tu nginx en la misma máquina. Recorre la cadena desde el final saltando esos proxies y se queda con la primera IP pública, sea cual sea el número de proxies; lo que el cliente escriba al principio no cuenta. Si tu proxy está en **otra máquina con IP pública**, añade su dirección como `set_real_ip_from` en `apps/web/nginx.conf`; si no, todos los usuarios saldrían con la IP del proxy. Para comprobarlo: entra desde dos redes distintas (por ejemplo, el móvil sin wifi) y mira *Mi cuenta → Sesiones*; deben salir IP distintas y públicas, no `172.x` ni `10.x`. En local con Docker Desktop siempre sale la puerta de enlace de Docker (`172.x`): Docker Desktop no conserva la IP de origen.

No añadas `Content-Security-Policy` ni `X-Frame-Options` en tu nginx: ya las envía la web y se duplicarían. Si tu nginx sirve otras aplicaciones, no toques nada de ellas: el dominio nuevo es un `server` aparte.

## Actualizar a una nueva versión

```bash
cd omni-rag
git pull
docker compose pull      # baja las imágenes nuevas que publicó el CI (ghcr.io/pipodev06/omni-rag-*)
docker compose up -d
docker image prune       # sin -a: borra solo las imágenes viejas
```

Si el servidor no llega a GHCR, `docker compose up -d --build` las construye ahí mismo, como antes. Las migraciones de la base de datos se aplican solas al arrancar. Antes de actualizar, haz una copia manual: `docker compose exec backup sh /backup.sh --once`.

## Probar la configuración HTTPS en local

Con `DOMAIN=localhost` y `COMPOSE_PROFILES=https`, Caddy usa un certificado propio de prueba en `https://localhost`. El navegador avisará de que no es de confianza; es normal en local.

## Lista de comprobación

- [ ] `DOMAIN`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en `.env`.
- [ ] Guarda `JWT_SECRET` junto a `BACKUP_ENCRYPTION_PASSPHRASE`, fuera del servidor: de él sale la llave que cifra el 2FA y las claves guardadas en Sistema → Configuración. Si lo cambias, hay que volver a escribir esas claves (la pantalla las marca «No se puede leer») y cada usuario debe reconfigurar su 2FA.
- [ ] Contraseñas y `JWT_SECRET` nuevos y aleatorios (con dominio, la API no arranca si siguen siendo los del ejemplo).
- [ ] Solo los puertos 22, 80 y 443 abiertos.
- [ ] Antivirus ClamAV valorado (`COMPOSE_PROFILES=…,antivirus` y `CLAMAV_HOST=clamav`): recomendable si los usuarios suben archivos de terceros.
- [ ] Correo SMTP configurado (SPF/DKIM) y probado con una invitación.
- [ ] Contraseña del superadministrador cambiada y **verificación en dos pasos activada** (con un dominio real la exige el sistema; en local nunca. Se puede desactivar con `REQUIRE_SUPERADMIN_2FA=false`, aunque no se recomienda).
- [ ] Copia **fuera del servidor** activada (`BACKUP_OFFSITE=true` con carpeta externa y frase de cifrado). Las copias locales ya se hacen y se verifican solas: busca `VERIFICADA` en `docker compose logs backup`.
- [ ] Créditos de OpenRouter y límites diarios por organización revisados.
- [ ] Monitorización de `https://tu-dominio/api/health` (por ejemplo con Uptime Kuma o un servicio externo).
