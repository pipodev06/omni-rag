# Cómo contribuir

Gracias por querer mejorar Omni RAG. El proyecto se publica bajo **AGPL-3.0**: al enviar una contribución aceptas que se distribuya con esa licencia.

## Antes de empezar

- Para un cambio grande, abre primero un issue y cuéntalo.
- Los fallos de seguridad **no** van en un issue: ver [SECURITY.md](SECURITY.md).
- La arquitectura y las decisiones están en [docs/arquitectura.md](docs/arquitectura.md) y [docs/decisiones.md](docs/decisiones.md); la guía para desarrollar, en [docs/desarrollo.md](docs/desarrollo.md).

## Flujo

```bash
pnpm install
pnpm -r build          # compila API y web
pnpm -r test           # pruebas (las de integración necesitan PostgreSQL con pgvector, como en .github/workflows/ci.yml)
```

1. Haz un fork y una rama por cambio.
2. Añade o ajusta pruebas. Una consulta nueva sobre `documents` o `chunks` debe respetar `deleted_at IS NULL`, y toda tabla con datos de un cliente, su política RLS.
3. Variable de entorno nueva: se declara en `apps/api/src/config.ts` (o en `docker-compose.yml`), se añade a `.env.example` con su comentario y a `docs/variables.md`. Un test falla si falta.
4. Sin código muerto ni imports sin usar. Si repites un patrón (tabla, modal, paginación), reutiliza el componente compartido de `apps/web/src/components/`.
5. Nunca incluyas secretos, `.env` ni datos de clientes en el commit.
6. Abre el pull request explicando qué cambia y por qué.

## Estilo de la interfaz

Los criterios de interfaz de [AGENTS.md](AGENTS.md) están fijados (shadcn/ui, Tailwind, Lucide, tabla compartida, etc.). Un cambio de estilo ya definido solo se acepta si lo pide el mantenedor.

## Idioma

La documentación y la interfaz están en español. Los issues y pull requests pueden ir en español o en inglés.
