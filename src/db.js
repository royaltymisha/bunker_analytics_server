import pg from 'pg';

const { Pool } = pg;

// Railway отдаёт две строки подключения. Внутренняя (postgres.railway.internal)
// ходит по приватной сети проекта — TLS не нужен и его там нет. Публичная
// (*.proxy.rlwy.net) требует TLS, но сертификат самоподписанный, поэтому
// rejectUnauthorized: false — иначе pg отвалится на проверке цепочки.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL не задан. На Railway он появляется после добавления Postgres в проект.');
}

const isInternal = connectionString.includes('.railway.internal');

export const pool = new Pool({
    connectionString,
    ssl: isInternal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000
});
