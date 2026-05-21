const fs = require("node:fs/promises");
const path = require("node:path");
const { getDbState } = require("../db");
const { config } = require("./config");
const { getProjectScopeDomains, isHostInProjectScope } = require("./project-domains");
const { getProviderRuntimeSettings } = require("./provider-settings");
const { clampProgress, createId, nowIso } = require("./utils");

const WEB_SOURCE_TIMEOUT_MS = 15000;
const CRTSH_TIMEOUT_MS = 35000;
const URLSCAN_MAX_PAGES = 5;
const URLSCAN_PAGE_SIZE = 100;
const VIRUSTOTAL_MAX_PAGES = 8;
const SHODAN_MAX_PAGES = 5;
const NETLAS_MAX_PAGES = 5;
const NETLAS_PAGE_SIZE = 20;
const DORK_MAX_PAGES = 2;
const DORK_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const SUPPORTED_PASSIVE_SOURCE_IDS = [
  "commoncrawl",
  "crtsh",
  "hackertarget",
  "waybackarchive",
  "hudsonrock",
  "bevigil",
  "bufferover",
  "fullhunt",
  "netlas",
  "reconeer",
  "securitytrails",
  "shodan",
  "threatbook",
  "urlscan",
  "virustotal",
  "whoisxmlapi",
  "dork-google",
  "dork-bing",
  "dork-yandex",
  "dork-google-api",
  "dork-yandex-api",
];

let httpErrorLogReady = null;

async function ensureHttpErrorLogPath() {
  if (!config.httpErrorLogEnabled) {
    return;
  }
  if (!httpErrorLogReady) {
    httpErrorLogReady = fs.mkdir(path.dirname(config.httpErrorLogFile), { recursive: true });
  }
  await httpErrorLogReady;
}

