const { buildOrgNameVariants } = require("./org-name-variants");
const { findOrgDomainsByCompany } = require("./netlas-org-domains");
const { domainsFromText, mergeDomainHits, normalizeDomain, normalizeDomainFromUrl } = require("./domain-utils");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20000;
const CRTSH_TIMEOUT_MS = 18000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceResult(source, payload = {}) {
  return {
    source,
    ok: Boolean(payload.ok),
    domains: Array.isArray(payload.domains) ? payload.domains : [],
    error: payload.error || null,
    note: payload.note || null,
    matchedOrg: payload.matchedOrg || null,
  };
}

function rankOrgVariant(value) {
  let points = 0;
  if (/^[A-Z0-9 .,&'"-]+$/.test(value)) {
    points += 20;
  }
  if (!/[А-Яа-яЁё]/.test(value)) {
    points += 10;
  }
  if (value.length <= 24) {
    points += 8;
  }
  if (value.length <= 12) {
    points += 4;
  }
  return points;
}

function sortOrgVariants(variants) {
  return [...new Set(variants || [])].sort((left, right) => rankOrgVariant(right) - rankOrgVariant(left));
}

async function fetchListOrgDomains(company) {
  const inn = String(company?.inn || "").trim();
  const ogrn = String(company?.ogrn || "").trim();
  const names = [company?.fullName, company?.shortName].filter(Boolean);
  let best = { domains: [], companyId: null, note: null };

  for (const name of names) {
    try {
      const searchUrl = `https://www.list-org.com/search?type=name&val=${encodeURIComponent(name)}`;
      const searchRes = await fetchWithTimeout(searchUrl);
      if (!searchRes.ok) {
        continue;
      }

      const searchHtml = await searchRes.text();
      const candidates = [];
      for (const match of searchHtml.matchAll(
        /href='\/company\/(\d+)'[\s\S]{0,500}?<i>инн<\/i><span>(\d+)<\/span>/gi,
      )) {
        candidates.push({ id: match[1], inn: match[2] });
      }

      let companyIds = candidates.filter((item) => !inn || item.inn === inn).map((item) => item.id);
      if (!companyIds.length && ogrn) {
        const ogrnRes = await fetchWithTimeout(
          `https://www.list-org.com/search?type=ogrn&val=${encodeURIComponent(ogrn)}`,
        );
        if (ogrnRes.ok) {
          const ogrnHtml = await ogrnRes.text();
          companyIds = [...ogrnHtml.matchAll(/href='\/company\/(\d+)'/g)].map((match) => match[1]);
        }
      }

      for (const companyId of [...new Set(companyIds)].slice(0, 5)) {
        const pageRes = await fetchWithTimeout(`https://www.list-org.com/company/${companyId}`);
        if (!pageRes.ok) {
          continue;
        }

        const pageHtml = await pageRes.text();
        const sitesBlock = pageHtml.match(/class='sites'[\s\S]*?(?=<div class='|$)/i)?.[0] || "";
        const domains = domainsFromText(sitesBlock);
        if (domains.length > best.domains.length) {
          best = {
            domains,
            companyId,
            note: `List-Org #${companyId}`,
          };
        }
      }

      if (best.domains.length) {
        return sourceResult("list-org", { ok: true, ...best });
      }
    } catch (error) {
      return sourceResult("list-org", {
        ok: false,
        error: error instanceof Error ? error.message : "List-Org lookup failed",
      });
    }
  }

  return sourceResult("list-org", {
    ok: true,
    domains: best.domains,
    note: best.companyId ? best.note : "Сайт в List-Org не указан",
  });
}

async function fetchCrtshOrgDomains(variants) {
  const tried = [];
  for (const org of sortOrgVariants(variants).slice(0, 8)) {
    if (!/^[A-Za-z0-9 .,&'"-]+$/.test(org)) {
      continue;
    }

    tried.push(org);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          `https://crt.sh/?o=${encodeURIComponent(org)}&output=json`,
          { timeoutMs: CRTSH_TIMEOUT_MS },
        );
        if (response.status === 502 && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        if (!response.ok) {
          break;
        }

        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) {
          break;
        }

        const domains = new Set();
        for (const row of rows.slice(0, 500)) {
          for (const field of [row?.common_name, row?.name_value]) {
            for (const part of String(field || "").split("\n")) {
              const host = part.replace(/^\*\./, "").trim().toLowerCase();
              const domain = normalizeDomain(host.includes(".") ? host : null);
              if (domain) {
                domains.add(domain);
              }
            }
          }
        }

        if (domains.size) {
          return sourceResult("crtsh", {
            ok: true,
            domains: [...domains].slice(0, 100),
            matchedOrg: org,
            note: `crt.sh organization=${org}`,
          });
        }
      } catch (error) {
        return sourceResult("crtsh", {
          ok: false,
          error: error instanceof Error ? error.message : "crt.sh lookup failed",
        });
      }
    }
  }

  return sourceResult("crtsh", {
    ok: true,
    domains: [],
    note: tried.length ? `crt.sh: нет сертификатов (${tried.join(", ")})` : "crt.sh: нет латинских вариантов",
  });
}

async function fetchViewDnsDomains(variants) {
  for (const org of sortOrgVariants(variants).slice(0, 5)) {
    if (!/^[A-Za-z0-9 .,&'"-]+$/.test(org)) {
      continue;
    }

    try {
      const response = await fetchWithTimeout(
        `https://viewdns.info/reversewhois/?q=${encodeURIComponent(org)}`,
        { headers: { Accept: "text/html" } },
      );
      if (!response.ok) {
        continue;
      }

      const html = await response.text();
      const domains = new Set();
      for (const match of html.matchAll(
        /whitespace-nowrap text-base font-medium[^>]*>([a-z0-9][a-z0-9.-]+\.[a-z]{2,})</gi,
      )) {
        const domain = normalizeDomain(match[1]);
        if (domain) {
          domains.add(domain);
        }
      }

      if (domains.size) {
        return sourceResult("viewdns", {
          ok: true,
          domains: [...domains].slice(0, 100),
          matchedOrg: org,
          note: "ViewDNS reverse WHOIS (web)",
        });
      }
    } catch (error) {
      return sourceResult("viewdns", {
        ok: false,
        error: error instanceof Error ? error.message : "ViewDNS lookup failed",
      });
    }
  }

  return sourceResult("viewdns", { ok: true, domains: [], note: "ViewDNS: совпадений нет" });
}

async function fetchCheckoDomains(inn) {
  const apiKey = String(process.env.CHECKO_API_KEY || "").trim();
  if (!apiKey) {
    return sourceResult("checko", {
      ok: false,
      domains: [],
      note: "CHECKO_API_KEY не задан (бесплатно ~100 запросов/день на checko.ru)",
    });
  }

  const endpoint =
    inn.length === 12
      ? `https://api.checko.ru/v2/entrepreneur?key=${encodeURIComponent(apiKey)}&inn=${encodeURIComponent(inn)}`
      : `https://api.checko.ru/v2/company?key=${encodeURIComponent(apiKey)}&inn=${encodeURIComponent(inn)}`;

  try {
    const response = await fetchWithTimeout(endpoint, { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.meta?.message || payload?.error || `HTTP ${response.status}`);
    }

    const website =
      payload?.data?.Контакты?.["Веб-сайт"] ||
      payload?.data?.Контакты?.["ВебСайт"] ||
      payload?.data?.Контакты?.ВебСайт ||
      payload?.data?.contacts?.website ||
      payload?.data?.site ||
      null;
    const domains = domainsFromText(String(website || ""));
    return sourceResult("checko", {
      ok: true,
      domains,
      note: domains.length ? "Checko API" : "Checko: сайт не указан",
    });
  } catch (error) {
    return sourceResult("checko", {
      ok: false,
      error: error instanceof Error ? error.message : "Checko lookup failed",
    });
  }
}

async function fetchDaDataDomains(inn) {
  const token = String(process.env.DADATA_TOKEN || process.env.DADATA_API_KEY || "").trim();
  const secret = String(process.env.DADATA_SECRET || "").trim();
  if (!token) {
    return sourceResult("dadata", {
      ok: false,
      domains: [],
      note: "DADATA_TOKEN не задан (бесплатно ~10k запросов/день на dadata.ru)",
    });
  }

  try {
    const response = await fetchWithTimeout("https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Token ${token}`,
        ...(secret ? { "X-Secret": secret } : {}),
      },
      body: JSON.stringify({ query: inn }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || `HTTP ${response.status}`);
    }

    const suggestion = Array.isArray(payload?.suggestions) ? payload.suggestions[0] : null;
    const data = suggestion?.data || {};
    const domains = new Set();

    for (const site of data?.sites || []) {
      const domain = normalizeDomainFromUrl(site);
      if (domain) {
        domains.add(domain);
      }
    }

    for (const emailEntry of data?.emails || []) {
      const email = String(emailEntry?.value || emailEntry?.data?.value || emailEntry?.data?.source || "");
      const domainPart = email.includes("@") ? email.split("@")[1] : "";
      const domain = normalizeDomain(domainPart);
      if (domain && !domain.endsWith("mail.ru") && !domain.endsWith("yandex.ru")) {
        domains.add(domain);
      }
    }

    return sourceResult("dadata", {
      ok: true,
      domains: [...domains],
      note: domains.size ? "DaData party" : "DaData: сайт/email-домен не найден",
    });
  } catch (error) {
    return sourceResult("dadata", {
      ok: false,
      error: error instanceof Error ? error.message : "DaData lookup failed",
    });
  }
}

async function fetchWhoisFreaksDomains(variants) {
  const apiKey = String(process.env.WHOISFREAKS_API_KEY || "").trim();
  if (!apiKey) {
    return sourceResult("whoisfreaks", {
      ok: false,
      domains: [],
      note: "WHOISFREAKS_API_KEY не задан (бесплатно ~500 credits на whoisfreaks.com)",
    });
  }

  for (const org of sortOrgVariants(variants).slice(0, 3)) {
    if (!/^[A-Za-z0-9 .,&'"-]+$/.test(org)) {
      continue;
    }

    try {
      const url =
        "https://api.whoisfreaks.com/v1.0/whois?apiKey=" +
        encodeURIComponent(apiKey) +
        "&whois=reverse&company=" +
        encodeURIComponent(org);
      const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      }

      const domains = new Set();
      for (const row of payload?.whois_domains || payload?.domains || []) {
        const domain = normalizeDomain(typeof row === "string" ? row : row?.domain);
        if (domain) {
          domains.add(domain);
        }
      }

      if (domains.size) {
        return sourceResult("whoisfreaks", {
          ok: true,
          domains: [...domains].slice(0, 100),
          matchedOrg: org,
          note: "WhoisFreaks reverse WHOIS",
        });
      }
    } catch (error) {
      return sourceResult("whoisfreaks", {
        ok: false,
        error: error instanceof Error ? error.message : "WhoisFreaks lookup failed",
      });
    }
  }

  return sourceResult("whoisfreaks", { ok: true, domains: [], note: "WhoisFreaks: совпадений нет" });
}

const SOURCE_BUDGET_MS = 20000;

function withBudget(source, promise) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(
        sourceResult(source, {
          ok: false,
          error: `Timed out after ${SOURCE_BUDGET_MS}ms`,
          note: "Источник отвечал слишком долго, пропущен",
        }),
      );
    }, SOURCE_BUDGET_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        resolve(
          sourceResult(source, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    );
  });
}

