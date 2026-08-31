import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import { pool } from './db.js';
import { migrate } from './migrate.js';
import { verifySteamTicket } from './steam.js';

const MAX_EVENTS_PER_BATCH = 100;

// Статическая страница дашборда, отдаётся как есть — читаем один раз на старте,
// а не на каждый запрос: файл не меняется, пока процесс жив.
const DASHBOARD_HTML = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'),
    'utf8'
);

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

// Прогресс по сюжету. Ключ шага — queue_index, сквозной индекс квеста в очереди:
// один и тот же ассет квеста стоит в очереди по нескольку раз, поэтому quest_id
// на вопрос «докуда дошёл игрок» не отвечает, а индекс отвечает.
app.get('/v1/stats/quests', {
    onRequest: requireKey(process.env.ADMIN_KEY)
}, async (request) => {
    const days = Math.min(Math.max(Number(request.query.days ?? 30) || 30, 1), 365);

    const { rows } = await pool.query(
        `with completed as (select install_id,
                                   (props ->> 'queue_index')::int as queue_index,
                                   props ->> 'quest_name'         as quest_name,
                                   props ->> 'quest_day'          as quest_day,
                                   props ->> 'quest_id'           as quest_id,
                                   case
                                       when jsonb_typeof(props -> 'queue_length') = 'number'
                                           then (props ->> 'queue_length')::int
                                       end                        as queue_length,
                                   -- Прогоны, поднятые из сейва посреди квеста, в среднее время
                                   -- не идут: отсчёт у них начался заново и занижает длительность.
                                   case
                                       when jsonb_typeof(props -> 'duration_seconds') = 'number'
                                           and props ->> 'resumed_from_save' = 'false'
                                           then (props ->> 'duration_seconds')::numeric
                                       end                        as duration_seconds
                            from events
                            where name = 'quest_complete'
                              and received_at >= now() - make_interval(days => $1::int)
                              -- Ключ приёма событий лежит в билде открытым, прислать сюда можно
                              -- что угодно: без проверки типа мусорный queue_index уронил бы каст.
                              and jsonb_typeof(props -> 'queue_index') = 'number'),
              furthest as (select install_id, max(queue_index) as queue_index
                           from completed
                           group by install_id),
              stopped as (select queue_index, count(*) as installs
                          from furthest
                          group by queue_index)
         select c.queue_index,
                -- Один индекс — один квест, но между версиями игры очередь сдвигается,
                -- поэтому берём самое частое имя, а не первое попавшееся.
                mode() within group (order by c.quest_day)  as quest_day,
                mode() within group (order by c.quest_name) as quest_name,
                mode() within group (order by c.quest_id)   as quest_id,
                count(*)                                    as completions,
                count(distinct c.install_id)                as installs_completed,
                -- Сколько всего шагов в очереди на момент прохождения: нужно, чтобы
                -- сказать «дошёл до 42 из 300», а не просто «до 42».
                max(c.queue_length)                         as queue_length,
                round(avg(c.duration_seconds))::int         as avg_seconds,
                -- Для скольких установок этот шаг стал последним пройденным — то есть
                -- сколько игроков дальше не ушло.
                coalesce(max(s.installs), 0)                as installs_stopped_here
         from completed c
                  left join stopped s on s.queue_index = c.queue_index
         group by c.queue_index
         order by c.queue_index`,
        [days]
    );

    return { days, summary: summariseProgress(rows), rows };
});

/**
 * Сводка «докуда доходят игроки» по распределению последних пройденных шагов.
 * Считается здесь, а не в SQL: installs_stopped_here — это уже готовое
 * распределение, второй запрос в базу за тем же самым не нужен.
 */
function summariseProgress(rows) {
    const installs = rows.reduce((total, row) => total + Number(row.installs_stopped_here), 0);

    const queueLength = rows.reduce((max, row) => Math.max(max, Number(row.queue_length) || 0), 0);

    if (installs === 0) {
        return { installs: 0, median_last_index: null, max_last_index: null, queue_length: queueLength || null };
    }

    const middle = installs / 2;
    let seen = 0;
    let median = null;

    for (const row of rows) {
        seen += Number(row.installs_stopped_here);

        if (median === null && seen >= middle) {
            median = row.queue_index;
        }
    }

    const reached = rows.filter((row) => Number(row.installs_stopped_here) > 0);

    return {
        installs,
        median_last_index: median,
        max_last_index: reached.length > 0 ? reached[reached.length - 1].queue_index : null,
        queue_length: queueLength || null
    };
}

// --- Дашборд --------------------------------------------------------------

// Страница сама по себе не отдаёт данных — это статический HTML+JS, ключ
// ADMIN_KEY вводится в браузере вручную и хранится в localStorage, а сами
// цифры идут через уже защищённые /v1/stats/*. Поэтому роут без requireKey.
app.get('/dashboard', async (request, reply) => {
    reply.type('text/html; charset=utf-8').send(DASHBOARD_HTML);
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