async function appendHttpErrorLog(entry) {
  if (!config.httpErrorLogEnabled) {
    return;
  }

  try {
    await ensureHttpErrorLogPath();
    await fs.appendFile(
      config.httpErrorLogFile,
      `${JSON.stringify({ time: nowIso(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // ignore logging failures
  }
}

function inScope(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHostsFromText(text, domain) {
  const hostRegex = new RegExp(`([a-z0-9][a-z0-9.-]*\\.${escapeRegex(domain)})`, "gi");
  const hosts = new Set();
  for (const match of text.matchAll(hostRegex)) {
    const host = normalizeHost(match[1]);
    if (host && inScope(host, domain)) {
      hosts.add(host);
    }
  }
  return Array.from(hosts);
}

function tryExtractHostFromUrl(raw, domain, hostSet, depth = 0) {
  if (depth > 3) {
    return;
  }
  const value = String(raw || "").trim();
  if (!value) {
    return;
  }

  const candidates = [value, value.replace(/&amp;/g, "&")];
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }

    const host = normalizeHost(parsed.hostname);
    if (host && inScope(host, domain)) {
      hostSet.add(host);
    }

    // Search engines often store real target URLs in redirect query params.
    const redirectKeys = ["url", "u", "target", "dest", "destination", "to", "redir", "redirect", "r"];
    for (const key of redirectKeys) {
      const nested = parsed.searchParams.get(key);
      if (!nested) {
        continue;
      }

      const nestedCandidates = [nested, nested.replace(/&amp;/g, "&")];
      for (const nestedRaw of nestedCandidates) {
        tryExtractHostFromUrl(nestedRaw, domain, hostSet, depth + 1);
        try {
          const decoded = decodeURIComponent(nestedRaw);
          if (decoded && decoded !== nestedRaw) {
            tryExtractHostFromUrl(decoded, domain, hostSet, depth + 1);
          }
        } catch {
          // ignore decoding errors
        }
      }
    }
  }
}

function extractHostsFromSearchHtml(text, domain) {
  const hosts = new Set(extractHostsFromText(text, domain));

  // 1) plain absolute URLs in page text
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  for (const match of text.matchAll(urlRegex)) {
    tryExtractHostFromUrl(match[0], domain, hosts);
  }

  // 2) href/src attributes
  const attrRegex = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(attrRegex)) {
    const raw = String(match[1] || "").trim();
    if (!raw) {
      continue;
    }

    if (raw.startsWith("//")) {
      tryExtractHostFromUrl(`https:${raw}`, domain, hosts);
      continue;
    }
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      tryExtractHostFromUrl(raw, domain, hosts);
      continue;
    }

    // For relative redirects like /clck/jsredir?...&url=https%3A%2F%2Fsub.domain
    tryExtractHostFromUrl(`https://yandex.com${raw}`, domain, hosts);
    tryExtractHostFromUrl(`https://www.google.com${raw}`, domain, hosts);
    tryExtractHostFromUrl(`https://www.bing.com${raw}`, domain, hosts);
  }

  return Array.from(hosts);
}

async function emit(onProgress, progress, stage, processed, total) {
  if (!onProgress) {
    return;
  }

  await onProgress({
    progress: clampProgress(progress),
    stage,
    processed,
    total,
  });
}

function upsertSubdomain(projectId, host, isRoot) {
  const { db } = getDbState();
  const now = nowIso();

  return db
    .prepare(`
      INSERT INTO subdomains (id, project_id, host, is_root, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, host)
      DO UPDATE SET
        is_root = excluded.is_root,
        updated_at = excluded.updated_at
      RETURNING id
    `)
    .get(createId(), projectId, host, isRoot ? 1 : 0, now, now);
}

function saveSources(subdomainId, sourceList) {
  const { db } = getDbState();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO subdomain_sources (id, subdomain_id, source, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const now = nowIso();
  const transaction = db.transaction((sources) => {
    for (const source of sources) {
      insertStmt.run(createId(), subdomainId, source, now);
    }
  });

  transaction(sourceList);
}

function mergeResults(resultArrays) {
  const hostMap = new Map();

  for (const list of resultArrays) {
    for (const item of list || []) {
      const host = normalizeHost(item.host);
      if (!host) {
        continue;
      }

      let sourceSet = hostMap.get(host);
      if (!sourceSet) {
        sourceSet = new Set();
        hostMap.set(host, sourceSet);
      }

      for (const source of item.sources || []) {
        if (source) {
          sourceSet.add(String(source).toLowerCase());
        }
      }
    }
  }

  return Array.from(hostMap.entries()).map(([host, sourceSet]) => ({
    host,
    sources: Array.from(sourceSet),
  }));
}

function getProviderToken(providerSettings, providerId) {
  const row = providerSettings.get(providerId);
  if (!row || !row.enabled || !row.token) {
    return null;
  }
  return row.token;
}

function parseTwoPartToken(rawToken) {
  const raw = String(rawToken || "").trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return { first: parts[0], second: parts[1] };
}

function detectAntiBotChallenge(source, text) {
  const body = String(text || "").toLowerCase();
  if (!body) {
    return false;
  }

  if (
    source === "dork-yandex" &&
    (body.includes("checkcaptchafast") ||
      body.includes("smart-captcha") ||
      body.includes("checking your browser before redirecting to yandex.com"))
  ) {
    return true;
  }

  if (
    source === "dork-google" &&
    (body.includes("/sorry/") || body.includes("unusual traffic from your computer network"))
  ) {
    return true;
  }

  if (
    source === "dork-bing" &&
    (body.includes("why did this happen?") && body.includes("bing"))
  ) {
    return true;
  }

  return false;
}

async function requestText(url, options = {}) {
  const source = options.source || "unknown";
  const safeUrl = options.safeUrl || url;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || WEB_SOURCE_TIMEOUT_MS);
  let loggedHttpError = false;
  const method = String(options.method || "GET").toUpperCase();

  try {
    console.log(`[passive][request] source=${source} url=${safeUrl}`);
    const response = await fetch(url, {
      method,
      redirect: "follow",
      headers: options.headers || {},
      body: Object.prototype.hasOwnProperty.call(options, "body") ? options.body : undefined,
      signal: controller.signal,
    });

    console.log(
      `[passive][response] source=${source} status=${response.status} elapsedMs=${Date.now() - startedAt} url=${safeUrl}`,
    );

    if (!response.ok) {
      await appendHttpErrorLog({
        source,
        url: safeUrl,
        status: response.status,
        statusText: response.statusText || "",
        elapsedMs: Date.now() - startedAt,
      });
      loggedHttpError = true;
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (detectAntiBotChallenge(source, text)) {
      await appendHttpErrorLog({
        source,
        url: safeUrl,
        status: response.status,
        statusText: response.statusText || "",
        elapsedMs: Date.now() - startedAt,
        error: "anti_bot_challenge",
      });
      throw new Error("Anti-bot challenge page");
    }

    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[passive][error] source=${source} elapsedMs=${Date.now() - startedAt} url=${safeUrl} error=${message}`,
    );
    if (!loggedHttpError) {
      await appendHttpErrorLog({
        source,
        url: safeUrl,
        status: null,
        statusText: "",
        elapsedMs: Date.now() - startedAt,
        error: message,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options = {}) {
  const text = await requestText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON response: ${message}`);
  }
}

async function fetchCrtsh(domain) {
  const text = await requestText(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {
    source: "crtsh",
    timeoutMs: CRTSH_TIMEOUT_MS,
  });
  const data = JSON.parse(text);
  const hosts = new Set();

  if (Array.isArray(data)) {
    for (const row of data) {
      const values = String(row?.name_value || "").split("\n");
      for (const value of values) {
        const host = normalizeHost(value.replace(/^\*\./, ""));
        if (host && inScope(host, domain)) {
          hosts.add(host);
        }
      }
    }
  }

  return Array.from(hosts).map((host) => ({ host, sources: ["crtsh"] }));
}

async function fetchHudsonRock(domain) {
  const data = await requestJson(
    `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/urls-by-domain?domain=${encodeURIComponent(domain)}`,
    { source: "hudsonrock" },
  );

  const hosts = new Set();
  const employees = Array.isArray(data?.data?.employees_urls) ? data.data.employees_urls : [];
  const clients = Array.isArray(data?.data?.clients_urls) ? data.data.clients_urls : [];

  for (const row of [...employees, ...clients]) {
    const url = String(row?.url || "");
    for (const host of extractHostsFromText(url, domain)) {
      hosts.add(host);
    }
  }

  return Array.from(hosts).map((host) => ({ host, sources: ["hudsonrock"] }));
}

async function fetchCommonCrawl(domain) {
  const indexes = await requestJson("https://index.commoncrawl.org/collinfo.json", {
    source: "commoncrawl",
  });

  const rows = Array.isArray(indexes) ? indexes : [];
  const currentYear = new Date().getUTCFullYear();
  const selected = [];

  for (let offset = 0; offset < 3; offset += 1) {
    const year = String(currentYear - offset);
    const row = rows.find((item) => String(item?.id || "").includes(year) && item?.["cdx-api"]);
    if (row) {
      selected.push(row["cdx-api"]);
    }
  }

  const found = new Set();
  for (const apiUrl of selected) {
    try {
      const text = await requestText(`${apiUrl}?url=*.${encodeURIComponent(domain)}`, {
        source: "commoncrawl",
      });
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        let decoded = line;
        try {
          decoded = decodeURIComponent(line);
        } catch {}
        for (const host of extractHostsFromText(decoded, domain)) {
          found.add(host);
        }
      }
    } catch {
      // ignore failed index
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["commoncrawl"] }));
}

