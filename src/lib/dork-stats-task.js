const { getDbState } = require("../db");
const { getPrimaryProjectDomain } = require("./project-domains");
const { getProviderRuntimeSettings } = require("./provider-settings");
const { nowIso, createId } = require("./utils");

const engineCookies = {
  google: "",
  yandex: "",
  duckduckgo: "",
};

const DORK_TIMEOUT_MS = 18000;
const DORK_HTML_DELAY_MS = {
  google: 4500,
  yandex: 3000,
  duckduckgo: 2000,
};
const DORK_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru,en;q=0.8",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function extractCookies(response) {
  const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get("set-cookie");
  const cookieHeader = Array.isArray(rawCookies) ? rawCookies.join("; ") : String(rawCookies || "");
  const parsedCookies = [];
  if (cookieHeader) {
    const parts = cookieHeader.split(/,(?=[^;]*=)/);
    for (const part of parts) {
      const cookiePair = part.split(";")[0].trim();
      if (cookiePair && cookiePair.includes("=")) {
        parsedCookies.push(cookiePair);
      }
    }
  }
  return parsedCookies.join("; ");
}

function makeDorkResult(item, status, error = null) {
  return {
    ...item,
    status,
    totalResults: null,
    visibleResults: 0,
    error,
    checkedAt: nowIso(),
  };
}

const SENSITIVE_DORKS = [
  {
    label: "Sensitive: .env",
    category: "secrets",
    risk: "high",
    expression: `(ext:env OR inurl:.env)`,
  },
  {
    label: "Sensitive: configs",
    category: "config",
    risk: "high",
    expression: `(ext:conf OR ext:config OR ext:cnf OR ext:ini) (password OR secret OR token OR key)`,
  },
  {
    label: "Sensitive: YAML configs",
    category: "config",
    risk: "high",
    expression: `(ext:yml OR ext:yaml) (password OR secret OR token OR key)`,
  },
  {
    label: "Sensitive: JSON secrets",
    category: "config",
    risk: "high",
    expression: `ext:json ("api_key" OR "secret" OR "token" OR "client_secret")`,
  },
  {
    label: "Sensitive: database dumps",
    category: "database",
    risk: "high",
    expression: `(ext:sql OR ext:sqlite OR ext:db OR ext:dump)`,
  },
  {
    label: "Sensitive: backups",
    category: "backup",
    risk: "high",
    expression: `(ext:bak OR ext:backup OR ext:old OR ext:orig OR ext:save)`,
  },
  {
    label: "Sensitive: archives",
    category: "backup",
    risk: "medium",
    expression: `(ext:zip OR ext:tar OR ext:gz OR ext:tgz OR ext:7z OR ext:rar)`,
  },
  {
    label: "Sensitive: logs",
    category: "logs",
    risk: "medium",
    expression: `ext:log (password OR token OR secret OR exception OR stacktrace)`,
  },
  {
    label: "Sensitive: private keys",
    category: "keys",
    risk: "high",
    expression: `(ext:pem OR ext:key OR ext:ppk) ("BEGIN PRIVATE KEY" OR "BEGIN RSA PRIVATE KEY")`,
  },
  {
    label: "Sensitive: Git exposure",
    category: "source",
    risk: "high",
    expression: `(inurl:/.git/ OR intitle:"Index of" ".git")`,
  },
  {
    label: "Sensitive: SVN exposure",
    category: "source",
    risk: "medium",
    expression: `(inurl:/.svn/ OR intitle:"Index of" ".svn")`,
  },
  {
    label: "Sensitive: source maps",
    category: "source",
    risk: "medium",
    expression: `ext:map inurl:.js.map`,
  },
  {
    label: "Sensitive: directory listing",
    category: "listing",
    risk: "medium",
    expression: `intitle:"Index of" (backup OR dump OR config OR logs OR private)`,
  },
  {
    label: "Sensitive: spreadsheets",
    category: "documents",
    risk: "medium",
    expression: `(ext:xls OR ext:xlsx OR ext:csv) (password OR login OR users OR credentials)`,
  },
  {
    label: "Sensitive: documents",
    category: "documents",
    risk: "low",
    expression: `(ext:pdf OR ext:doc OR ext:docx) (confidential OR internal OR password OR credentials)`,
  },
  {
    label: "Sensitive: API docs",
    category: "api",
    risk: "medium",
    expression: `(inurl:swagger OR inurl:api-docs OR inurl:openapi OR ext:yaml "openapi")`,
  },
  {
    label: "Sensitive: debug endpoints",
    category: "debug",
    risk: "medium",
    expression: `(inurl:debug OR inurl:trace OR inurl:actuator OR inurl:server-status)`,
  },
  {
    label: "Sensitive: exposed package files",
    category: "source",
    risk: "low",
    expression: `(intitle:"index of" OR inurl:/) ("package.json" OR "composer.json" OR "requirements.txt")`,
  },
];

