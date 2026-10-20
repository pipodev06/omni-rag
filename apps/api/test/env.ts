// Variables mínimas para poder importar módulos que leen la configuración.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
process.env.APP_DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";
process.env.APP_DB_PASSWORD ??= "test-password";
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";