async function fetchUrlscan(domain, token) {
  const found = new Set();
  let searchAfter = "";

  for (let page = 0; page < URLSCAN_MAX_PAGES; page += 1) {
    const endpoint =
      `https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(domain)}&size=${URLSCAN_PAGE_SIZE}` +
      (searchAfter ? `&search_after=${encodeURIComponent(searchAfter)}` : "");

    const data = await requestJson(endpoint, {
      source: "urlscan",
      headers: {
        "api-key": token,
      },
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) {
      break;
    }

    for (const row of results) {
      const candidates = [
        row?.task?.domain,
        row?.page?.domain,
      ];

      for (const value of candidates) {
        const host = normalizeHost(value);
        if (host && inScope(host, domain)) {
          found.add(host);
        }
      }

      const taskUrl = typeof row?.task?.url === "string" ? row.task.url : "";
      const pageUrl = typeof row?.page?.url === "string" ? row.page.url : "";

      for (const rawUrl of [taskUrl, pageUrl]) {
        if (!rawUrl) {
          continue;
        }
        try {
          const parsed = new URL(rawUrl);
          const host = normalizeHost(parsed.hostname);
          if (host && inScope(host, domain)) {
            found.add(host);
          }
        } catch {
          // ignore malformed URLs
        }
      }
    }

    const last = results[results.length - 1];
    const sortValues = Array.isArray(last?.sort) ? last.sort : [];
    if (!data?.has_more || sortValues.length === 0) {
      break;
    }

    searchAfter = sortValues.map((item) => String(item)).join(",");
  }

  return Array.from(found).map((host) => ({ host, sources: ["urlscan"] }));
}

async function fetchHackerTarget(domain) {
  const text = await requestText(`https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`, {
    source: "hackertarget",
  });
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const hosts = new Set();

  for (const line of lines) {
    const host = normalizeHost(line.split(",")[0]);
    if (host && inScope(host, domain)) {
      hosts.add(host);
    }
  }

  return Array.from(hosts).map((host) => ({ host, sources: ["hackertarget"] }));
}

async function fetchWayback(domain) {
  const text = await requestText(
    `https://web.archive.org/cdx/search/cdx?url=*.${encodeURIComponent(domain)}&output=txt&fl=original&collapse=urlkey&limit=5000`,
    { source: "waybackarchive" },
  );

  const hosts = new Set();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let decoded = line;
    try {
      decoded = decodeURIComponent(line);
    } catch {
      // keep original line
    }

    for (const host of extractHostsFromText(decoded, domain)) {
      hosts.add(host);
    }
  }

  return Array.from(hosts).map((host) => ({ host, sources: ["waybackarchive"] }));
}

