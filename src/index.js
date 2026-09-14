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
    // Краши идут тем же запросом, а не джойном: день с крашем, но без запусков
    // (игра упала до game_launch) иначе выпал бы из таблицы вовсе.
    // «Остановились» — для скольких установок этот день стал последним с запуском,
    // то есть кто после него не возвращался. Последний день окна тут всегда полон:
    // все, кто играл сегодня, пока «остановились» сегодня — как и последний шаг в
    // воронке квестов.
    const { rows } = await pool.query(
        `with daily as (select name,
                               install_id,
                               steam_id,
                               received_at,
                               props ->> 'first_launch' as first_launch
                        from events
                        where name in ('game_launch', 'game_crash')
                          and received_at >= now() - make_interval(days => $1::int)),
              per_day as (select date_trunc('day', received_at)::date                                  as day,
                                 count(*) filter (where name = 'game_launch')                          as launches,
                                 count(distinct install_id) filter (where name = 'game_launch')        as unique_installs,
                                 count(distinct steam_id)
                                     filter (where name = 'game_launch' and steam_id is not null)      as unique_steam_accounts,
                                 count(*) filter (where name = 'game_launch' and first_launch = 'true') as new_installs,
                                 count(*) filter (where name = 'game_crash')                           as crashes
                          from daily
                          group by day),
              -- Последний запуск внутри окна и есть последний запуск вообще: всё, что
              -- позже него, тоже попало бы в окно. Поэтому за пределы окна не смотрим.
              last_launch as (select install_id, date_trunc('day', max(received_at))::date as day
                              from daily
                              where name = 'game_launch'
                              group by install_id),
              stopped as (select day, count(*) as installs
                          from last_launch
                          group by day)
         select p.day,
                p.launches,
                p.unique_installs,
                p.unique_steam_accounts,
                p.new_installs,
                p.crashes,
                coalesce(s.installs, 0) as installs_stopped_here
         from per_day p
                  left join stopped s on s.day = p.day
         order by p.day desc`,
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
                (select max(received_at) from events)                             as last_event_at,
                -- Краши и ошибки: за всё время для плиток и за 7 дней для доли на запуск —
                -- «всего» размывается старыми билдами, а неделя показывает текущий билд.
                (select count(*) from events where name = 'game_crash')           as crashes_total,
                (select count(*) from events where name = 'crash_suspected')      as crashes_suspected_total,
                (select count(*) from events where name = 'console_error')        as console_errors_total,
                (select count(distinct install_id) from events
                  where name = 'console_error')                                   as console_errors_installs,
                (select count(*) from events where name = 'game_crash'
                   and received_at >= now() - interval '7 days')                  as crashes_7d,
                (select count(*) from events where name = 'game_launch'
                   and received_at >= now() - interval '7 days')                  as launches_7d`
    );

    const overview = rows[0];
    const launches7d = Number(overview.launches_7d);

    overview.crashes_per_100_launches_7d = launches7d > 0
        ? Math.round((Number(overview.crashes_7d) / launches7d) * 10_000) / 100
        : null;

    return overview;
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

// Ошибки консоли, сгруппированные по хешу (сообщение + верх стека, считает клиент).
// Один и тот же NullReference у сотни игроков — одна строка со счётчиками, а не сто.
app.get('/v1/stats/errors', {
    onRequest: requireKey(process.env.ADMIN_KEY)
}, async (request) => {
    const days = Math.min(Math.max(Number(request.query.days ?? 30) || 30, 1), 365);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 200) || 200, 1), 1000);

    const { rows } = await pool.query(
        `with errors as (select install_id,
                                session_id,
                                app_version,
                                received_at,
                                props ->> 'type'    as type,
                                props ->> 'message' as message,
                                props ->> 'stack'   as stack,
                                props ->> 'scene'   as scene,
                                -- Хеш клиента, а без него — md5 сообщения: старые билды его не шлют.
                                coalesce(props ->> 'hash', md5(coalesce(props ->> 'message', ''))) as key
                         from events
                         where name = 'console_error'
                           and received_at >= now() - make_interval(days => $1::int))
         select key,
                mode() within group (order by type)                as type,
                mode() within group (order by message)             as message,
                count(*)                                           as occurrences,
                count(distinct install_id)                         as installs,
                count(distinct session_id)                         as sessions,
                min(received_at)                                   as first_seen,
                max(received_at)                                   as last_seen,
                -- Стек и сцена из самого свежего события группы.
                (array_agg(stack order by received_at desc))[1]    as stack,
                (array_agg(scene order by received_at desc))[1]    as scene,
                array_agg(distinct app_version)                    as app_versions
         from errors
         group by key
         order by last_seen desc
         limit $2`,
        [days, limit]
    );

    const summary = rows.reduce((acc, row) => ({
        unique: acc.unique + 1,
        occurrences: acc.occurrences + Number(row.occurrences)
    }), { unique: 0, occurrences: 0 });

    return { days, summary, rows };
});

// --- ВРЕМЕННОЕ: сброс статистики -----------------------------------------
// Нужно, пока данные — это тестовые прогоны разработчиков. Удаляется вместе с
// кнопкой «Сброс аналитики» в dashboard.html, как только пойдут живые игроки.

app.post('/v1/admin/reset', {
    onRequest: requireKey(process.env.ADMIN_KEY)
}, async (request, reply) => {
    // ADMIN_KEY уже лежит в localStorage браузера, так что одного ключа мало:
    // без слова-подтверждения база стиралась бы случайным POST по открытой вкладке.
    if (request.body?.confirm !== 'RESET') {
        return reply.code(400).send({ error: 'confirmation_required' });
    }

    // Считаем до удаления: truncate количество строк не возвращает, а показать
    // в дашборде, сколько именно снесли, полезно.
    const { rows } = await pool.query('select count(*)::int as total from events');

    // truncate, а не delete: не пишет строку за строкой в WAL и сразу отдаёт место.
    // Таблица одна и ни на что не ссылается, каскадов бояться нечего.
    await pool.query('truncate table events');

    request.log.warn({ deleted: rows[0].total }, 'аналитика сброшена через /v1/admin/reset');

    return { deleted: rows[0].total };
});

// --- Конец временного блока ----------------------------------------------

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
