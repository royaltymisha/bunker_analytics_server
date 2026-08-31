import Fastify from 'fastify';

import { pool } from './db.js';
import { migrate } from './migrate.js';
import { verifySteamTicket } from './steam.js';

const MAX_EVENTS_PER_BATCH = 100;

const app = Fastify({
    // Railway терминирует TLS перед контейнером, поэтому реальный IP игрока
    // приходит в X-Forwarded-For — без этого флага все запросы выглядят как один.
    trustProxy: true,
    bodyLimit: 256 * 1024,
    logger: {
        level: process.env.LOG_LEVEL ?? 'info'
    }
});

// --- Ключи --------------------------------------------------------------

// INGEST_KEY прошит в билде игры, вытащить его из клиента может любой желающий.
// Это не защита данных, а фильтр от случайного мусора: настоящая защита —
// проверка Steam-билета ниже.
function requireKey(expected) {
    return async (request, reply) => {
        if (!expected || request.headers['x-api-key'] !== expected) {
            return reply.code(401).send({ error: 'unauthorized' });
        }
    };
}

// --- Примитивный рейт-лимит --------------------------------------------

// Скользящее окно на процесс: одного инстанса Railway хватает, а тащить
// @fastify/rate-limit и Redis ради этого рано.
const requestLog = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/events')) {
        return;
    }

    const now = Date.now();
    const hits = (requestLog.get(request.ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);

    hits.push(now);
    requestLog.set(request.ip, hits);

    if (requestLog.size > 10_000) {
        requestLog.clear();
    }

    if (hits.length > RATE_MAX) {
        return reply.code(429).send({ error: 'rate_limited' });
    }
});

// --- Приём событий ------------------------------------------------------

const batchSchema = {
    body: {
        type: 'object',
        required: ['install_id', 'session_id', 'app_version', 'platform', 'events'],
        properties: {
            install_id: { type: 'string', format: 'uuid' },
            session_id: { type: 'string', format: 'uuid' },
            steam_id: { type: 'string', pattern: '^[0-9]{1,20}$', nullable: true },
            steam_ticket: { type: 'string', maxLength: 4096, nullable: true },
            app_version: { type: 'string', maxLength: 64 },
            platform: { type: 'string', maxLength: 64 },
            events: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_EVENTS_PER_BATCH,
                items: {
                    type: 'object',
                    required: ['event_id', 'name', 'ts'],
                    properties: {
                        event_id: { type: 'string', format: 'uuid' },
                        name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_]+$' },
                        ts: { type: 'string', format: 'date-time' },
                        props: { type: 'object', additionalProperties: true }
                    }
                }
            }
        }
    }
};

const INSERT_COLUMNS = 10;

app.post('/v1/events', {
    schema: batchSchema,
    onRequest: requireKey(process.env.INGEST_KEY)
}, async (request, reply) => {
    const batch = request.body;

    const { steamId: verifiedSteamId, verified } = await verifySteamTicket(batch.session_id, batch.steam_ticket ?? null);

    // Подтверждённый id всегда важнее присланного: если билет проверен, пишем
    // то, что сказал Steam, а не то, что сказал клиент.
    const steamId = verified ? verifiedSteamId : (batch.steam_id ?? null);

    const values = [];
    const rows = [];

    batch.events.forEach((event, index) => {
        const base = index * INSERT_COLUMNS;
        const placeholders = Array.from({ length: INSERT_COLUMNS }, (_, offset) => '$' + (base + offset + 1));

        rows.push('(' + placeholders.join(', ') + ')');

        values.push(
            event.event_id,
            event.name,
            event.ts,
            batch.install_id,
            batch.session_id,
            steamId,
            verified,
            batch.app_version,
            batch.platform,
            JSON.stringify(event.props ?? {})
        );
    });

    // do nothing по event_id: клиент ретраит батч при таймауте, и без этого
    // один запуск игры превратился бы в несколько.
    const result = await pool.query(
        'insert into events (event_id, name, client_ts, install_id, session_id, steam_id, steam_verified, app_version, platform, props) values ' +
        rows.join(', ') +
        ' on conflict (event_id) do nothing',
        values
    );

    return reply.code(202).send({
        accepted: result.rowCount,
        duplicates: batch.events.length - result.rowCount,
        steam_verified: verified
    });
});

// --- Чтение статистики --------------------------------------------------

app.get('/v1/stats/launches', {
    onRequest: requireKey(process.env.ADMIN_KEY)
}, async (request) => {
    const days = Math.min(Math.max(Number(request.query.days ?? 14) || 14, 1), 180);

    // Считаем по received_at, а не по client_ts: часы игрока могут быть
    // переведены, а оффлайн-очередь доезжает через сутки после запуска.
    const { rows } = await pool.query(
        `with launches as (select install_id,
                                  steam_id,
                                  received_at,
                                  props ->> 'first_launch' as first_launch
                           from events
                           where name = 'game_launch'
                             and received_at >= now() - make_interval(days => $1::int))
         select date_trunc('day', received_at)::date                         as day,
                count(*)                                                     as launches,
                count(distinct install_id)                                   as unique_installs,
                count(distinct steam_id) filter (where steam_id is not null) as unique_steam_accounts,
                count(*) filter (where first_launch = 'true')                as new_installs
         from launches
         group by day
         order by day desc`,
        [days]
    );

    return { days, rows };
});

app.get('/v1/stats/overview', {
    onRequest: requireKey(process.env.ADMIN_KEY)
}, async () => {
    const { rows } = await pool.query(
        `select (select count(*) from events)                                     as events_total,
                (select count(*) from events where name = 'game_launch')          as launches_total,
                (select count(distinct install_id) from events)                   as installs_total,
                (select count(distinct install_id) from events
                  where received_at >= now() - interval '1 day')                  as dau,
                (select count(distinct install_id) from events
                  where received_at >= now() - interval '30 days')                as mau,
                (select max(received_at) from events)                             as last_event_at`
    );

    return rows[0];
});

// Railway дёргает этот путь как healthcheck: пока он не ответит 200,
// новый деплой не переключит на себя трафик.
app.get('/health', async () => ({ ok: true }));

// --- Запуск -------------------------------------------------------------

const start = async () => {
    try {
        await migrate();

        // Порт назначает Railway, а слушать надо 0.0.0.0 — на 127.0.0.1
        // контейнер снаружи недостижим и healthcheck провалится.
        await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
};

start();