async function fetchBufferOver(domain, token) {
  const data = await requestJson(`https://tls.bufferover.run/dns?q=.${encodeURIComponent(domain)}`, {
    source: "bufferover",
    headers: { "x-api-key": token },
  });

  const items = []
    .concat(Array.isArray(data?.FDNS_A) ? data.FDNS_A : [])
    .concat(Array.isArray(data?.RDNS) ? data.RDNS : [])
    .concat(Array.isArray(data?.Results) ? data.Results : []);

  const found = new Set();
  for (const item of items) {
    for (const host of extractHostsFromText(String(item), domain)) {
      found.add(host);
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["bufferover"] }));
}

async function fetchBeVigil(domain, token) {
  const data = await requestJson(`https://osint.bevigil.com/api/${encodeURIComponent(domain)}/subdomains/`, {
    source: "bevigil",
    headers: {
      "X-Access-Token": token,
      "User-Agent": "node-sqlite-app",
    },
  });

  const items = Array.isArray(data?.subdomains) ? data.subdomains : [];
  return items
    .map((item) => normalizeHost(item))
    .filter((item) => item && inScope(item, domain))
    .map((item) => ({ host: item, sources: ["bevigil"] }));
}

async function fetchFullHunt(domain, token) {
  const data = await requestJson(`https://fullhunt.io/api/v1/domain/${encodeURIComponent(domain)}/subdomains`, {
    source: "fullhunt",
    headers: { "X-API-KEY": token },
  });

  const items = Array.isArray(data?.hosts) ? data.hosts : [];
  return items
    .map((item) => normalizeHost(item))
    .filter((item) => item && inScope(item, domain))
    .map((item) => ({ host: item, sources: ["fullhunt"] }));
}

async function fetchVirusTotal(domain, token) {
  const found = new Set();
  let cursor = "";

  for (let page = 0; page < VIRUSTOTAL_MAX_PAGES; page += 1) {
    const endpoint =
      `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}/subdomains?limit=40` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

    const data = await requestJson(endpoint, {
      source: "virustotal",
      headers: { "x-apikey": token },
    });

    const items = Array.isArray(data?.data) ? data.data : [];
    for (const item of items) {
      const host = normalizeHost(item?.id);
      if (host && inScope(host, domain)) {
        found.add(host);
      }
    }

    cursor = String(data?.meta?.cursor || "");
    if (!cursor) {
      break;
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["virustotal"] }));
}

async function fetchShodan(domain, token) {
  const found = new Set();

  for (let page = 1; page <= SHODAN_MAX_PAGES; page += 1) {
    const endpoint = `https://api.shodan.io/dns/domain/${encodeURIComponent(domain)}?key=${encodeURIComponent(token)}&page=${page}`;
    const data = await requestJson(endpoint, {
      source: "shodan",
      safeUrl: `https://api.shodan.io/dns/domain/${encodeURIComponent(domain)}?key=***&page=${page}`,
    });

    const subdomains = Array.isArray(data?.subdomains) ? data.subdomains : [];
    for (const item of subdomains) {
      const host = normalizeHost(`${item}.${domain}`);
      if (host && inScope(host, domain)) {
        found.add(host);
      }
    }

    if (!data?.more) {
      break;
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["shodan"] }));
}

