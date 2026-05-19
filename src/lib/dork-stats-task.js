const { getDbState } = require("../db");
const { getPrimaryProjectDomain } = require("./project-domains");
const { getProviderRuntimeSettings } = require("./provider-settings");
const { nowIso } = require("./utils");

const DORK_TIMEOUT_MS = 18000;
const DORK_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru,en;q=0.8",
};

function buildDorkQueries(domain) {
  return [
    {
      engine: "google",
      label: "Google: site",
      query: `site:${domain}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:${domain}`)}&hl=ru&num=100&pws=0&filter=0`,
    },
    {
      engine: "google",
      label: "Google: *.site",
      query: `site:*.${domain}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(`site:*.${domain}`)}&hl=ru&num=100&pws=0&filter=0`,
    },
    {
      engine: "yandex",
      label: "Yandex: site",
      query: `site:${domain}`,
      url: `https://yandex.ru/search/?text=${encodeURIComponent(`site:${domain}`)}`,
    },
    {
      engine: "yandex",
      label: "Yandex: *.site",
      query: `site:*.${domain}`,
      url: `https://yandex.ru/search/?text=${encodeURIComponent(`site:*.${domain}`)}`,
    },
  ];
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
    throw new Error(`Google API HTTP ${response.status}`);
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
    return {
      ...item,
      status: "error",
      totalResults: null,
      visibleResults: 0,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: nowIso(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DORK_TIMEOUT_MS);
  const checkedAt = nowIso();

  try {
    const response = await fetch(item.url, {
      method: "GET",
      redirect: "follow",
      headers: DORK_HEADERS,
      signal: controller.signal,
    });
    const html = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (detectChallenge(item.engine, html)) {
      return { ...item, status: "blocked", totalResults: null, visibleResults: 0, error: "anti-bot challenge", checkedAt };
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
      };
    }

    const totalResults = parseResultCount(html);
    const visibleResults = countVisibleResults(html, item.engine);
    return {
      ...item,
      status: totalResults === null && visibleResults === 0 ? "unknown" : "ok",
      totalResults,
      visibleResults,
      error: null,
      checkedAt,
    };
  } catch (error) {
    return {
      ...item,
      status: "error",
      totalResults: null,
      visibleResults: 0,
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeDorkStatsTask(projectId, onProgress) {
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

  const queries = buildDorkQueries(domain);
  const providerSettings = new Map(getProviderRuntimeSettings().map((item) => [item.provider, item]));
  const googleCse = parseTwoPartToken(getEnabledProviderToken(providerSettings, "googlecse"));
  const yandexSearchApi = parseTwoPartToken(getEnabledProviderToken(providerSettings, "yandexsearchapi"));
  const rows = [];
  for (let index = 0; index < queries.length; index += 1) {
    const item = queries[index];
    await emit(10 + Math.round((index / queries.length) * 75), `Checking ${item.label}`, index, queries.length);
    rows.push(await fetchDorkStat(item, { googleCse, yandexSearchApi }));
  }

  const result = {
    domain,
    summary: {
      totalQueries: rows.length,
      ok: rows.filter((item) => item.status === "ok").length,
      blocked: rows.filter((item) => item.status === "blocked").length,
      errors: rows.filter((item) => item.status === "error").length,
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
