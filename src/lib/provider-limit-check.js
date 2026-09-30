const CHECK_TIMEOUT_MS = 15000;
const { fetchIntelxAccountInfo } = require("./intelx");
const { parseNetlasKeys } = require("./provider-settings");
const { parse2ipKeys } = require("./2ip");

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

function pickRateLimitHeaders(headers) {
  const pairs = [
    ["x-ratelimit-limit", "x-ratelimit-remaining"],
    ["x-rate-limit-limit", "x-rate-limit-remaining"],
    ["ratelimit-limit", "ratelimit-remaining"],
    ["x-ratelimit-requests-limit", "x-ratelimit-requests-remaining"],
  ];

  for (const [limitKey, remainingKey] of pairs) {
    const limit = headers.get(limitKey);
    const remaining = headers.get(remainingKey);
    if (limit || remaining) {
      return { limit, remaining };
    }
  }
  return { limit: null, remaining: null };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const method = String(options.method || "GET").toUpperCase();
  try {
    const response = await fetch(url, {
      method,
      headers: options.headers || {},
      body: Object.prototype.hasOwnProperty.call(options, "body") ? options.body : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail =
        data && typeof data.error === "string"
          ? data.error
          : data && typeof data.message === "string"
            ? data.message
            : text.slice(0, 200);
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    return { data, headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkProviderLimit(provider, token) {
  const providerId = String(provider || "").trim().toLowerCase();
  const rawToken = String(token || "").trim();
  if (!rawToken) {
    throw new Error("Token is empty");
  }

  if (providerId === "shodan") {
    const { data } = await requestJson(
      `https://api.shodan.io/api-info?key=${encodeURIComponent(rawToken)}`,
    );
    return {
      provider: providerId,
      summary: `query_credits=${Number(data?.query_credits) || 0}, scan_credits=${Number(data?.scan_credits) || 0}`,
      limit: null,
      remaining: Number(data?.query_credits) || 0,
      details: data || null,
    };
  }

  if (providerId === "securitytrails") {
    const { data, headers } = await requestJson("https://api.securitytrails.com/v1/account/usage", {
      headers: { APIKEY: rawToken },
    });
    const rates = pickRateLimitHeaders(headers);
    const monthlyUsage = Number(data?.usage) || Number(data?.current_month_usage) || null;
    return {
      provider: providerId,
      summary: monthlyUsage !== null ? `monthly_usage=${monthlyUsage}` : "Usage fetched",
      limit: rates.limit,
      remaining: rates.remaining,
      details: data || null,
    };
  }

  if (providerId === "urlscan") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetch("https://urlscan.io/api/v1/user/quotas/", {
        method: "GET",
        headers: { "api-key": rawToken },
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      const rates = pickRateLimitHeaders(response.headers);
      if (response.status === 403 && String(data?.warning || "").toLowerCase().includes("pro access")) {
        return {
          provider: providerId,
          summary: "Token valid, but account has no urlscan Pro access",
          limit: rates.limit,
          remaining: rates.remaining,
          details: data || null,
        };
      }

      if (!response.ok) {
        const detail =
          data && typeof data.warning === "string"
            ? data.warning
            : data && typeof data.message === "string"
              ? data.message
              : text.slice(0, 200);
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      return {
        provider: providerId,
        summary: "Quota fetched",
        limit: rates.limit,
        remaining: rates.remaining,
        details: data || null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (providerId === "googlecse") {
    const parts = parseTwoPartToken(rawToken);
    if (!parts) {
      throw new Error("Token format must be API_KEY|CX");
    }
    const { data, headers } = await requestJson(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(parts.first)}` +
        `&cx=${encodeURIComponent(parts.second)}&q=site:example.com&num=1&start=1`,
    );
    const rates = pickRateLimitHeaders(headers);
    return {
      provider: providerId,
      summary: `totalResults=${String(data?.searchInformation?.totalResults || "0")}`,
      limit: rates.limit,
      remaining: rates.remaining,
      details: data || null,
    };
  }

  if (providerId === "yandexsearchapi") {
    const parts = parseTwoPartToken(rawToken);
    if (!parts) {
      throw new Error("Token format must be API_KEY|FOLDER_ID");
    }
    const { data, headers } = await requestJson(
      "https://searchapi.api.cloud.yandex.net/v2/web/search",
      {
        method: "POST",
        headers: {
          Authorization: `Api-Key ${parts.first}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          folderId: parts.second,
          responseFormat: "FORMAT_XML",
          query: {
            searchType: "SEARCH_TYPE_COM",
            queryText: "site:example.com",
            page: "0",
          },
        }),
      },
    );
    const rates = pickRateLimitHeaders(headers);
    const rawData = typeof data?.rawData === "string" ? data.rawData : "";
    let xml = "";
    if (rawData) {
      try {
        xml = Buffer.from(rawData, "base64").toString("utf8");
      } catch {
        xml = "";
      }
    }
    const docsMatch = xml.match(/<found[^>]*>(\d+)<\/found>/i);
    return {
      provider: providerId,
      summary: `found=${docsMatch ? docsMatch[1] : "?"}`,
      limit: rates.limit,
      remaining: rates.remaining,
      details: null,
    };
  }

  if (providerId === "virustotal") {
    const { data, headers } = await requestJson("https://www.virustotal.com/api/v3/users/current", {
      headers: { "x-apikey": rawToken },
    });
    const rates = pickRateLimitHeaders(headers);
    const attrs = data?.data?.attributes || {};
    const quotas = attrs.api_quota_group || attrs.quotas || attrs.quota || null;
    return {
      provider: providerId,
      summary: quotas ? "Quota profile fetched" : "Token is valid",
      limit: rates.limit,
      remaining: rates.remaining,
      details: quotas || attrs || null,
    };
  }

  if (providerId === "netlas") {
    const keys = parseNetlasKeys(rawToken);
    const accounts = await Promise.all(keys.map(async (key) => {
      const { data, headers } = await requestJson("https://app.netlas.io/api/users/profile_data/", {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      });
      const rates = pickRateLimitHeaders(headers);
      const requestsLeft = data?.requests_left || {};
      const coins = data?.coins || {};
      return {
        key: `${key.slice(0, 6)}...`,
        requestsLeft: Number(requestsLeft.remained) || 0,
        requestsLimit: Number(requestsLeft.limit) || 0,
        coinsLeft: Number(coins.left) || 0,
        rateLimit: rates.limit,
        rateRemaining: rates.remaining,
      };
    }));
    const totalLeft = accounts.reduce((s, a) => s + a.requestsLeft, 0);
    const totalLimit = accounts.reduce((s, a) => s + a.requestsLimit, 0);
    return {
      provider: providerId,
      summary: accounts.map((a) => `${a.key}: requests=${a.requestsLeft}/${a.requestsLimit}, coins=${a.coinsLeft}`).join(" | "),
      limit: totalLimit || null,
      remaining: totalLeft,
      details: accounts,
    };
  }

  if (providerId === "intelx") {
    const accounts = await fetchIntelxAccountInfo(rawToken);
    const totalAvailable = accounts.reduce((sum, item) => sum + Number(item.available || 0), 0);
    const totalMax = accounts.reduce((sum, item) => sum + Number(item.creditMax || 0), 0);
    return {
      provider: providerId,
      summary: `keys=${accounts.length}, available=${totalAvailable}, max=${totalMax}`,
      limit: totalMax || null,
      remaining: totalAvailable,
      details: accounts,
    };
  }

  if (providerId === "2ip") {
    const keys = parse2ipKeys(rawToken);
    const accounts = await Promise.all(keys.map(async (key) => {
      const { data, headers } = await requestJson(
        `https://api.2ip.me/geo.json?ip=${encodeURIComponent("8.8.8.8")}&token=${encodeURIComponent(key)}`,
      );
      const rates = pickRateLimitHeaders(headers);
      return {
        key: `${key.slice(0, 6)}...`,
        ok: Boolean(data?.ip),
        rateLimit: rates.limit,
        rateRemaining: rates.remaining,
      };
    }));
    return {
      provider: providerId,
      summary: accounts.map((item) => `${item.key}: ${item.ok ? "valid" : "checked"}`).join(" | "),
      limit: null,
      remaining: null,
      details: accounts,
    };
  }

  if (providerId === "zoomeye") {
    const { data } = await requestJson("https://api.zoomeye.ai/v2/userinfo", {
      method: "POST",
      headers: {
        "API-KEY": rawToken,
        "Content-Type": "application/json",
      },
    });
    const sub = data?.data?.subscription || {};
    const points = typeof sub.points === "number" ? sub.points : 0;
    const zoomeyePoints = typeof sub.zoomeye_points === "number" ? sub.zoomeye_points : 0;
    return {
      provider: providerId,
      summary: `points=${points}, zoomeye_points=${zoomeyePoints}, plan=${sub.plan || "Free"}`,
      limit: null,
      remaining: points + zoomeyePoints,
      details: data || null,
    };
  }

  const probes = {
    bevigil: {
      url: `https://osint.bevigil.com/api/${encodeURIComponent("example.com")}/subdomains/`,
      headers: { "X-Access-Token": rawToken, "User-Agent": "node-sqlite-app" },
    },
    bufferover: {
      url: `https://tls.bufferover.run/dns?q=.${encodeURIComponent("example.com")}`,
      headers: { "x-api-key": rawToken },
    },
    fullhunt: {
      url: `https://fullhunt.io/api/v1/domain/${encodeURIComponent("example.com")}/subdomains`,
      headers: { "X-API-KEY": rawToken },
    },
    whoisxmlapi: {
      url:
        `https://subdomains.whoisxmlapi.com/api/v1?apiKey=${encodeURIComponent(rawToken)}` +
        `&domainName=${encodeURIComponent("example.com")}`,
      headers: {},
    },
    threatbook: {
      url:
        `https://api.threatbook.cn/v3/domain/sub_domains?apikey=${encodeURIComponent(rawToken)}` +
        `&resource=${encodeURIComponent("example.com")}`,
      headers: {},
    },
    reconeer: {
      url: `https://www.reconeer.com/api/domain/${encodeURIComponent("example.com")}`,
      headers: { "X-API-KEY": rawToken, Accept: "application/json" },
    },
  };

  const probe = probes[providerId];
  if (!probe) {
    throw new Error("Limit check is not implemented for this provider");
  }

  const { data, headers } = await requestJson(probe.url, { headers: probe.headers });
  const rates = pickRateLimitHeaders(headers);
  return {
    provider: providerId,
    summary: "Token is valid",
    limit: rates.limit,
    remaining: rates.remaining,
    details: data || null,
  };
}

module.exports = {
  checkProviderLimit,
};