async function fetchNetlas(domain, token) {
  const found = new Set();
  const query = `domain:*.${domain} a:*`;

  for (let page = 0; page < NETLAS_MAX_PAGES; page += 1) {
    const start = page * NETLAS_PAGE_SIZE;
    const endpoint =
      `https://app.netlas.io/api/domains/?q=${encodeURIComponent(query)}` +
      `&start=${start}&fields=domain&source_type=include`;

    const data = await requestJson(endpoint, {
      source: "netlas",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      const candidates = [
        item?.data?.domain,
        item?.domain,
      ];

      for (const value of candidates) {
        const host = normalizeHost(value);
        if (host && inScope(host, domain)) {
          found.add(host);
        }
      }

      if (!candidates.some(Boolean)) {
        for (const host of extractHostsFromText(JSON.stringify(item || {}), domain)) {
          found.add(host);
        }
      }
    }

    if (items.length < NETLAS_PAGE_SIZE) {
      break;
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["netlas"] }));
}

async function fetchWhoisXmlApi(domain, token) {
  const endpoint =
    `https://subdomains.whoisxmlapi.com/api/v1?apiKey=${encodeURIComponent(token)}` +
    `&domainName=${encodeURIComponent(domain)}`;

  const data = await requestJson(endpoint, {
    source: "whoisxmlapi",
    safeUrl: `https://subdomains.whoisxmlapi.com/api/v1?apiKey=***&domainName=${encodeURIComponent(domain)}`,
  });

  const records = Array.isArray(data?.result?.records) ? data.result.records : [];
  return records
    .map((item) => normalizeHost(item?.domain))
    .filter((item) => item && inScope(item, domain))
    .map((item) => ({ host: item, sources: ["whoisxmlapi"] }));
}

async function fetchThreatBook(domain, token) {
  const endpoint =
    `https://api.threatbook.cn/v3/domain/sub_domains?apikey=${encodeURIComponent(token)}` +
    `&resource=${encodeURIComponent(domain)}`;

  const data = await requestJson(endpoint, {
    source: "threatbook",
    safeUrl: `https://api.threatbook.cn/v3/domain/sub_domains?apikey=***&resource=${encodeURIComponent(domain)}`,
  });

  const items = Array.isArray(data?.data?.sub_domains?.data) ? data.data.sub_domains.data : [];
  return items
    .map((item) => normalizeHost(item))
    .filter((item) => item && inScope(item, domain))
    .map((item) => ({ host: item, sources: ["threatbook"] }));
}

async function fetchReconeer(domain, token) {
  const headers = { Accept: "application/json" };
  if (token) {
    headers["X-API-KEY"] = token;
  }

  const data = await requestJson(`https://www.reconeer.com/api/domain/${encodeURIComponent(domain)}`, {
    source: "reconeer",
    headers,
  });

  const items = Array.isArray(data?.subdomains) ? data.subdomains : [];
  return items
    .map((item) => normalizeHost(item?.subdomain))
    .filter((item) => item && inScope(item, domain))
    .map((item) => ({ host: item, sources: ["reconeer"] }));
}

async function fetchSecurityTrails(domain, token) {
  const endpoint = `https://api.securitytrails.com/v1/domain/${encodeURIComponent(domain)}/subdomains`;
  const data = await requestJson(endpoint, {
    source: "securitytrails",
    headers: { APIKEY: token },
  });

  const items = Array.isArray(data?.subdomains) ? data.subdomains : [];
  const found = new Set();

  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) {
      continue;
    }
    const host = normalizeHost(normalized.endsWith(".") ? `${normalized}${domain}` : `${normalized}.${domain}`);
    if (host && inScope(host, domain)) {
      found.add(host);
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["securitytrails"] }));
}

async function fetchGoogleDorks(domain) {
  const found = new Set();
  const queries = [`site:${domain}`, `site:*.${domain}`];

  for (const query of queries) {
    for (let page = 0; page < DORK_MAX_PAGES; page += 1) {
      const start = page * 100;
      const endpoint =
        `https://www.google.com/search?q=${encodeURIComponent(query)}` +
        `&num=100&start=${start}&hl=en`;

      const text = await requestText(endpoint, {
        source: "dork-google",
        headers: DORK_HEADERS,
      });

      for (const host of extractHostsFromSearchHtml(text, domain)) {
        found.add(host);
      }
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["dork-google"] }));
}

async function fetchGoogleDorksApi(domain, apiKey, cx) {
  const found = new Set();
  const queries = [`site:${domain}`, `site:*.${domain}`];

  for (const query of queries) {
    for (let page = 0; page < DORK_MAX_PAGES; page += 1) {
      const start = page * 10 + 1;
      const endpoint =
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}` +
        `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=10&start=${start}`;

      const data = await requestJson(endpoint, {
        source: "dork-google-api",
        safeUrl:
          `https://www.googleapis.com/customsearch/v1?key=***` +
          `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=10&start=${start}`,
      });

      const items = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        const candidates = [item?.link, item?.formattedUrl, item?.displayLink];
        for (const value of candidates) {
          for (const host of extractHostsFromSearchHtml(String(value || ""), domain)) {
            found.add(host);
          }
          const host = normalizeHost(value);
          if (host && inScope(host, domain)) {
            found.add(host);
          }
        }
      }
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["dork-google-api"] }));
}