async function lookupCompanyDomains(company) {
  const variants = buildOrgNameVariants(company);
  const sourceResults = [];

  const runners = [
    () => withBudget("list-org", fetchListOrgDomains(company)),
    () => withBudget("checko", fetchCheckoDomains(company.inn)),
    () => withBudget("dadata", fetchDaDataDomains(company.inn)),
    () =>
      withBudget(
        "netlas",
        (async () => {
          try {
            const netlas = await findOrgDomainsByCompany(company);
            return sourceResult("netlas", {
              ok: true,
              domains: netlas.domains,
              matchedOrg: netlas.matchedOrg,
              note: netlas.hasNetlasKey ? "Netlas reverse WHOIS" : "Netlas (без API-ключа, лимит)",
            });
          } catch (error) {
            if (error && error.code === "NETLAS_RATE_LIMIT") {
              return sourceResult("netlas", {
                ok: false,
                error: "Netlas daily limit exceeded",
                note: "Добавь NETLAS_API_KEY или повтори завтра",
              });
            }
            return sourceResult("netlas", {
              ok: false,
              error: error instanceof Error ? error.message : "Netlas lookup failed",
            });
          }
        })(),
      ),
    () => withBudget("viewdns", fetchViewDnsDomains(variants)),
    () => withBudget("crtsh", fetchCrtshOrgDomains(variants)),
    () => withBudget("whoisfreaks", fetchWhoisFreaksDomains(variants)),
  ];

  const settled = await Promise.allSettled(runners.map((runner) => runner()));
  for (const item of settled) {
    if (item.status === "fulfilled") {
      sourceResults.push(item.value);
      continue;
    }
    sourceResults.push(
      sourceResult("unknown", {
        ok: false,
        error: item.reason instanceof Error ? item.reason.message : String(item.reason),
      }),
    );
  }

  const hits = [];
  for (const result of sourceResults) {
    for (const domain of result.domains) {
      hits.push({ domain, source: result.source });
    }
  }

  const merged = mergeDomainHits(hits);
  const matchedOrg =
    sourceResults.find((item) => item.source === "netlas" && item.matchedOrg)?.matchedOrg ||
    sourceResults.find((item) => item.matchedOrg)?.matchedOrg ||
    null;

  return {
    domains: merged.map((item) => item.domain),
    domainDetails: merged,
    matchedOrg,
    searchVariants: variants,
    sources: Object.fromEntries(sourceResults.map((item) => [item.source, item])),
    hasNetlasKey: Boolean(require("./netlas-org-domains").getNetlasApiKeys().length),
  };
}

module.exports = {
  lookupCompanyDomains,
  fetchListOrgDomains,
  fetchCrtshOrgDomains,
  fetchViewDnsDomains,
  fetchCheckoDomains,
  fetchDaDataDomains,
  fetchWhoisFreaksDomains,
};