function buildDorkQueries(domain) {
  const baseQueries = [
    {
      engine: "google",
      label: "Google: site",
      category: "baseline",
      risk: "info",
      query: `site:${domain}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:${domain}`)}&hl=ru&num=100&pws=0&filter=0`,
    },
    {
      engine: "google",
      label: "Google: *.site",
      category: "baseline",
      risk: "info",
      query: `site:*.${domain}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:*.${domain}`)}&hl=ru&num=100&pws=0&filter=0`,
    },
    {
      engine: "yandex",
      label: "Yandex: site",
      category: "baseline",
      risk: "info",
      query: `site:${domain}`,
      url: `https://yandex.ru/search/?text=${encodeURIComponent(`site:${domain}`)}`,
    },
    {
      engine: "yandex",
      label: "Yandex: *.site",
      category: "baseline",
      risk: "info",
      query: `site:*.${domain}`,
      url: `https://yandex.ru/search/?text=${encodeURIComponent(`site:*.${domain}`)}`,
    },
    {
      engine: "duckduckgo",
      label: "DuckDuckGo: site",
      category: "baseline",
      risk: "info",
      query: `site:${domain}`,
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:${domain}`)}`,
    },
    {
      engine: "duckduckgo",
      label: "DuckDuckGo: *.site",
      category: "baseline",
      risk: "info",
      query: `site:*.${domain}`,
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:*.${domain}`)}`,
    },
  ];

  const sensitiveQueries = SENSITIVE_DORKS.flatMap((probe) => {
    const query = `site:${domain} ${probe.expression}`;
    return [
      {
        engine: "google",
        label: `Google: ${probe.label}`,
        category: probe.category,
        risk: probe.risk,
        query,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=ru&num=100&pws=0&filter=0`,
      },
      {
        engine: "yandex",
        label: `Yandex: ${probe.label}`,
        category: probe.category,
        risk: probe.risk,
        query,
        url: `https://yandex.ru/search/?text=${encodeURIComponent(query)}`,
      },
      {
        engine: "duckduckgo",
        label: `DuckDuckGo: ${probe.label}`,
        category: probe.category,
        risk: probe.risk,
        query,
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      },
    ];
  });

  return [...baseQueries, ...sensitiveQueries];
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

function getEnabledProviderToken(providerSettings, providerId) {
  const row = providerSettings.get(providerId);
  if (!row || !row.enabled || !row.token) {
    return null;
  }
  return row.token;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " "));
}

function parseCompactNumber(rawValue, multiplier = 1) {
  const normalized = String(rawValue || "")
    .replace(/\s+/g, "")
    .replace(/[,.](?=\d{3}\b)/g, "")
    .replace(",", ".");
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * multiplier);
}