async function fetchBingDorks(domain) {
  const found = new Set();
  const queries = [`site:${domain}`, `site:*.${domain}`];

  for (const query of queries) {
    for (let page = 0; page < DORK_MAX_PAGES; page += 1) {
      const first = page * 50 + 1;
      const endpoint =
        `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
        `&count=50&first=${first}&setlang=en`;

      const text = await requestText(endpoint, {
        source: "dork-bing",
        headers: DORK_HEADERS,
      });

      for (const host of extractHostsFromSearchHtml(text, domain)) {
        found.add(host);
      }
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["dork-bing"] }));
}

async function fetchYandexDorks(domain) {
  const found = new Set();
  const queries = [`site:${domain}`, `site:*.${domain}`];

  for (const query of queries) {
    for (let page = 0; page < DORK_MAX_PAGES; page += 1) {
      const endpoint =
        `https://yandex.com/search/?text=${encodeURIComponent(query)}` +
        `&p=${page}&lang=en`;

      const text = await requestText(endpoint, {
        source: "dork-yandex",
        headers: DORK_HEADERS,
      });

      for (const host of extractHostsFromSearchHtml(text, domain)) {
        found.add(host);
      }
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["dork-yandex"] }));
}

async function fetchYandexDorksApi(domain, apiKey, folderId) {
  const found = new Set();
  const queries = [`site:${domain}`, `site:*.${domain}`];

  for (const query of queries) {
    for (let page = 0; page < DORK_MAX_PAGES; page += 1) {
      const payload = await requestJson("https://searchapi.api.cloud.yandex.net/v2/web/search", {
        source: "dork-yandex-api",
        method: "POST",
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        safeUrl: "https://searchapi.api.cloud.yandex.net/v2/web/search",
        body: JSON.stringify({
          folderId,
          responseFormat: "FORMAT_XML",
          query: {
            searchType: "SEARCH_TYPE_COM",
            queryText: query,
            page: String(page),
          },
          userAgent: DORK_HEADERS["User-Agent"],
        }),
      });

      const rawData = typeof payload?.rawData === "string" ? payload.rawData : "";
      if (!rawData) {
        continue;
      }

      let text = "";
      try {
        text = Buffer.from(rawData, "base64").toString("utf8");
      } catch {
        text = "";
      }
      if (!text) {
        continue;
      }

      const urlTagRegex = /<url>([^<]+)<\/url>/gi;
      for (const match of text.matchAll(urlTagRegex)) {
        for (const host of extractHostsFromSearchHtml(String(match[1] || ""), domain)) {
          found.add(host);
        }
      }

      for (const host of extractHostsFromSearchHtml(text, domain)) {
        found.add(host);
      }
    }
  }

  return Array.from(found).map((host) => ({ host, sources: ["dork-yandex-api"] }));
}

