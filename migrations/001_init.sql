-- Одна строка = одно событие клиента. Денормализовано намеренно: событий много,
-- пишутся они пачками, а читаются агрегатами — джойны здесь только мешали бы.
create table if not exists events
(
    -- Идентификатор события генерирует КЛИЕНТ. Он же делает батч идемпотентным:
    -- если ответ сервера потерялся и клиент прислал пачку заново, ON CONFLICT
    -- отбросит дубли вместо того, чтобы удвоить статистику по запускам.
    event_id       uuid        primary key,
    name           text        not null,

    -- Время по часам игрока: может врать (переведённые часы, оффлайн-очередь).
    client_ts      timestamptz not null,
    -- Время приёма сервером. Для графиков считать надо по нему.
    received_at    timestamptz not null default now(),

    -- Аноним, живёт в PlayerPrefs. Переустановка игры даёт новый id.
    install_id     uuid        not null,
    -- Один запуск игры = одна сессия.
    session_id     uuid        not null,

    steam_id       bigint,
    -- true — SteamID подтверждён через ISteamUserAuth/AuthenticateUserTicket.
    -- false — клиент просто прислал число, верить ему нельзя.
    steam_verified boolean     not null default false,

    app_version    text        not null,
    platform       text        not null,
    props          jsonb       not null default '{}'::jsonb
);

-- Воронки и счётчики за период: "сколько game_launch за 14 дней".
create index if not exists events_name_received_idx on events (name, received_at desc);
-- Ретеншен и путь конкретного игрока.
create index if not exists events_install_received_idx on events (install_id, received_at desc);
create index if not exists events_session_idx on events (session_id);
create index if not exists events_steam_idx on events (steam_id) where steam_id is not null;
