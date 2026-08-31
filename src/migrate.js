import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './db.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Прогоняет непринятые .sql из migrations/ по алфавиту. Вызывается на старте
 * процесса: на Railway отдельного шага «выполнить миграции» в деплое нет,
 * а редеплой без схемы — это 500 на первом же событии.
 */
export async function migrate() {
    const client = await pool.connect();

    try {
        await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');

        const applied = await client.query('select name from schema_migrations');
        const appliedNames = new Set(applied.rows.map((row) => row.name));

        const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

        for (const name of files) {
            if (appliedNames.has(name)) {
                continue;
            }

            const sql = await readFile(join(migrationsDir, name), 'utf8');

            // Каждая миграция — одна транзакция: упала на середине, значит не применилась вовсе.
            await client.query('begin');

            try {
                await client.query(sql);
                await client.query('insert into schema_migrations (name) values ($1)', [name]);
                await client.query('commit');
                console.log(`[migrate] применена ${name}`);
            } catch (error) {
                await client.query('rollback');
                throw error;
            }
        }
    } finally {
        client.release();
    }
}

// Позволяет запустить руками: npm run migrate
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await migrate();
    await pool.end();
}