function shouldRunSourceForScope(sourceCategory, scanScope) {
  if (scanScope.startsWith("provider:")) {
    return false;
  }
  if (scanScope === "all") {
    return true;
  }
  return sourceCategory === scanScope;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return [];
  }

  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) {
        return;
      }
      results[index] = await mapper(list[index], index);
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runWebPassiveScan(domain, onProgress, scanScope) {
  const baseSources = [
    { name: "commoncrawl", category: "core", fetcher: fetchCommonCrawl },
    { name: "crtsh", category: "core", fetcher: fetchCrtsh },
    { name: "hackertarget", category: "core", fetcher: fetchHackerTarget },
    { name: "waybackarchive", category: "core", fetcher: fetchWayback },
    { name: "hudsonrock", category: "core", fetcher: fetchHudsonRock },
  ];
  const sources = [...baseSources];
  const providerSettings = new Map(
    getProviderRuntimeSettings().map((item) => [item.provider, item]),
  );

  sources.push({ name: "dork-bing", category: "dorks", fetcher: fetchBingDorks });

  const urlscanToken = getProviderToken(providerSettings, "urlscan");
  if (urlscanToken) {
    sources.push({
      name: "urlscan",
      category: "extended",
      fetcher: (targetDomain) => fetchUrlscan(targetDomain, urlscanToken),
    });
  } else {
    console.log("[passive][skip] source=urlscan reason=missing_or_disabled_token");
  }

  const bufferOverToken = getProviderToken(providerSettings, "bufferover");
  if (bufferOverToken) {
    sources.push({
      name: "bufferover",
      category: "extended",
      fetcher: (targetDomain) => fetchBufferOver(targetDomain, bufferOverToken),
    });
  } else {
    console.log("[passive][skip] source=bufferover reason=missing_or_disabled_token");
  }

  const beVigilToken = getProviderToken(providerSettings, "bevigil");
  if (beVigilToken) {
    sources.push({
      name: "bevigil",
      category: "extended",
      fetcher: (targetDomain) => fetchBeVigil(targetDomain, beVigilToken),
    });
  } else {
    console.log("[passive][skip] source=bevigil reason=missing_or_disabled_token");
  }

  const fullHuntToken = getProviderToken(providerSettings, "fullhunt");
  if (fullHuntToken) {
    sources.push({
      name: "fullhunt",
      category: "extended",
      fetcher: (targetDomain) => fetchFullHunt(targetDomain, fullHuntToken),
    });
  } else {
    console.log("[passive][skip] source=fullhunt reason=missing_or_disabled_token");
  }

  const virusTotalToken = getProviderToken(providerSettings, "virustotal");
  if (virusTotalToken) {
    sources.push({
      name: "virustotal",
      category: "extended",
      fetcher: (targetDomain) => fetchVirusTotal(targetDomain, virusTotalToken),
    });
  } else {
    console.log("[passive][skip] source=virustotal reason=missing_or_disabled_token");
  }

  const shodanToken = getProviderToken(providerSettings, "shodan");
  if (shodanToken) {
    sources.push({
      name: "shodan",
      category: "extended",
      fetcher: (targetDomain) => fetchShodan(targetDomain, shodanToken),
    });
  } else {
    console.log("[passive][skip] source=shodan reason=missing_or_disabled_token");
  }

  const netlasToken = getProviderToken(providerSettings, "netlas");
  if (netlasToken) {
    sources.push({
      name: "netlas",
      category: "extended",
      fetcher: (targetDomain) => fetchNetlas(targetDomain, netlasToken),
    });
  } else {
    console.log("[passive][skip] source=netlas reason=missing_or_disabled_token");
  }

  const whoisXmlApiToken = getProviderToken(providerSettings, "whoisxmlapi");
  if (whoisXmlApiToken) {
    sources.push({
      name: "whoisxmlapi",
      category: "extended",
      fetcher: (targetDomain) => fetchWhoisXmlApi(targetDomain, whoisXmlApiToken),
    });
  } else {
    console.log("[passive][skip] source=whoisxmlapi reason=missing_or_disabled_token");
  }

  const threatBookToken = getProviderToken(providerSettings, "threatbook");
  if (threatBookToken) {
    sources.push({
      name: "threatbook",
      category: "extended",
      fetcher: (targetDomain) => fetchThreatBook(targetDomain, threatBookToken),
    });
  } else {
    console.log("[passive][skip] source=threatbook reason=missing_or_disabled_token");
  }

  const securityTrailsToken = getProviderToken(providerSettings, "securitytrails");
  if (securityTrailsToken) {
    sources.push({
      name: "securitytrails",
      category: "extended",
      fetcher: (targetDomain) => fetchSecurityTrails(targetDomain, securityTrailsToken),
    });
  } else {
    console.log("[passive][skip] source=securitytrails reason=missing_or_disabled_token");
  }

  const reconeerToken = getProviderToken(providerSettings, "reconeer");
  if (reconeerToken) {
    sources.push({
      name: "reconeer",
      category: "extended",
      fetcher: (targetDomain) => fetchReconeer(targetDomain, reconeerToken),
    });
  } else {
    console.log("[passive][skip] source=reconeer reason=missing_or_disabled_token");
  }

  const isProviderScope = scanScope.startsWith("provider:");
  const forcedProvider = isProviderScope ? scanScope.slice("provider:".length).trim().toLowerCase() : "";
  const filteredSources = isProviderScope
    ? sources.filter((source) => source.name === forcedProvider)
    : sources.filter((source) => shouldRunSourceForScope(source.category, scanScope));

  if (isProviderScope && filteredSources.length === 0) {
    throw new Error(`Selected provider is unavailable: ${forcedProvider}`);
  }

  const totalSources = Math.max(filteredSources.length, 1);
  const sourceConcurrency = Math.max(
    1,
    Math.min(totalSources, Number(config.passiveSourceConcurrency) || totalSources),
  );
  await emit(
    onProgress,
    14,
    `Querying passive sources (${scanScope}, parallel=${sourceConcurrency}/${totalSources})`,
    0,
    totalSources,
  );

  let completedSources = 0;
  const sourceResults = await mapWithConcurrency(
    filteredSources,
    sourceConcurrency,
    async (source) => {
      try {
        const result = await source.fetcher(domain);
        return Array.isArray(result) ? result : [];
      } catch {
        return [];
      } finally {
        completedSources += 1;
        const progress = Math.round(16 + (completedSources / totalSources) * 36);
        await emit(
          onProgress,
          progress,
          `Passive source done: ${source.name} (${completedSources}/${totalSources})`,
          completedSources,
          totalSources,
        );
      }
    },
  );

  return mergeResults(sourceResults);
}