function parseResultCount(text) {
  const normalized = stripTags(text).replace(/\s+/g, " ").trim();
  const patterns = [
    /id=["']result-stats["'][^>]*>\s*(?:примерно|about)?\s*([\d\s.,]+)\s*(?:результат|results?)/i,
    /(?:результатов|results?)\s*:\s*(?:примерно|about)?\s*([\d\s.,]+)/i,
    /(?:примерно|about)?\s*([\d\s.,]+)\s*(?:результат|results?)/i,
    /(?:наш[её]л(?:ся|ось|и)?|found)\s*([\d\s.,]+)\s*(млрд|миллиард|billion|млн|million|тыс|thousand|k)?/i,
    /([\d\s.,]+)\s*(млрд|миллиард|billion|млн|million|тыс|thousand|k)\s*(?:результат|results?)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    const unit = String(match[2] || "").toLowerCase();
    const multiplier =
      unit.includes("млрд") || unit.includes("миллиард") || unit.includes("billion")
        ? 1_000_000_000
        : unit.includes("млн") || unit.includes("million")
          ? 1_000_000
          : unit.includes("тыс") || unit.includes("thousand") || unit === "k"
            ? 1_000
            : 1;
    const parsed = parseCompactNumber(match[1], multiplier);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function countVisibleResults(html, engine) {
  const text = String(html || "");
  if (engine === "google") {
    const patterns = [
      /<div[^>]+class="[^"]*\bg\b[^"]*"/gi,
      /<div[^>]+class="[^"]*\bMjjYud\b[^"]*"/gi,
      /<div[^>]+class="[^"]*\bWw4FFb\b[^"]*"/gi,
      /<a[^>]+href="\/url\?q=/gi,
      /<h3\b/gi,
    ];
    return Math.max(...patterns.map((pattern) => (text.match(pattern) || []).length), 0);
  }
  if (engine === "yandex") {
    return (text.match(/class="[^"]*\bserp-item\b[^"]*"/gi) || []).length;
  }
  if (engine === "duckduckgo") {
    if (text.includes("no-results__container") || text.includes("result--no-result") || text.includes("No results found")) {
      return 0;
    }
    const patterns = [
      /class="[^"]*\bresult__snippet\b[^"]*"/gi,
      /class="[^"]*\bresult__title\b[^"]*"/gi,
      /class="[^"]*\bresult__url\b[^"]*"/gi,
      /class="[^"]*\bresult\b[^"]*"/gi,
    ];
    return Math.max(...patterns.map((pattern) => (text.match(pattern) || []).length), 0);
  }
  return 0;
}

function detectChallenge(engine, html) {
  const body = String(html || "").toLowerCase();
  if (!body) {
    return false;
  }
  if (engine === "google") {
    return (
      body.includes("/sorry/") ||
      body.includes("unusual traffic from your computer network") ||
      body.includes("before you continue to google") ||
      body.includes("consent.google")
    );
  }
  if (engine === "yandex") {
    return body.includes("smart-captcha") || body.includes("checkcaptchafast");
  }
  if (engine === "duckduckgo") {
    return (
      body.includes("ddg-captcha") ||
      body.includes("ddg-laptcha") ||
      body.includes("solving the captcha") ||
      body.includes("anomaly-modal") ||
      body.includes("bots use duckduckgo too")
    );
  }
  return false;
}

function detectGoogleJsOnly(html) {
  const body = String(html || "").toLowerCase();
  return (
    body.includes("/httpservice/retry/enablejs") ||
    body.includes("enablejs") ||
    (body.includes("google search") && !body.includes("result-stats") && !body.includes("/url?q=") && !body.includes("<h3"))
  );
}

async function fetchGoogleApiDorkStat(item, apiKey, cx) {
  const checkedAt = nowIso();
  const endpoint =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}` +
    `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(item.query)}&num=1`;
  const response = await fetch(endpoint, { method: "GET" });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const msg = data?.error?.message || `Google API HTTP ${response.status}`;
    throw new Error(msg);
  }

  const totalResults = Number.parseInt(String(data?.searchInformation?.totalResults || ""), 10);
  const visibleResults = Array.isArray(data?.items) ? data.items.length : 0;
  return {
    ...item,
    source: "googlecse",
    status: Number.isFinite(totalResults) ? "ok" : "unknown",
    totalResults: Number.isFinite(totalResults) ? totalResults : null,
    visibleResults,
    error: null,
    checkedAt,
  };
}

function parseYandexApiTotal(xml) {
  const text = String(xml || "");
  const foundMatch = text.match(/<found[^>]*priority=["']all["'][^>]*>([\d\s]+)<\/found>/i) ||
    text.match(/<found[^>]*>([\d\s]+)<\/found>/i);
  if (foundMatch) {
    const total = Number.parseInt(String(foundMatch[1] || "").replace(/\s+/g, ""), 10);
    if (Number.isFinite(total)) {
      return total;
    }
  }
  return parseResultCount(text);
}

async function fetchYandexApiDorkStat(item, apiKey, folderId) {
  const checkedAt = nowIso();
  const response = await fetch("https://searchapi.api.cloud.yandex.net/v2/web/search", {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      folderId,
      responseFormat: "FORMAT_XML",
      query: {
        searchType: "SEARCH_TYPE_COM",
        queryText: item.query,
        page: "0",
      },
      userAgent: DORK_HEADERS["User-Agent"],
    }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(`Yandex API HTTP ${response.status}`);
  }

  let xml = "";
  try {
    xml = Buffer.from(String(data?.rawData || ""), "base64").toString("utf8");
  } catch {
    xml = "";
  }

  const errorMatch = xml.match(/<error\b[^>]*code=["'](\d+)["'][^>]*>([\s\S]*?)<\/error>/i);
  if (errorMatch) {
    const errorCode = Number.parseInt(errorMatch[1], 10);
    const errorMessage = errorMatch[2].trim();
    const limitCodes = [15, 31, 32, 33, 34, 48];
    const isLimit = limitCodes.includes(errorCode) || errorMessage.toLowerCase().includes("limit") || errorMessage.toLowerCase().includes("balance");
    if (isLimit) {
      throw new Error(`Yandex API Limit: ${errorMessage} (code ${errorCode})`);
    } else {
      throw new Error(`Yandex API Error: ${errorMessage} (code ${errorCode})`);
    }
  }

  const totalResults = parseYandexApiTotal(xml);
  const visibleResults = (xml.match(/<doc\b/gi) || []).length;
  return {
    ...item,
    source: "yandexsearchapi",
    status: totalResults !== null || visibleResults > 0 ? "ok" : "unknown",
    totalResults,
    visibleResults,
    error: null,
    checkedAt,
  };
}

async function fetchDorkStat(item, options = {}) {
  try {
    if (item.engine === "google" && options.googleCse) {
      return await fetchGoogleApiDorkStat(item, options.googleCse.first, options.googleCse.second);
    }
    if (item.engine === "yandex" && options.yandexSearchApi) {
      return await fetchYandexApiDorkStat(item, options.yandexSearchApi.first, options.yandexSearchApi.second);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (
      message.includes("HTTP 429") ||
      lower.includes("limit") ||
      lower.includes("quota") ||
      lower.includes("balance") ||
      lower.includes("exhausted")
    ) {
      return makeDorkResult(item, "rate_limited", message);
    }
    return makeDorkResult(item, "error", message);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DORK_TIMEOUT_MS);
  const checkedAt = nowIso();

  const headers = { ...DORK_HEADERS };
  if (engineCookies[item.engine]) {
    headers["Cookie"] = engineCookies[item.engine];
  }

  try {
    await sleep(DORK_HTML_DELAY_MS[item.engine] || 3000);
    const response = await fetch(item.url, {
      method: "GET",
      redirect: "follow",
      headers,
      signal: controller.signal,
    });
    const html = await response.text();
    if (response.status === 429) {
      return { ...item, status: "rate_limited", totalResults: null, visibleResults: 0, error: "HTTP 429", checkedAt };
    }
    const initialCookies = extractCookies(response);

    if (detectChallenge(item.engine, html)) {
      return { ...item, status: "blocked", totalResults: null, visibleResults: 0, error: "anti-bot challenge", checkedAt, html, initialCookies };
    }
    if (item.engine === "google" && detectGoogleJsOnly(html)) {
      return {
        ...item,
        source: "google-html",
        status: "blocked",
        totalResults: null,
        visibleResults: 0,
        error: "Google returned JS-only page; add googlecse token for reliable counts",
        checkedAt,
        html,
        initialCookies,
      };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let totalResults = parseResultCount(html);
    const visibleResults = countVisibleResults(html, item.engine);
    if (visibleResults === 0 && totalResults === null) {
      totalResults = 0;
    }
    return {
      ...item,
      status: totalResults === null && visibleResults === 0 ? "unknown" : "ok",
      totalResults,
      visibleResults,
      error: null,
      checkedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (
      message.includes("HTTP 429") ||
      lower.includes("limit") ||
      lower.includes("quota") ||
      lower.includes("balance") ||
      lower.includes("exhausted")
    ) {
      return { ...item, status: "rate_limited", totalResults: null, visibleResults: 0, error: message, checkedAt };
    }
    return { ...item, status: "error", totalResults: null, visibleResults: 0, error: message, checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function executeDorkStatsTask(projectId, onProgress, runId) {
  const { db } = getDbState();
  const emit = async (progress, stage, processed = 0, total = 0) => {
    if (onProgress) {
      await onProgress({ progress, stage, processed, total });
    }
  };

  await emit(5, "Loading project");
  const project = db.prepare("SELECT id, domain FROM projects WHERE id = ? LIMIT 1").get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const domain = getPrimaryProjectDomain(project.id, project.domain);
  if (!domain) {
    throw new Error("Add a domain to the project before running dork stats");
  }

  let selectedEngines = null;
  if (runId) {
    try {
      const run = db.prepare("SELECT task_payload FROM scan_runs WHERE id = ? LIMIT 1").get(runId);
      if (run && run.task_payload) {
        const payload = JSON.parse(run.task_payload);
        if (Array.isArray(payload?.engines)) {
          selectedEngines = payload.engines;
        }
      }
    } catch (err) {
      console.error("[dork-stats-task] failed to parse scan_runs task_payload", err);
    }
  }

  let queries = buildDorkQueries(domain);
  if (selectedEngines) {
    queries = queries.filter((q) => selectedEngines.includes(q.engine));
  }
  const providerSettings = new Map(getProviderRuntimeSettings().map((item) => [item.provider, item]));
  const googleCse = parseTwoPartToken(getEnabledProviderToken(providerSettings, "googlecse"));
  const yandexSearchApi = parseTwoPartToken(getEnabledProviderToken(providerSettings, "yandexsearchapi"));
  const rows = [];
  const rateLimitedEngines = new Set();
  for (let index = 0; index < queries.length; index += 1) {
    const item = queries[index];
    if (rateLimitedEngines.has(item.engine)) {
      rows.push(makeDorkResult(item, "skipped", `${item.engine} rate limited earlier in this run`));
      continue;
    }
    await emit(10 + Math.round((index / queries.length) * 75), `Checking ${item.label}`, index, queries.length);
    let row = await fetchDorkStat(item, { googleCse, yandexSearchApi });

    if (runId && row.status === "blocked" && (row.error === "anti-bot challenge" || (row.error && row.error.includes("JS-only page")))) {
      const engine = item.engine;
      const sessionId = createId();
      const now = nowIso();
      const captchaHtml = row.html || "";
      const originalUrl = item.url;

      db.prepare(`
        INSERT INTO dork_captcha_sessions (id, run_id, engine, captcha_html, original_url, status, cookies, created_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
        ON CONFLICT(run_id, engine) DO UPDATE SET
          status = 'PENDING',
          captcha_html = excluded.captcha_html,
          original_url = excluded.original_url,
          created_at = excluded.created_at,
          resolved_at = NULL,
          cookies = excluded.cookies
      `).run(sessionId, runId, engine, captchaHtml, originalUrl, row.initialCookies || null, now);

      await emit(
        10 + Math.round((index / queries.length) * 75),
        `Awaiting captcha: ${engine}`,
        index,
        queries.length
      );

      let resolvedSession = null;
      while (true) {
        const run = db.prepare("SELECT cancel_requested FROM scan_runs WHERE id = ? LIMIT 1").get(runId);
        if (!run || run.cancel_requested) {
          throw new Error("Canceled by user");
        }

        resolvedSession = db.prepare(`
          SELECT cookies, resolved_html FROM dork_captcha_sessions
          WHERE run_id = ? AND engine = ? AND status = 'RESOLVED'
          LIMIT 1
        `).get(runId, engine);

        if (resolvedSession) {
          break;
        }

        await sleep(1500);
      }

      engineCookies[engine] = resolvedSession.cookies || "";
      await emit(10 + Math.round((index / queries.length) * 75), `Retrying ${item.label}`, index, queries.length);

      if (resolvedSession.resolved_html) {
        let totalResults = parseResultCount(resolvedSession.resolved_html);
        const visibleResults = countVisibleResults(resolvedSession.resolved_html, engine);
        if (visibleResults === 0 && totalResults === null) {
          totalResults = 0;
        }
        row = {
          ...item,
          status: totalResults === null && visibleResults === 0 ? "unknown" : "ok",
          totalResults,
          visibleResults,
          error: null,
          checkedAt: nowIso(),
        };
      } else {
        row = await fetchDorkStat(item, { googleCse, yandexSearchApi });
      }
    }

    rows.push(row);
    if (row.status === "rate_limited") {
      rateLimitedEngines.add(item.engine);
    }
  }

  const result = {
    domain,
    summary: {
      totalQueries: rows.length,
      ok: rows.filter((item) => item.status === "ok").length,
      blocked: rows.filter((item) => item.status === "blocked").length,
      rateLimited: rows.filter((item) => item.status === "rate_limited").length,
      skipped: rows.filter((item) => item.status === "skipped").length,
      errors: rows.filter((item) => item.status === "error").length,
      highRiskHits: rows.filter((item) => item.risk === "high" && Number(item.totalResults || item.visibleResults || 0) > 0).length,
      mediumRiskHits: rows.filter((item) => item.risk === "medium" && Number(item.totalResults || item.visibleResults || 0) > 0).length,
    },
    rows,
    source: "dork-stats",
    loadedAt: nowIso(),
  };

  await emit(92, "Saving dork stats", rows.length, rows.length);
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_dork_stats (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project.id, JSON.stringify(result), "dork-stats", now, now);

  await emit(98, "Dork stats completed", rows.length, rows.length);
  return { ok: true, summary: result.summary };
}

module.exports = {
  executeDorkStatsTask,
};
