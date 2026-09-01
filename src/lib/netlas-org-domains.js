const { parseNetlasKeys, getProviderRuntimeSettings } = require("./provider-settings");
const { buildOrgNameVariants, buildOrgNameVariantsFromText } = require("./org-name-variants");

function getNetlasApiKeys() {
  const runtime = getProviderRuntimeSettings();
  const netlas = runtime.find((item) => item.provider === "netlas" && item.enabled);
  const fromDb = parseNetlasKeys(netlas?.token || "");
  if (fromDb.length) {
    return fromDb;
  }
  const fromEnv = parseNetlasKeys(
    process.env.NETLAS_API_KEY || process.env.NETLAS || process.env.netlas || "",
  );
  return fromEnv;
}

function buildNetlasHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    vary: "web",
    Origin: "https://app.netlas.io",
    Referer: "https://app.netlas.io/",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function netlasDiscoveryProxy(nodeType, nodeValue, apiKey) {
  const response = await fetch("https://app.netlas.io/api/discovery/node_count/", {
    method: "POST",
    headers: buildNetlasHeaders(apiKey),
    body: JSON.stringify({
      node_type: nodeType,
      node_value: nodeValue,
    }),
  });

  if (response.status === 429) {
    const err = new Error("Netlas daily request limit exceeded");
    err.code = "NETLAS_RATE_LIMIT";
    throw err;
  }

  if (!response.ok) {
    throw new Error(`Netlas node_count failed with status ${response.status}`);
  }

  const data = await response.json();
  const groups = Array.isArray(data) ? data : [data];
  return groups.flatMap((group) => (Array.isArray(group.aggregations) ? group.aggregations : []));
}

async function fetchOrgDomainsForName(org, apiKey) {
  const aggregations = await netlasDiscoveryProxy("organization", org, apiKey);
  const domainEntry = aggregations.find((item) => item.search_field_id === 80);
  const domains = Array.isArray(domainEntry?.preview) ? domainEntry.preview.filter(Boolean) : [];
  const count = Number(domainEntry?.count) || domains.length;
  return { org, domains, count };
}

async function findOrgDomainsByVariants(variants) {
  const names = [...new Set((variants || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!names.length) {
    return { domains: [], matchedOrg: null, triedOrgs: [], hasNetlasKey: false };
  }

  const sortedNames = [...names].sort((left, right) => {
    const score = (value) => {
      let points = 0;
      if (/^[A-Z0-9 .,&'"-]+$/.test(value)) points += 20;
      if (!/[А-Яа-яЁё]/.test(value)) points += 10;
      if (value.length <= 24) points += 8;
      if (value.length <= 12) points += 4;
      return points;
    };
    return score(right) - score(left);
  });

  const apiKeys = getNetlasApiKeys();
  const hasNetlasKey = apiKeys.length > 0;
  const keysToTry = hasNetlasKey ? apiKeys : [null];
  const triedOrgs = [];
  let best = { org: null, domains: [], count: 0 };

  for (const org of sortedNames) {
    for (const apiKey of keysToTry) {
      try {
        const result = await fetchOrgDomainsForName(org, apiKey);
        triedOrgs.push(org);
        if (result.count > best.count || (result.domains.length > best.domains.length && best.count === 0)) {
          best = result;
        }
        if (best.domains.length > 0) {
          return {
            domains: best.domains,
            matchedOrg: best.org,
            triedOrgs,
            hasNetlasKey,
          };
        }
      } catch (error) {
        if (error && error.code === "NETLAS_RATE_LIMIT") {
          throw error;
        }
      }
    }
  }

  return {
    domains: best.domains,
    matchedOrg: best.org,
    triedOrgs,
    hasNetlasKey,
  };
}

async function findOrgDomainsByCompany(company) {
  return findOrgDomainsByVariants(buildOrgNameVariants(company));
}

async function findOrgDomainsByText(org) {
  return findOrgDomainsByVariants(buildOrgNameVariantsFromText(org));
}

module.exports = {
  findOrgDomainsByCompany,
  findOrgDomainsByText,
  findOrgDomainsByVariants,
  getNetlasApiKeys,
};
