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
git clone <tu-repositorio> rag-project && cd rag-project
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

### 5. Arrancar

```bash
docker compose up -d --build
docker compose logs -f caddy     # verás cómo obtiene el certificado
```

Abre `https://rag.tuempresa.com`, entra con `SEED_ADMIN_USERNAME` y **cambia la contraseña** en *Mi cuenta*.

### 6. Copias de seguridad fuera del servidor

El servicio `backup` guarda cada día en `./backups` la base de datos y los archivos (7 días). Copia esa carpeta a otro lugar, por ejemplo con `rclone` a un almacenamiento S3 compatible o al *storage box* de tu proveedor, con una tarea `cron` diaria:

```bash
0 4 * * * rclone sync /ruta/rag-project/backups remoto:rag-backups
```

Prueba alguna vez a restaurar (ver [operacion.md](operacion.md#restaurar-una-copia)).

## Actualizar a una nueva versión

```bash
cd rag-project
git pull
docker compose up -d --build
```

Las migraciones de la base de datos se aplican solas al arrancar. Antes de actualizar, haz una copia manual: `docker compose exec backup sh /backup.sh --once`.

## Probar la configuración HTTPS en local

Con `DOMAIN=localhost` y `COMPOSE_PROFILES=https`, Caddy usa un certificado propio de prueba en `https://localhost`. El navegador avisará de que no es de confianza; es normal en local.

## Lista de comprobación

- [ ] `DOMAIN`, `COMPOSE_PROFILES=https` y `WEB_BIND=127.0.0.1` en `.env`.
- [ ] Contraseñas y `JWT_SECRET` nuevos y aleatorios.
- [ ] Solo los puertos 22, 80 y 443 abiertos.
- [ ] Correo SMTP configurado (SPF/DKIM) y probado con una invitación.
- [ ] Contraseña del superadministrador cambiada.
- [ ] Copias de `./backups` fuera del servidor, y restauración probada.
- [ ] Créditos de OpenRouter y límites diarios por organización revisados.
- [ ] Monitorización de `https://tu-dominio/api/health` (por ejemplo con Uptime Kuma o un servicio externo).
