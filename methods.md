# Methods

This file documents methods that are currently implemented.

## 1. High-level pipeline

Passive scan (`PASSIVE_SCAN`) now uses only web/passive sources.
No DNS brute methods are used.

DNS resolve (`DNS_RESOLVE`) is a separate run type and resolves already known hosts.

## 2. Passive scan scopes

- `core`
  - Web sources from `core` category.
- `extended`
  - Web sources from `extended` category only (token-based).
- `dorks`
  - Search-engine dork sources only.
- `all`
  - `core` + `extended` + `dorks`.
- `fullypassive`
  - Same behavior as `all` (kept as explicit "no brute" mode).

## 3. Implemented passive methods

### 3.1 Core web passive methods

- `anubis`
- `commoncrawl`
- `crtsh`
- `hackertarget`
- `rapiddns`
- `waybackarchive`
- `hudsonrock`
- `threatcrowd`

### 3.2 Extended web passive methods (token-based)

- `alienvault`
- `certspotter`
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

If token is missing/disabled, source is skipped.

### 3.3 Dork methods

- `dork-google-api` (official, if `googlecse` token set as `API_KEY|CX`)
- `dork-yandex-api` (official v2, if `yandexsearchapi` token set as `API_KEY|FOLDER_ID`)
- `dork-bing` (HTML search parsing)
- `dork-google` (HTML fallback when no Google API token)
- `dork-yandex` (HTML fallback when no Yandex API token)

Pattern used: `site:{domain}`, `site:*.{domain}` with host extraction from result HTML.

## 4. DNS resolve methods (`DNS_RESOLVE`)

Works on hosts already saved in DB (`subdomains` + root domain).

Record types collected:
- `A`, `AAAA`, `CNAME`, `MX`, `NS`, `TXT`, `SOA`, `CAA`, `SRV`, `PTR`.

Resolve scopes:
- `fast` (stored as `core`): `8.8.8.8`.
- `extended`: `8.8.8.8`, `8.8.4.4`, `1.1.1.1`, `1.0.0.1`.

Before each DNS resolve run, previous `dns_records` for the project are cleared and rebuilt.

## 5. Important note

Current implementation does not include:
- DNS wordlist brute force.
- DNS permutation brute.
- Recursive DNS brute.
- HTTP crawling of the target site itself.