async function executePassiveScan(projectId, onProgress, scanScope = "core", options = null) {
  const { db } = getDbState();

  await emit(onProgress, 5, "Loading project");
  const project = db
    .prepare("SELECT id, domain FROM projects WHERE id = ?")
    .get(projectId);

  if (!project) {
    throw new Error("Project not found");
  }

  const projectDomains = getProjectScopeDomains(project.id, project.domain);
  if (!projectDomains.length) {
    throw new Error("Add at least one domain to the project before running passive scan");
  }

  const requestedTargets = Array.isArray(options?.targetDomains)
    ? options.targetDomains.map((item) => normalizeHost(item)).filter(Boolean)
    : [];
  const isProviderScope = String(scanScope || "").startsWith("provider:");
  const rootHostTargets = isProviderScope && requestedTargets.length === 0
    ? db
      .prepare("SELECT host FROM subdomains WHERE project_id = ? AND is_root = 1 ORDER BY host ASC")
      .all(project.id)
      .map((row) => normalizeHost(row.host))
      .filter(Boolean)
    : [];
  const targetCandidates = requestedTargets.length
    ? requestedTargets
    : isProviderScope
      ? rootHostTargets
      : projectDomains;
  const domains = Array.from(
    new Set(targetCandidates.filter((item) => isHostInProjectScope(item, projectDomains))),
  );
  if (!domains.length) {
    throw new Error(
      isProviderScope
        ? "Add root hosts to the project before running provider scan"
        : "Selected subdomains are outside project scope",
    );
  }

  const isFullyPassive = scanScope === "fullypassive";
  const webScope = isFullyPassive ? "all" : scanScope;
  const results = [];
  for (let index = 0; index < domains.length; index += 1) {
    const domain = domains[index];
    await emit(onProgress, 8, `Preparing passive scan for ${domain} (${index + 1}/${domains.length})`);
    results.push(await runWebPassiveScan(domain, onProgress, webScope));
  }
  const mergedResults = mergeResults(results);

  const filtered = mergedResults.filter((item) => isHostInProjectScope(item.host, projectDomains));

  const saveRootProgress = 78;
  const persistStartProgress = 82;
  const persistEndProgress = 98;

  await emit(onProgress, saveRootProgress, "Saving root domains");
  for (const domain of projectDomains) {
    upsertSubdomain(project.id, domain, true);
  }

  const total = filtered.length;
  await emit(
    onProgress,
    total > 0 ? persistStartProgress : 95,
    total > 0 ? "Persisting discovered hosts" : "No hosts discovered",
    0,
    total,
  );

  for (let index = 0; index < filtered.length; index += 1) {
    const result = filtered[index];
    const subdomain = upsertSubdomain(project.id, result.host, projectDomains.includes(result.host));

    const sourceList = result.sources.length ? result.sources : ["unknown"];
    saveSources(subdomain.id, sourceList);

    const processed = index + 1;
    if (processed === 1 || processed === total || processed % 20 === 0) {
      const progress = Math.round(
        persistStartProgress +
          (processed / Math.max(total, 1)) * (persistEndProgress - persistStartProgress),
      );
      await emit(onProgress, progress, `Persisted ${processed}/${total} hosts`, processed, total);
    }
  }

  await emit(onProgress, 98, "Passive scan completed", filtered.length, filtered.length);
  return { found: filtered.length };
}

module.exports = {
  executePassiveScan,
  SUPPORTED_PASSIVE_SOURCE_IDS,
};
