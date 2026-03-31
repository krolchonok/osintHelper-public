#!/usr/bin/env node
/* eslint-disable no-console */

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function inScope(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
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
        } catch {}
      }
    }
  }
}

function extractHostsFromSearchHtml(text, domain) {
  const hosts = new Set(extractHostsFromText(text, domain));

  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  for (const match of text.matchAll(urlRegex)) {
    tryExtractHostFromUrl(match[0], domain, hosts);
  }

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

    tryExtractHostFromUrl(`https://yandex.com${raw}`, domain, hosts);
    tryExtractHostFromUrl(`https://www.google.com${raw}`, domain, hosts);
    tryExtractHostFromUrl(`https://www.bing.com${raw}`, domain, hosts);
  }

  return Array.from(hosts).sort();
}

function buildUrls(engine, domain, pages) {
  const queries = [`site:${domain}`, `site:*.${domain}`];
  const urls = [];

  for (const query of queries) {
    for (let page = 0; page < pages; page += 1) {
      if (engine === "google") {
        const start = page * 100;
        urls.push(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=100&start=${start}&hl=en`);
      } else if (engine === "bing") {
        const first = page * 50 + 1;
        urls.push(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=50&first=${first}&setlang=en`);
      } else if (engine === "yandex") {
        urls.push(`https://yandex.com/search/?text=${encodeURIComponent(query)}&p=${page}&lang=en`);
      }
    }
  }

  return urls;
}

function parseArgs(argv) {
  const args = { domain: "", engine: "yandex", pages: 2 };
  for (const raw of argv) {
    if (raw.startsWith("--domain=")) {
      args.domain = raw.slice("--domain=".length).trim().toLowerCase();
    } else if (raw.startsWith("--engine=")) {
      args.engine = raw.slice("--engine=".length).trim().toLowerCase();
    } else if (raw.startsWith("--pages=")) {
      args.pages = Math.max(1, Number(raw.slice("--pages=".length)) || 2);
    }
  }
  return args;
}

async function main() {
  const { domain, engine, pages } = parseArgs(process.argv.slice(2));
  if (!domain) {
    console.error("Usage: node src/scripts/test-dork-parse.js --domain=example.com [--engine=yandex|google|bing] [--pages=2]");
    process.exit(1);
  }

  if (!["google", "bing", "yandex"].includes(engine)) {
    console.error("Invalid engine. Use google, bing, or yandex.");
    process.exit(1);
  }

  const urls = buildUrls(engine, domain, pages);
  const allHosts = new Set();

  console.log(`[test-dork-parse] engine=${engine} domain=${domain} urls=${urls.length}`);

  for (const url of urls) {
    const started = Date.now();
    try {
      const response = await fetch(url, { headers: DEFAULT_HEADERS, redirect: "follow" });
      const text = await response.text();
      const hosts = extractHostsFromSearchHtml(text, domain);

      for (const host of hosts) {
        allHosts.add(host);
      }

      console.log(`[ok] status=${response.status} elapsedMs=${Date.now() - started} hosts=${hosts.length} url=${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[error] elapsedMs=${Date.now() - started} error=${message} url=${url}`);
    }
  }

  const sorted = Array.from(allHosts).sort();
  console.log(`\nFound ${sorted.length} unique hosts:`);
  for (const host of sorted) {
    console.log(host);
  }
}

void main();
