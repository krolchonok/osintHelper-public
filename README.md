# node-sqlite-app

Перенесенный backend из исходного `recon-platform` на стек:

- `Node.js + Express`
- `SQLite` (файл `./data/app.db`)
- локальная очередь задач в SQLite (без Redis/BullMQ)

Поддерживает:

- auth + cookie sessions + роли (`ADMIN` / `USER`)
- bootstrap инициализацию root admin
- provider settings с шифрованием токенов (AES-256-GCM)
- passive scan в автономном режиме (встроенные web API)
- встроенные passive источники (логика из Subfinder/Subfind3r):
  `crt.sh`, `HackerTarget`, `RapidDNS`, `Wayback`, `ThreatCrowd`
- DNS resolve (Google + Cloudflare resolvers)
- run history + progress events

## Быстрый старт

```bash
cd node-sqlite-app
cp .env.example .env
npm install
npm run start
```

Сервер: `http://localhost:3001`

## Docker (опционально)

```bash
cp .env.example .env
docker compose up --build
```

SQLite будет храниться в volume `sqlite_data` по пути `/data/app.db`.

## Важные переменные

```env
PORT=3001
SQLITE_PATH=./data/app.db
ENCRYPTION_KEY=change-me-to-a-long-random-secret
APP_BASE_URL=http://localhost:3001
ADMIN_EMAIL=
ADMIN_PASSWORD=
ENABLE_INLINE_WORKER=true
SCAN_WORKER_CONCURRENCY=2
SCAN_WORKER_POLL_MS=1000
PASSIVE_SOURCE_CONCURRENCY=24
HTTP_ERROR_LOG_ENABLED=false
HTTP_ERROR_LOG_FILE=./data/http-errors.log
NETLAS_API_KEY=
TWOIP_API_KEYS=
```

Если `ADMIN_EMAIL`/`ADMIN_PASSWORD` пустые, при старте генерируется one-time setup URL.
`PASSIVE_SOURCE_CONCURRENCY` задает параллелизм web/passive-источников внутри одного запуска scan (по умолчанию почти все источники запускаются одновременно).

### Категории источников (scope)

Для `POST /api/projects/:id/scan` можно передать body:

```json
{ "scope": "core" }
```

Поддерживаемые значения:

- `core`: источники без обязательных токенов
- `extended`: только token-based источники (если токен не задан, источник игнорируется)
- `dorks`: только dork-источники (`dork-google`, `dork-bing`, `dork-yandex`)
- `all`: `core` + `extended` + `dorks`
- `fullypassive`: `all` (полностью без DNS brute методов)

#### Новые возможности сканирования

- **Netlas Integration**: Поддержка Netlas для поиска поддоменов и IP. Требуется `NETLAS_API_KEY`.
- **2ip Integration**: Geo/provider/hosting lookup для корневого домена проекта. Ключи можно хранить в Provider Settings или `TWOIP_API_KEYS` через запятую.
- **ASN Lookup**: Автоматический поиск ASN, названий организаций и стран для всех зарезолвленных IP-адресов проекта.
- **Scan Selected**: Возможность запустить пассивное сканирование (включая конкретных провайдеров) только для выбранных поддоменов.

Примечание по официальным dork API:
- `googlecse` токен в Provider Settings: `API_KEY|CX`
- `netlas` токен в Provider Settings: `API_KEY`
- `yandexsearchapi` токен в Provider Settings: `API_KEY|FOLDER_ID` (Yandex Search API v2, endpoint `/v2/web/search`)
- если токен не задан, используется HTML fallback (может блокироваться антиботом)

#### Статистика дорков и защита от ботов

Задача статистики дорков дополнительно проверяет scoped-запросы по чувствительным
артефактам: `.env`, конфиги, YAML/JSON secrets, дампы БД, бэкапы, архивы, логи,
private keys, `.git`/`.svn`, source maps, directory listing, документы, API docs
и debug endpoints. Все запросы ограничены `site:<domain>` проекта.

**Обработка капчи:** Реализован встроенный прокси-сервер для решения капчи. Если поисковик
запрашивает подтверждение, в интерфейсе появится уведомление с возможностью открыть страницу
решения. Прокси передает сессионные куки обратно воркеру для продолжения задачи.

При `HTTP 429` задача помечает движок как `rate_limited`, пропускает оставшиеся
запросы этого поисковика в текущем запуске и сохраняет частичный результат.

