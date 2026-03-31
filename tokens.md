# Tokens

Документ фиксирует источники, где в текущей реализации используется токен.

## 1. Extended (токен обязателен)

- `urlscan`
- `bufferover`
- `bevigil`
- `fullhunt`
- `virustotal`
- `shodan`
- `whoisxmlapi`
- `threatbook`
- `securitytrails`
- `reconeer`

Примечание: если токен не задан или источник выключен в Provider Settings, источник пропускается.

## 2. Dorks API (токен опционален, при наличии используется API)

- `googlecse` -> `dork-google-api`
  - Формат: `API_KEY|CX`
  - Без токена: fallback на HTML источник `dork-google`.

- `yandexsearchapi` -> `dork-yandex-api`
  - Формат: `API_KEY|FOLDER_ID` (Yandex Search API v2)
  - Без токена: fallback на HTML источник `dork-yandex`.

## 3. Источники без токенов (в рамках dorks)

- `dork-bing` (HTML парсинг)

## 4. Где это реализовано

- `src/lib/passive-scan.js`
- `src/lib/providers.js`
