const JUNK_DOMAINS = new Set([
  "list-org.com",
  "cdn.list-org.com",
  "w3.org",
  "schema.org",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "yandex.ru",
  "yandex.net",
  "facebook.com",
  "twitter.com",
  "linkedin.com",
  "bootstrapcdn.com",
  "jquery.com",
  "cloudflare.com",
  "viewdns.info",
  "digitalcaramel.com",
]);

function normalizeDomain(raw) {
  let value = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");

  if (!value || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value)) {
    return null;
  }

  if (JUNK_DOMAINS.has(value)) {
    return null;
  }

  return value;
}

function normalizeDomainFromUrl(raw) {
  return normalizeDomain(raw);
}

function domainsFromText(text) {
  const found = new Set();
  const source = String(text || "");
  for (const match of source.matchAll(/https?:\/\/(?:www\.)?([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const domain = normalizeDomain(match[1]);
    if (domain) {
      found.add(domain);
    }
  }
  for (const match of source.matchAll(/\b(?:www\.)?([a-z0-9][a-z0-9.-]+\.(?:ru|рф|com|org|net|io|biz|info|su|dev|app|bank|online|site|store|tech|pro|me|cc|ua|by|kz))\b/gi)) {
    const domain = normalizeDomain(match[1]);
    if (domain) {
      found.add(domain);
    }
  }
  return [...found];
}

function mergeDomainHits(entries) {
  const merged = new Map();

  for (const entry of entries || []) {
    const domain = normalizeDomain(entry.domain);
    if (!domain) {
      continue;
    }

    const source = String(entry.source || "unknown").trim() || "unknown";
    const existing = merged.get(domain);
    if (existing) {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }
      continue;
    }

    merged.set(domain, {
      domain,
      sources: [source],
    });
  }

  return [...merged.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

module.exports = {
  normalizeDomain,
  normalizeDomainFromUrl,
  domainsFromText,
  mergeDomainHits,
};