### Категории DNS resolve

Для `POST /api/projects/:id/resolve` можно передать body:

```json
{ "scope": "fast" }
```

Поддерживаемые значения:

- `fast`: только `8.8.8.8`
- `extended`: `8.8.8.8`, `8.8.4.4`, `1.1.1.1`, `1.0.0.1`

## Скрипты

```bash
npm run dev            # сервер с watch
npm run start          # сервер
npm run start:hot      # сервер с Ctrl+U для pull/update/restart и Ctrl+R для restart
npm run update:start   # git pull --ff-only, npm ci, затем запуск сервера
npm run update:dev     # git pull --ff-only, npm ci, затем запуск dev-сервера
npm run update:docker  # git pull --ff-only, пересборка и рестарт docker compose
npm run worker         # отдельный worker (если ENABLE_INLINE_WORKER=false)
npm run auth:init-admin
npm run tokens:export  # вывести готовую команду импорта токенов
npm run tokens:import -- --payload='...'
```

### Перенос токенов провайдеров на новый хост

Скрипты позволяют перенести сохраненные токены провайдеров из SQLite на другой хост
без ручного редактирования БД.

Как это работает:

- на старом хосте токены читаются из таблицы `provider_settings`
- токены расшифровываются текущим `ENCRYPTION_KEY`
- формируется одна готовая команда импорта
- на новом хосте эта команда повторно шифрует токены уже локальным `ENCRYPTION_KEY`
- после этого токены сохраняются в локальную SQLite базу нового хоста

Важно:

- на обоих хостах должен быть настроен `.env`
- на новом хосте проект должен быть уже установлен (`npm install`)
- payload в команде импорта содержит токены в открытом виде, только в `base64url`
- такую команду нельзя публиковать в логах, чатах, issue, wiki или shell history без понимания риска

На старом хосте:

```bash
npm run tokens:export
```

Скрипт выведет готовую команду вида:

```bash
npm run tokens:import -- --payload='...'
```

Эту команду можно выполнить на новом хосте в каталоге проекта с настроенным `.env`.
Токены будут прочитаны из payload, затем заново зашифрованы локальным `ENCRYPTION_KEY`
и сохранены в `provider_settings`.

Пример полного переноса:

1. На старом хосте:

```bash
cd /path/to/project
npm run tokens:export
```

2. Скопируйте выведенную команду `npm run tokens:import -- --payload='...'`

3. На новом хосте:

```bash
cd /path/to/project
cp .env.example .env
npm install
npm run tokens:import -- --payload='...'
```

4. После импорта скрипт выведет:

```bash
[tokens:import] imported: N
[tokens:import] skipped: M
```

Где:

- `imported` сколько провайдеров было записано в локальную БД
- `skipped` сколько записей было пропущено, если провайдер неизвестен текущей версии приложения

Дополнительно:

- если у провайдера токен пустой, при импорте он будет очищен
- флаг `enabled` тоже переносится
- импорт идемпотентен: повторный запуск обновляет те же записи, а не создает дубликаты

### Логирование HTTP ошибок passive-источников

Можно включить при запуске флагом:

```bash
npm start -- --log-http-errors
```

Кастомный файл:

```bash
npm start -- --log-http-errors --log-http-errors-file=./data/passive-http-errors.jsonl
```

В файл пишутся записи JSONL для запросов с `HTTP >= 400` (например `403`, `404`) и сетевых ошибок.

## API (основное)

- `GET /health`
- `GET /api/setup/status`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/setup`
- `GET /api/projects`
- `POST /api/projects/bulk`
- `GET /api/projects/:id`
- `DELETE /api/projects/:id`
- `POST /api/projects/:id/scan`
- `POST /api/projects/:id/resolve`
- `GET /api/projects/:id/runs`
- `POST /api/projects/:id/runs/:runId/cancel`
- `GET /api/settings/providers` (ADMIN)
- `PUT /api/settings/providers` (ADMIN)
- `GET /api/admin/users` (ADMIN)
- `POST /api/admin/users` (ADMIN)
- `PUT /api/admin/users/:id` (ADMIN)
- `DELETE /api/admin/users/:id` (ADMIN)

## Примечания по продакшену

- храните `data/app.db` на persistent volume
- делайте бэкап `app.db`
- для высокой нагрузки/масштабирования переходите на PostgreSQL + внешнюю очередь
