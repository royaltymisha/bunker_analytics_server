# bunker-analytics

Приём событий аналитики из Unity-клиента Bunker. Node 20+, Fastify, Postgres. Разворачивается на Railway.

## Запуск локально

```bash
npm install
cp .env.example .env      # заполнить DATABASE_URL, INGEST_KEY, ADMIN_KEY
npm start                 # миграции применяются автоматически на старте
```

## Деплой на Railway

1. `railway.com` → **New Project** → **Deploy from GitHub repo**, выбрать этот репозиторий.
2. В настройках сервиса **Settings → Root Directory** указать `analytics-server` (репозиторий общий с Unity-проектом).
3. В том же проекте **+ New → Database → Add PostgreSQL**. Переменная `DATABASE_URL` подставится сама.
4. **Variables** сервиса: `INGEST_KEY`, `ADMIN_KEY`, при необходимости `STEAM_WEB_API_KEY` и `STEAM_APP_ID`.
5. **Settings → Networking → Generate Domain** — полученный URL идёт в `AnalyticsSettings.BaseUrl` в Unity.

Healthcheck (`/health`) уже прописан в `railway.json`: новый деплой не переключит на себя трафик, пока не поднимется.

## API

| Метод | Путь | Ключ | Назначение |
|---|---|---|---|
| POST | `/v1/events` | `X-Api-Key: $INGEST_KEY` | приём пачки событий, до 100 за раз |
| GET | `/v1/stats/launches?days=14` | `X-Api-Key: $ADMIN_KEY` | запуски по дням: всего, уникальных, новых установок |
| GET | `/v1/stats/overview` | `X-Api-Key: $ADMIN_KEY` | сводка: DAU, MAU, всего событий |
| GET | `/v1/stats/quests?days=30` | `X-Api-Key: $ADMIN_KEY` | прохождение сюжета: сколько игроков дошло до каждого шага и где остановилось |
| GET | `/dashboard` | — (ключ вводится в браузере) | визуальный дашборд статистики |
| GET | `/health` | — | healthcheck |

Пример пачки:

```json
{
  "install_id": "6e6a3b7c-1f0f-4a4b-9a2a-0d1a2b3c4d5e",
  "session_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "steam_id": "76561197960287930",
  "steam_ticket": "140000...",
  "app_version": "0.9.3",
  "platform": "WindowsPlayer",
  "events": [
    {
      "event_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "name": "game_launch",
      "ts": "2026-08-31T09:15:00.000Z",
      "props": { "first_launch": true, "launch_count": 1 }
    }
  ]
}
```

Ответ: `202 {"accepted": 1, "duplicates": 0, "steam_verified": true}`.

## События

| Имя | Когда | Ключевые поля |
|---|---|---|
| `game_launch` | запуск игры, до первой сцены | `first_launch`, `launch_count`, железо, разрешение, язык |
| `game_quit` | выход из игры | `session_seconds` |
| `quest_complete` | пройден шаг очереди квестов | `queue_index`, `quest_name`, `quest_day`, `duration_seconds` |

`quest_complete` шлётся клиентом из `QuestsManager.QuestQueueRunner` в момент, когда квест переходит
в `Complete`. Прогресс считается по **`queue_index`** — сквозному индексу шага в очереди, а не по
`quest_id`: один и тот же ассет квеста стоит в очереди по нескольку раз, и по его Id нельзя сказать,
докуда игрок дошёл. Максимум `queue_index` на установку и есть ответ на вопрос «до какого квеста
доходят игроки»; ровно это считает `/v1/stats/quests`.

Квесты, поднятые из сейва уже пройденными, события не шлют — иначе одно прохождение считалось бы
дважды. А вот новый заход в игру с начала пришлёт их снова: это осознанно, `installs_completed`
считает уникальные установки, а не события.

## Дашборд

`GET /dashboard` — статическая страница ([src/dashboard.html](src/dashboard.html)), сама по себе
не требует ключа: цифры она тянет с уже защищённых `/v1/stats/*`. При первом
открытии просит `ADMIN_KEY`, сохраняет его в `localStorage` браузера и дальше
шлёт как `X-Api-Key` в каждом запросе. KPI (DAU/MAU/установки/запуски/события),
график запусков по дням (7/14/30/90) с переключаемыми сериями и переключением
на табличный вид. Собрана на чистом SVG без внешних зависимостей и CDN.

## Что стоит знать

- **`event_id` генерирует клиент.** По нему стоит `on conflict do nothing`, поэтому повторная отправка
  той же пачки (клиент ретраит после таймаута) не удваивает статистику.
- **Графики строятся по `received_at`, а не по `client_ts`.** Часы игрока могут быть переведены,
  а события из оффлайн-очереди доезжают через сутки после самого запуска.
- **`INGEST_KEY` лежит в билде игры открытым.** Это фильтр от случайного мусора, не защита данных.
  Единственное, чему можно верить, — строки с `steam_verified = true`: там SteamID подтверждён
  через `ISteamUserAuth/AuthenticateUserTicket`. Для отчётов, влияющих на деньги, фильтруйте по нему.
- **`STEAM_APP_ID` должен совпадать с тем, под которым клиент запросил билет**, иначе Steam
  вернёт отказ и все события окажутся непроверенными.
