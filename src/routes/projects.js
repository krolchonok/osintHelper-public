const express = require("express");
const net = require("node:net");
const { requireApiUser } = require("../lib/auth");
const { parseDomainInput, normalizeDomain, isValidDomain } = require("../lib/domains");
const { startRun } = require("../lib/jobs");
const { enqueueScanJob, removeScanJobsByRunIds } = require("../lib/job-queue");
const { getDbState } = require("../db");
const { createId, nowIso } = require("../lib/utils");
const { SUPPORTED_PASSIVE_SOURCE_IDS } = require("../lib/passive-scan");
const { fetchDomainWhois: fetchDomainWhoisLib } = require("../lib/whois");
const { getProviderRuntimeSettings } = require("../lib/provider-settings");
const { createIntelxClient } = require("../lib/intelx");
const {
  getPrimaryProjectDomain,
  getProjectScopeDomains,
  isHostInProjectScope,
  listProjectDomains,
  upsertProjectDomain,
} = require("../lib/project-domains");

const router = express.Router();
const SUBDOMAIN_PAGE_LIMITS = new Set([100, 250, 500]);
const DEFAULT_SUBDOMAIN_PAGE_LIMIT = 100;

function parsePositiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return value;
}

function normalizeSubdomainPageLimit(raw) {
  const value = parsePositiveInt(raw, DEFAULT_SUBDOMAIN_PAGE_LIMIT);
  if (!SUBDOMAIN_PAGE_LIMITS.has(value)) {
    return DEFAULT_SUBDOMAIN_PAGE_LIMIT;
  }
  return value;
}

function normalizeHostInput(rawHost) {
  return normalizeDomain(String(rawHost || "")).replace(/\.$/, "");
}

function formatProjectScopeMessage(projectDomains) {
  if (!projectDomains.length) {
    return "Add a domain to the project first";
  }
  return `Host must be in project scope (${projectDomains.map((domain) => `*.${domain}`).join(", ")})`;
}

function normalizeProjectName(rawName) {
  return String(rawName || "").trim();
}

function ensureProjectHasPrimaryDomain(project, actionLabel = "run this action") {
  const primaryDomain = getPrimaryProjectDomain(project.id, project.domain);
  if (!primaryDomain) {
    const error = new Error(`Add a domain to the project before you ${actionLabel}`);
    error.status = 400;
    throw error;
  }
  return primaryDomain;
}

function buildProjectFileStem(project) {
  const preferred =
    String(project?.name || "").trim() ||
    String(project?.domain || "").trim() ||
    String(project?.id || "project").trim();
  const sanitized = preferred
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "project";
}

function extractRdapEntityName(entity) {
  const card = Array.isArray(entity?.vcardArray) ? entity.vcardArray : [];
  const fields = Array.isArray(card[1]) ? card[1] : [];
  for (const row of fields) {
    if (!Array.isArray(row) || row.length < 4) {
      continue;
    }
    if (String(row[0]).toLowerCase() === "fn") {
      return String(row[3] || "").trim();
    }
  }
  return "";
}

async function fetchDomainWhois(domain) {
  function queryWhoisServer(server, query, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: server, port: 43 });
      let settled = false;
      let chunks = "";

      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      };

      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs);

      socket.on("connect", () => {
        socket.write(`${query}\r\n`);
      });
      socket.on("data", (data) => {
        chunks += String(data || "");
      });
      socket.on("end", () => finish(null, chunks));
      socket.on("timeout", () => finish(new Error("WHOIS timeout")));
      socket.on("error", (error) => finish(error));
    });
  }

  function parseWhoisByKey(text, keys) {
    const lines = String(text || "").split(/\r?\n/);
    for (const key of keys) {
      const lowerKey = String(key).toLowerCase();
      const line = lines.find((row) => String(row).toLowerCase().startsWith(`${lowerKey}:`));
      if (!line) {
        continue;
      }
      const value = line.slice(line.indexOf(":") + 1).trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  function parseWhoisList(text, keys) {
    const lines = String(text || "").split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      const normalized = String(line || "").trim();
      if (!normalized || normalized.startsWith("%") || normalized.startsWith("#")) {
        continue;
      }
      const idx = normalized.indexOf(":");
      if (idx <= 0) {
        continue;
      }
      const key = normalized.slice(0, idx).trim().toLowerCase();
      const value = normalized.slice(idx + 1).trim();
      if (!value) {
        continue;
      }
      if (keys.includes(key)) {
        out.push(value.toLowerCase());
      }
    }
    return Array.from(new Set(out));
  }

  async function requestRdap(endpoint) {
    const response = await fetch(endpoint, { method: "GET" });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error("WHOIS response is not valid JSON");
    }
  }

  function normalizeRdapBase(base) {
    const value = String(base || "").trim();
    if (!value) {
      return "";
    }
    return value.endsWith("/") ? value : `${value}/`;
  }

  const endpoints = [];
  endpoints.push(`https://rdap.org/domain/${encodeURIComponent(domain)}`);

  try {
    const bootstrap = await fetch("https://data.iana.org/rdap/dns.json", { method: "GET" });
    if (bootstrap.ok) {
      const data = await bootstrap.json();
      const services = Array.isArray(data?.services) ? data.services : [];
      const domainParts = String(domain).toLowerCase().split(".");
      const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : "";
      const match = services.find((entry) => {
        const tlds = Array.isArray(entry?.[0]) ? entry[0].map((item) => String(item).toLowerCase()) : [];
        return tlds.includes(tld);
      });

      const urls = Array.isArray(match?.[1]) ? match[1] : [];
      for (const base of urls) {
        const normalized = normalizeRdapBase(base);
        if (!normalized) {
          continue;
        }
        endpoints.push(`${normalized}domain/${encodeURIComponent(domain)}`);
      }
    }
  } catch {
    // Ignore bootstrap failure and keep rdap.org fallback only.
  }

  let data = null;
  let lastStatus = null;
  let usedEndpoint = endpoints[0];
  for (const endpoint of Array.from(new Set(endpoints))) {
    try {
      data = await requestRdap(endpoint);
      usedEndpoint = endpoint;
      break;
    } catch (error) {
      if (typeof error?.status === "number") {
        lastStatus = error.status;
      }
      usedEndpoint = endpoint;
    }
  }

  if (!data) {
    // Fallback to classic WHOIS (port 43) when RDAP is missing.
    const tld = String(domain).toLowerCase().split(".").pop();
    if (!tld) {
      throw new Error("WHOIS/RDAP not found for this domain");
    }

    let ianaText = "";
    try {
      ianaText = await queryWhoisServer("whois.iana.org", tld);
    } catch {
      ianaText = "";
    }

    const whoisServer =
      parseWhoisByKey(ianaText, ["whois"]) ||
      parseWhoisByKey(ianaText, ["refer"]) ||
      null;

    if (!whoisServer) {
      if (lastStatus === 404) {
        throw new Error("WHOIS/RDAP not found for this domain");
      }
      throw new Error(`WHOIS request failed (${lastStatus || "unknown error"})`);
    }

    let whoisText = "";
    try {
      whoisText = await queryWhoisServer(whoisServer, domain);
    } catch {
      whoisText = "";
    }

    if (!whoisText.trim()) {
      throw new Error("WHOIS/RDAP not found for this domain");
    }

    const registrar = parseWhoisByKey(whoisText, ["registrar", "registrar name", "org"]);
    const inn = parseWhoisByKey(whoisText, ["inn", "taxpayer-id", "tin"]);
    const createdAt = parseWhoisByKey(whoisText, ["creation date", "created", "created on", "created-date"]);
    const updatedAt = parseWhoisByKey(whoisText, ["updated date", "last updated on", "changed", "changed-date"]);
    const expiresAt = parseWhoisByKey(whoisText, ["registry expiry date", "expiration date", "paid-till", "expires", "expiry date"]);
    const statusRaw = parseWhoisList(whoisText, ["status", "state", "domain status"]);
    const nameservers = parseWhoisList(whoisText, ["name server", "nserver", "nameserver", "ns"]);

    return {
      domain,
      registrar: registrar || null,
      inn: inn || null,
      registrant: parseWhoisByKey(whoisText, ["person", "org", "registrant", "registrant organization"]) || null,
      registrarWhois: whoisServer || null,
      country: parseWhoisByKey(whoisText, ["country", "registrant country"]) || null,
      emails: parseWhoisList(whoisText, ["e-mail", "email", "admin email", "registrant email"]),
      dnssec: parseWhoisByKey(whoisText, ["dnssec"]) || null,
      status: statusRaw,
      nameservers,
      createdAt: createdAt || null,
      updatedAt: updatedAt || null,
      expiresAt: expiresAt || null,
      rdapUrl: `whois://${whoisServer}`,
    };
  }

  const statuses = Array.isArray(data?.status) ? data.status.map((item) => String(item)) : [];
  const nameservers = Array.isArray(data?.nameservers)
    ? data.nameservers
        .map((item) => String(item?.ldhName || item?.unicodeName || "").toLowerCase().trim())
        .filter(Boolean)
    : [];

  const events = Array.isArray(data?.events) ? data.events : [];
  const findEventDate = (key) => {
    const event = events.find((row) => String(row?.eventAction || "").toLowerCase() === key);
    return event?.eventDate || null;
  };

  const entities = Array.isArray(data?.entities) ? data.entities : [];
  const registrarEntity = entities.find((entity) =>
    Array.isArray(entity?.roles) &&
    entity.roles.map((role) => String(role).toLowerCase()).includes("registrar"),
  );
  const registrar = extractRdapEntityName(registrarEntity);

  return {
    domain,
    registrar: registrar || null,
    inn: null,
    registrant: null,
    registrarWhois: null,
    country: null,
    emails: [],
    dnssec: null,
    status: statuses,
    nameservers,
    createdAt: findEventDate("registration"),
    updatedAt: findEventDate("last changed"),
    expiresAt: findEventDate("expiration"),
    rdapUrl: usedEndpoint,
  };
}

function mapRun(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    taskKind: row.task_kind || null,
    scanScope: row.scan_scope || "core",
    cancelRequested: Boolean(row.cancel_requested),
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    processed: row.processed,
    total: row.total,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    createdAt: row.created_at,
  };
}

function getCachedWhois(projectId) {
  const { db } = getDbState();
  const row = db
    .prepare("SELECT data_json, source, updated_at FROM project_whois WHERE project_id = ? LIMIT 1")
    .get(projectId);
  if (!row || !row.data_json) {
    return null;
  }
  try {
    const data = JSON.parse(row.data_json);
    return {
      ...data,
      source: row.source || data.source || null,
      cachedAt: row.updated_at || null,
    };
  } catch {
    return null;
  }
}

function saveCachedWhois(projectId, whois) {
  const { db } = getDbState();
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_whois (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(projectId, JSON.stringify(whois || {}), whois?.source || whois?.rdapUrl || null, now, now);
}

function getCachedVtDeep(projectId) {
  const { db } = getDbState();
  const row = db
    .prepare("SELECT data_json, source, updated_at FROM project_vt_deep WHERE project_id = ? LIMIT 1")
    .get(projectId);
  if (!row || !row.data_json) {
    return null;
  }
  try {
    const data = JSON.parse(row.data_json);
    return {
      ...data,
      source: row.source || data.source || "virustotal",
      cachedAt: row.updated_at || null,
    };
  } catch {
    return null;
  }
}

function saveCachedVtDeep(projectId, result) {
  const { db } = getDbState();
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_vt_deep (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(projectId, JSON.stringify(result || {}), "virustotal", now, now);
}

function getCachedIntelxLeaks(projectId) {
  const { db } = getDbState();
  const row = db
    .prepare("SELECT data_json, source, updated_at FROM project_intelx_leaks WHERE project_id = ? LIMIT 1")
    .get(projectId);
  if (!row || !row.data_json) {
    return null;
  }
  try {
    const data = JSON.parse(row.data_json);
    return {
      ...data,
      source: row.source || data.source || "intelx",
      cachedAt: row.updated_at || null,
    };
  } catch {
    return null;
  }
}

function saveCachedIntelxLeaks(projectId, result) {
  const { db } = getDbState();
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_intelx_leaks (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(projectId, JSON.stringify(result || {}), "intelx", now, now);
}

function normalizeIntelxHitRef(raw) {
  const searchIndex = Number.parseInt(String(raw?.searchIndex ?? ""), 10);
  const hitIndex = Number.parseInt(String(raw?.hitIndex ?? ""), 10);
  if (!Number.isInteger(searchIndex) || searchIndex < 0 || !Number.isInteger(hitIndex) || hitIndex < 0) {
    return null;
  }
  return { searchIndex, hitIndex };
}

function normalizeIntelxCachedResult(raw) {
  const data = raw && typeof raw === "object" ? { ...raw } : {};
  const searches = Array.isArray(data.searches) ? data.searches : [];
  let totalHits = 0;

  data.searches = searches.map((entry) => {
    const nextEntry = entry && typeof entry === "object" ? { ...entry } : {};
    const hits = Array.isArray(nextEntry.hits) ? nextEntry.hits : [];
    nextEntry.hits = hits.filter((hit) => hit && typeof hit === "object");
    nextEntry.count = nextEntry.hits.length;
    totalHits += nextEntry.hits.length;
    return nextEntry;
  });

  data.summary = {
    ...(data.summary && typeof data.summary === "object" ? data.summary : {}),
    searches: data.searches.length,
    hits: totalHits,
  };

  return data;
}

function updateCachedIntelxLeaks(projectId, mutator) {
  const cached = getCachedIntelxLeaks(projectId);
  if (!cached) {
    const error = new Error("No IntelX data yet");
    error.status = 404;
    throw error;
  }

  const next = normalizeIntelxCachedResult(mutator(structuredClone(cached)));
  saveCachedIntelxLeaks(projectId, next);
  return getCachedIntelxLeaks(projectId);
}

function getCachedWebArchive(projectId) {
  const { db } = getDbState();
  const row = db
    .prepare("SELECT data_json, source, updated_at FROM project_webarchive WHERE project_id = ? LIMIT 1")
    .get(projectId);
  if (!row || !row.data_json) {
    return null;
  }
  try {
    const data = JSON.parse(row.data_json);
    return {
      ...data,
      source: row.source || data.source || "waybackarchive",
      cachedAt: row.updated_at || null,
    };
  } catch {
    return null;
  }
}

function getCachedDorkStats(projectId) {
  const { db } = getDbState();
  const row = db
    .prepare("SELECT data_json, source, updated_at FROM project_dork_stats WHERE project_id = ? LIMIT 1")
    .get(projectId);
  if (!row || !row.data_json) {
    return null;
  }
  try {
    const data = JSON.parse(row.data_json);
    return {
      ...data,
      source: row.source || data.source || "dork-stats",
      cachedAt: row.updated_at || null,
    };
  } catch {
    return null;
  }
}

function extractEmailsFromText(text) {
  const matches = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return Array.from(new Set((matches || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)));
}

function normalizeEmailValue(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function isValidEmailValue(rawEmail) {
  const email = normalizeEmailValue(rawEmail);
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email);
}

function listProjectEmailOverrides(projectId) {
  const { db } = getDbState();
  return db.prepare(`
    SELECT id, source_email, email, is_deleted, is_manual, created_at, updated_at
    FROM project_email_overrides
    WHERE project_id = ?
    ORDER BY created_at ASC
  `).all(projectId);
}

function collectProjectEmails(projectId) {
  const intelx = getCachedIntelxLeaks(projectId);
  const webarchive = getCachedWebArchive(projectId);
  const whois = getCachedWhois(projectId);
  const emailMap = new Map();
  const authorMap = new Map();
  const editorMap = new Map();

  function touchEmail(email) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (!emailMap.has(normalized)) {
      emailMap.set(normalized, {
        email: normalized,
        sources: new Set(),
        intelxTerms: new Set(),
        intelxSnippets: new Set(),
        intelxFiles: new Map(),
        webarchiveHosts: new Set(),
        webarchiveAuthors: new Set(),
        webarchiveEditors: new Set(),
        webarchiveTitles: new Set(),
        webarchiveCompanies: new Set(),
        whois: false,
      });
    }
    return emailMap.get(normalized);
  }

  function touchNamedEntity(map, rawName, document) {
    const name = String(rawName || "").trim();
    if (!name) {
      return null;
    }
    const key = name.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        name,
        sources: new Set(),
        hosts: new Set(),
        titles: new Set(),
        companies: new Set(),
        urls: new Set(),
        documentTypes: new Set(),
      });
    }
    const entry = map.get(key);
    entry.sources.add("webarchive");
    if (document?.host) {
      entry.hosts.add(String(document.host));
    }
    if (document?.metadata?.title) {
      entry.titles.add(String(document.metadata.title));
    }
    if (document?.metadata?.company) {
      entry.companies.add(String(document.metadata.company));
    }
    if (document?.url) {
      entry.urls.add(String(document.url));
    }
    if (document?.type) {
      entry.documentTypes.add(String(document.type));
    }
    return entry;
  }

  if (intelx && Array.isArray(intelx.searches)) {
    for (const search of intelx.searches) {
      const term = String(search?.term || "").trim();
      const hits = Array.isArray(search?.hits) ? search.hits : [];
      for (const hit of hits) {
        const line = String(hit?.line || "").trim();
        for (const email of extractEmailsFromText(line)) {
          const entry = touchEmail(email);
          if (!entry) {
            continue;
          }
          entry.sources.add("intelx");
          if (term) {
            entry.intelxTerms.add(term);
          }
          if (line) {
            entry.intelxSnippets.add(line);
          }
          const storageid = String(hit?.storageid || "").trim();
          const bucket = String(hit?.bucket || "").trim();
          if (storageid) {
            const fileKey = `${storageid}|${bucket || "leaks.public.general"}`;
            if (!entry.intelxFiles.has(fileKey)) {
              entry.intelxFiles.set(fileKey, {
                storageid,
                bucket: bucket || "leaks.public.general",
                term: term || "",
              });
            }
          }
        }
      }
    }
  }

  if (webarchive && Array.isArray(webarchive.documents)) {
    for (const document of webarchive.documents) {
      const host = String(document?.host || "").trim().toLowerCase();
      const emails = Array.isArray(document?.metadata?.emails) ? document.metadata.emails : [];
      if (document?.metadata?.author) {
        touchNamedEntity(authorMap, document.metadata.author, document);
      }
      if (document?.metadata?.lastModifiedBy) {
        touchNamedEntity(editorMap, document.metadata.lastModifiedBy, document);
      }
      for (const email of emails) {
        const entry = touchEmail(email);
        if (!entry) {
          continue;
        }
        entry.sources.add("webarchive");
        if (host) {
          entry.webarchiveHosts.add(host);
        }
        if (document?.metadata?.author) {
          entry.webarchiveAuthors.add(String(document.metadata.author));
        }
        if (document?.metadata?.lastModifiedBy) {
          entry.webarchiveEditors.add(String(document.metadata.lastModifiedBy));
        }
        if (document?.metadata?.title) {
          entry.webarchiveTitles.add(String(document.metadata.title));
        }
        if (document?.metadata?.company) {
          entry.webarchiveCompanies.add(String(document.metadata.company));
        }
      }
    }
  }

  if (whois && Array.isArray(whois.emails)) {
    for (const email of whois.emails) {
      const entry = touchEmail(email);
      if (!entry) {
        continue;
      }
      entry.sources.add("whois");
      entry.whois = true;
    }
  }

  const emails = Array.from(emailMap.values())
    .map((item) => ({
      sourceKey: item.email,
      email: item.email,
      sources: Array.from(item.sources).sort(),
      intelxTerms: Array.from(item.intelxTerms).sort(),
      intelxSnippets: Array.from(item.intelxSnippets).slice(0, 5),
      intelxFiles: Array.from(item.intelxFiles.values()).slice(0, 10),
      webarchiveHosts: Array.from(item.webarchiveHosts).sort(),
      webarchiveAuthors: Array.from(item.webarchiveAuthors).sort(),
      webarchiveEditors: Array.from(item.webarchiveEditors).sort(),
      webarchiveTitles: Array.from(item.webarchiveTitles).sort(),
      webarchiveCompanies: Array.from(item.webarchiveCompanies).sort(),
      whois: item.whois,
      isManual: false,
    }))
    .sort((left, right) => left.email.localeCompare(right.email));

  const bySourceKey = new Map(emails.map((item) => [item.sourceKey, item]));
  const overrides = listProjectEmailOverrides(projectId);

  for (const row of overrides) {
    const sourceKey = String(row.source_email || "").trim();
    const overrideEmail = normalizeEmailValue(row.email);
    const isDeleted = Boolean(row.is_deleted);
    const isManual = Boolean(row.is_manual);
    if (!sourceKey) {
      continue;
    }

    if (isManual) {
      if (!isDeleted && overrideEmail) {
        emails.push({
          sourceKey,
          email: overrideEmail,
          sources: ["manual"],
          intelxTerms: [],
          intelxSnippets: [],
          intelxFiles: [],
          webarchiveHosts: [],
          webarchiveAuthors: [],
          webarchiveEditors: [],
          webarchiveTitles: [],
          webarchiveCompanies: [],
          whois: false,
          isManual: true,
        });
      }
      continue;
    }

    const existing = bySourceKey.get(sourceKey);
    if (!existing) {
      continue;
    }
    if (isDeleted) {
      bySourceKey.delete(sourceKey);
      continue;
    }
    if (overrideEmail) {
      existing.email = overrideEmail;
    }
  }

  const mergedEmails = Array.from(bySourceKey.values())
    .concat(emails.filter((item) => item.isManual))
    .sort((left, right) => left.email.localeCompare(right.email));

  const authors = Array.from(authorMap.values())
    .map((item) => ({
      name: item.name,
      sources: Array.from(item.sources).sort(),
      hosts: Array.from(item.hosts).sort(),
      titles: Array.from(item.titles).sort(),
      companies: Array.from(item.companies).sort(),
      urls: Array.from(item.urls).slice(0, 10),
      documentTypes: Array.from(item.documentTypes).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const editors = Array.from(editorMap.values())
    .map((item) => ({
      name: item.name,
      sources: Array.from(item.sources).sort(),
      hosts: Array.from(item.hosts).sort(),
      titles: Array.from(item.titles).sort(),
      companies: Array.from(item.companies).sort(),
      urls: Array.from(item.urls).slice(0, 10),
      documentTypes: Array.from(item.documentTypes).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    summary: {
      total: mergedEmails.length,
      intelx: mergedEmails.filter((item) => item.sources.includes("intelx")).length,
      webarchive: mergedEmails.filter((item) => item.sources.includes("webarchive")).length,
      whois: mergedEmails.filter((item) => item.sources.includes("whois")).length,
      authors: authors.length,
      editors: editors.length,
    },
    emails: mergedEmails,
    authors,
    editors,
    loadedAt: nowIso(),
  };
}

function fetchRunEvents(runId, limit = 30) {
  const { db } = getDbState();
  return db
    .prepare(`
      SELECT id, progress, stage, processed, total, created_at
      FROM scan_run_events
      WHERE run_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(runId, limit)
    .map((row) => ({
      id: row.id,
      progress: row.progress,
      stage: row.stage,
      processed: row.processed,
      total: row.total,
      createdAt: row.created_at,
    }));
}

function fetchProjectSubdomains(projectId, options = {}) {
  const { db } = getDbState();
  const requestedPage = parsePositiveInt(options.page, 1);
  const limit = normalizeSubdomainPageLimit(options.limit);
  const total = Number(
    db.prepare("SELECT COUNT(*) AS c FROM subdomains WHERE project_id = ?").get(projectId)?.c || 0,
  );
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.max(1, Math.min(requestedPage, totalPages));
  const offset = (page - 1) * limit;

  const rows = db
    .prepare(`
      SELECT id, host, is_root, created_at, updated_at
      FROM subdomains
      WHERE project_id = ?
      ORDER BY host ASC
      LIMIT ? OFFSET ?
    `)
    .all(projectId, limit, offset);
  const subdomainIds = rows.map((row) => row.id);

  const sourcesBySubdomainId = new Map();
  const dnsRecordsBySubdomainId = new Map();
  if (subdomainIds.length) {
    const placeholders = subdomainIds.map(() => "?").join(",");
    const sourceRows = db
      .prepare(`
        SELECT subdomain_id, source, created_at
        FROM subdomain_sources
        WHERE subdomain_id IN (${placeholders})
        ORDER BY source ASC
      `)
      .all(...subdomainIds);

    for (const row of sourceRows) {
      const key = String(row.subdomain_id);
      if (!sourcesBySubdomainId.has(key)) {
        sourcesBySubdomainId.set(key, []);
      }
      sourcesBySubdomainId.get(key).push({
        source: row.source,
        createdAt: row.created_at,
      });
    }

    const dnsRows = db
      .prepare(`
        SELECT id, subdomain_id, resolver, record_type, value, data_json, created_at
        FROM dns_records
        WHERE subdomain_id IN (${placeholders}) AND record_type IN ('A', 'AAAA')
        ORDER BY created_at DESC
      `)
      .all(...subdomainIds);

    for (const row of dnsRows) {
      const key = String(row.subdomain_id);
      if (!dnsRecordsBySubdomainId.has(key)) {
        dnsRecordsBySubdomainId.set(key, []);
      }
      dnsRecordsBySubdomainId.get(key).push({
        id: row.id,
        resolver: row.resolver,
        recordType: row.record_type,
        value: row.value,
        dataJson: row.data_json,
        createdAt: row.created_at,
      });
    }
  }

  const subdomains = rows.map((row) => {
    const key = String(row.id);
    return {
      id: row.id,
      host: row.host,
      isRoot: Boolean(row.is_root),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources: sourcesBySubdomainId.get(key) || [],
      dnsRecords: dnsRecordsBySubdomainId.get(key) || [],
    };
  });

  return {
    subdomains,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
  };
}

function mapProjectWithDomains(project, extra = {}) {
  const domains = listProjectDomains(project.id);
  const primaryDomain = getPrimaryProjectDomain(project.id, project.domain);
  return {
    id: project.id,
    name: String(project.name || project.domain || project.id),
    domain: primaryDomain || null,
    primaryDomain,
    domains: domains.map((item) => item.domain),
    domainItems: domains,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    ...extra,
  };
}

function formatUnixTime(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return new Date(num * 1000).toISOString();
}

function mapVtFileItem(item, relationship) {
  const attributes = item?.attributes || {};
  const id = String(item?.id || "").trim();
  if (!id) {
    return null;
  }

  const name =
    String(attributes.meaningful_name || "").trim() ||
    (Array.isArray(attributes.names) && attributes.names.length ? String(attributes.names[0] || "").trim() : "") ||
    id;

  return {
    id,
    relationship,
    name,
    type: String(item?.type || "file"),
    sha256: String(attributes.sha256 || id),
    size: Number(attributes.size) || null,
    firstSeen: formatUnixTime(attributes.first_submission_date),
    lastSeen: formatUnixTime(attributes.last_submission_date),
    positives:
      Number(attributes.last_analysis_stats?.malicious || 0) +
      Number(attributes.last_analysis_stats?.suspicious || 0),
    total:
      Number(attributes.last_analysis_stats?.harmless || 0) +
      Number(attributes.last_analysis_stats?.undetected || 0) +
      Number(attributes.last_analysis_stats?.malicious || 0) +
      Number(attributes.last_analysis_stats?.suspicious || 0) +
      Number(attributes.last_analysis_stats?.timeout || 0),
    vtLink: `https://www.virustotal.com/gui/file/${encodeURIComponent(id)}`,
  };
}

async function fetchVtDeepForDomain(domain, token) {
  const headers = { "x-apikey": token };
  const relationships = ["referrer_files", "communicating_files"];
  const files = [];
  const warnings = [];
  const stats = {};

  for (const relationship of relationships) {
    let cursor = "";
    let collected = 0;
    const maxPages = 3;
    const pageSize = 40;

    for (let page = 0; page < maxPages; page += 1) {
      const endpoint =
        `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}/${relationship}` +
        `?limit=${pageSize}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

      const response = await fetch(endpoint, { method: "GET", headers });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (!response.ok) {
        warnings.push(`${relationship}: HTTP ${response.status}`);
        break;
      }

      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const row of rows) {
        const mapped = mapVtFileItem(row, relationship);
        if (mapped) {
          files.push(mapped);
          collected += 1;
        }
      }

      const next = String(data?.meta?.cursor || "");
      if (!next || !rows.length) {
        break;
      }
      cursor = next;
    }

    stats[relationship] = collected;
  }

  const unique = new Map();
  for (const row of files) {
    const key = `${row.relationship}:${row.id}`;
    if (!unique.has(key)) {
      unique.set(key, row);
    }
  }

  return {
    domain,
    stats,
    warnings,
    files: Array.from(unique.values()),
    loadedAt: nowIso(),
  };
}

router.get("/", requireApiUser(), (_req, res) => {
  const { db } = getDbState();
  const projects = db
    .prepare(`
      SELECT
        p.id,
        p.name,
        p.domain,
        p.created_at,
        p.updated_at,
        (SELECT COUNT(*) FROM subdomains s WHERE s.project_id = p.id) AS subdomains_count,
        (SELECT COUNT(*) FROM scan_runs r WHERE r.project_id = p.id) AS runs_count,
        (
          SELECT r2.id
          FROM scan_runs r2
          WHERE r2.project_id = p.id
          ORDER BY r2.created_at DESC
          LIMIT 1
        ) AS last_run_id
      FROM projects p
      ORDER BY p.created_at DESC
    `)
    .all();

  const selectRun = db.prepare(`
    SELECT id, type, scan_scope, status, created_at
    FROM scan_runs
    WHERE id = ?
    LIMIT 1
  `);

  const data = projects.map((project) => {
    const lastRun = project.last_run_id ? selectRun.get(project.last_run_id) : null;
    return mapProjectWithDomains(project, {
      counts: {
        subdomains: Number(project.subdomains_count),
        runs: Number(project.runs_count),
      },
      lastRun: lastRun
        ? {
            id: lastRun.id,
            type: lastRun.type,
            scanScope: lastRun.scan_scope || "core",
            status: lastRun.status,
            createdAt: lastRun.created_at,
          }
        : null,
    });
  });

  res.json({ projects: data });
});

router.post("/bulk", requireApiUser(), (req, res) => {
  const input = req.body?.input;
  if (!input || !String(input).trim()) {
    res.status(400).json({ error: "Input is required" });
    return;
  }

  const domains = parseDomainInput(String(input));
  if (!domains.length) {
    res.status(400).json({ error: "No valid domains found in input" });
    return;
  }

  const { db } = getDbState();
  const existingRows = db
    .prepare(`SELECT domain FROM project_domains WHERE domain IN (${domains.map(() => "?").join(",")})`)
    .all(...domains);

  const existingSet = new Set(existingRows.map((item) => item.domain));
  const toCreate = domains.filter((domain) => !existingSet.has(domain));

  if (toCreate.length > 0) {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO projects (id, name, domain, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertDomainStmt = db.prepare(`
      INSERT OR IGNORE INTO project_domains (id, project_id, domain, is_primary, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `);

    const tx = db.transaction((domainList) => {
      for (const domain of domainList) {
        const projectId = createId();
        const now = nowIso();
        insertStmt.run(projectId, domain, domain, now, now);
        insertDomainStmt.run(createId(), projectId, domain, now, now);
      }
    });

    tx(toCreate);
  }

  const createdProjects = db
    .prepare(`
      SELECT id, name, domain, created_at, updated_at
      FROM projects
      WHERE domain IN (${domains.map(() => "?").join(",")})
      ORDER BY created_at DESC
    `)
    .all(...domains)
    .map((row) => mapProjectWithDomains(row));

  res.json({
    totalInput: domains.length,
    created: toCreate.length,
    existed: domains.length - toCreate.length,
    projects: createdProjects,
  });
});

router.post("/", requireApiUser(), (req, res) => {
  const name = normalizeProjectName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "Project name is required" });
    return;
  }

  const { db } = getDbState();
  const now = nowIso();
  const projectId = createId();
  db.prepare(`
    INSERT INTO projects (id, name, domain, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(projectId, name, now, now);

  const project = db
    .prepare("SELECT id, name, domain, created_at, updated_at FROM projects WHERE id = ? LIMIT 1")
    .get(projectId);

  res.json({
    ok: true,
    project: mapProjectWithDomains(project, {
      counts: {
        subdomains: 0,
        dnsRecords: 0,
        runs: 0,
      },
      runs: [],
      whois: null,
    }),
  });
});

router.get("/:id", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;

  const project = db
    .prepare("SELECT id, name, domain, created_at, updated_at FROM projects WHERE id = ? LIMIT 1")
    .get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const counts = {
    subdomains: Number(db.prepare("SELECT COUNT(*) AS c FROM subdomains WHERE project_id = ?").get(id).c),
    dnsRecords: Number(db.prepare("SELECT COUNT(*) AS c FROM dns_records WHERE project_id = ?").get(id).c),
    runs: Number(db.prepare("SELECT COUNT(*) AS c FROM scan_runs WHERE project_id = ?").get(id).c),
  };

  const runs = db
    .prepare(`
      SELECT id, project_id, type, task_kind, scan_scope, cancel_requested, status, progress, stage, processed, total, started_at, finished_at, error, created_at
      FROM scan_runs
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .all(id)
    .map((row) => ({
      ...mapRun(row),
      events: fetchRunEvents(row.id, 30),
    }));

  const whois = getCachedWhois(id);
  const intelx = getCachedIntelxLeaks(id);
  const webarchive = getCachedWebArchive(id);
  const dorkStats = getCachedDorkStats(id);
  const emails = collectProjectEmails(id);

  res.json({
    project: mapProjectWithDomains(project, {
      counts,
      runs,
      whois,
      intelx,
      webarchive,
      dorkStats,
      emails,
    }),
  });
});

router.post("/:id/domains", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db
    .prepare("SELECT id, name, domain, created_at, updated_at FROM projects WHERE id = ? LIMIT 1")
    .get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const domain = normalizeDomain(String(req.body?.domain || ""));
  if (!domain || !isValidDomain(domain)) {
    res.status(400).json({ error: "Invalid domain" });
    return;
  }

  const existingOwner = db
    .prepare("SELECT project_id FROM project_domains WHERE domain = ? LIMIT 1")
    .get(domain);
  if (existingOwner && String(existingOwner.project_id) !== String(project.id)) {
    res.status(409).json({ error: "This domain already belongs to another project" });
    return;
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    upsertProjectDomain(project.id, domain, { isPrimary: false });
    db.prepare(`
      UPDATE projects
      SET domain = COALESCE(NULLIF(domain, ''), ?), updated_at = ?
      WHERE id = ?
    `).run(domain, now, project.id);
    db.prepare(`
      INSERT INTO subdomains (id, project_id, host, is_root, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(project_id, host)
      DO UPDATE SET
        is_root = 1,
        updated_at = excluded.updated_at
    `).run(createId(), project.id, domain, now, now);
  });

  tx();

  res.json({
    ok: true,
    project: mapProjectWithDomains(project, {
      counts: {
        subdomains: Number(db.prepare("SELECT COUNT(*) AS c FROM subdomains WHERE project_id = ?").get(id).c),
        dnsRecords: Number(db.prepare("SELECT COUNT(*) AS c FROM dns_records WHERE project_id = ?").get(id).c),
        runs: Number(db.prepare("SELECT COUNT(*) AS c FROM scan_runs WHERE project_id = ?").get(id).c),
      },
      runs: [],
      whois: getCachedWhois(id),
      webarchive: getCachedWebArchive(id),
    }),
  });
});

router.get("/:id/runs", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;

  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const runs = db
    .prepare(`
      SELECT id, project_id, type, task_kind, scan_scope, cancel_requested, status, progress, stage, processed, total, started_at, finished_at, error, created_at
      FROM scan_runs
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .all(id)
    .map((row) => ({
      ...mapRun(row),
      events: fetchRunEvents(row.id, 30),
    }));

  res.json({ runs });
});

router.get("/:id/subdomains", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;

  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const page = parsePositiveInt(req.query.page, 1);
  const limit = normalizeSubdomainPageLimit(req.query.limit);
  const payload = fetchProjectSubdomains(id, { page, limit });
  res.json(payload);
});

function selectProjectSubdomainsByIds(projectId, subdomainIds) {
  const { db } = getDbState();
  const normalized = Array.from(new Set((subdomainIds || []).map((item) => String(item || "").trim()).filter(Boolean)));
  if (!normalized.length) {
    return [];
  }
  const placeholders = normalized.map(() => "?").join(",");
  return db
    .prepare(`SELECT id, host, is_root FROM subdomains WHERE project_id = ? AND id IN (${placeholders})`)
    .all(projectId, ...normalized);
}

router.get("/:id/export/domain-ip.csv", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = db
    .prepare(`
      SELECT
        s.host AS domain,
        COALESCE(r.value, 'NOT RESOLVED') AS ip
      FROM subdomains s
      LEFT JOIN (
        SELECT DISTINCT subdomain_id, value
        FROM dns_records
        WHERE record_type IN ('A', 'AAAA')
          AND value IS NOT NULL
          AND TRIM(value) <> ''
      ) r ON r.subdomain_id = s.id
      WHERE s.project_id = ?
      ORDER BY s.host ASC, ip ASC
    `)
    .all(id);

  const uniquePairs = new Set();
  const lines = ["domain;ip"];
  for (const row of rows) {
    const domain = String(row.domain || "").trim();
    const ip = String(row.ip || "").trim();
    if (!domain || !ip) {
      continue;
    }
    const key = `${domain};${ip}`;
    if (uniquePairs.has(key)) {
      continue;
    }
    uniquePairs.add(key);
    lines.push(key);
  }

  const fileName = `${buildProjectFileStem(project)}-domain-ip.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(lines.join("\n"));
});

router.post("/:id/export/domain-ip-selected.csv", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const requestedIds = Array.isArray(req.body?.subdomainIds) ? req.body.subdomainIds : [];
  const selectedRows = selectProjectSubdomainsByIds(id, requestedIds);
  if (!selectedRows.length) {
    res.status(400).json({ error: "No selected subdomains found" });
    return;
  }
  const selectedIds = selectedRows.map((row) => row.id);
  const placeholders = selectedIds.map(() => "?").join(",");

  const rows = db
    .prepare(`
      SELECT
        s.host AS domain,
        COALESCE(r.value, 'NOT RESOLVED') AS ip
      FROM subdomains s
      LEFT JOIN (
        SELECT DISTINCT subdomain_id, value
        FROM dns_records
        WHERE record_type IN ('A', 'AAAA')
          AND value IS NOT NULL
          AND TRIM(value) <> ''
      ) r ON r.subdomain_id = s.id
      WHERE s.project_id = ?
        AND s.id IN (${placeholders})
      ORDER BY s.host ASC, ip ASC
    `)
    .all(id, ...selectedIds);

  const uniquePairs = new Set();
  const lines = ["domain;ip"];
  for (const row of rows) {
    const domain = String(row.domain || "").trim();
    const ip = String(row.ip || "").trim();
    if (!domain || !ip) {
      continue;
    }
    const key = `${domain};${ip}`;
    if (uniquePairs.has(key)) {
      continue;
    }
    uniquePairs.add(key);
    lines.push(key);
  }

  const fileName = `${buildProjectFileStem(project)}-selected-domain-ip.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(lines.join("\n"));
});

router.post("/:id/subdomains", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const host = normalizeHostInput(req.body?.host);
  if (!host || !isValidDomain(host)) {
    res.status(400).json({ error: "Invalid host" });
    return;
  }
  const projectDomains = getProjectScopeDomains(project.id, project.domain);
  if (!isHostInProjectScope(host, projectDomains)) {
    res.status(400).json({ error: formatProjectScopeMessage(projectDomains) });
    return;
  }

  const now = nowIso();
  const row = db
    .prepare(`
      INSERT INTO subdomains (id, project_id, host, is_root, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, host)
      DO UPDATE SET updated_at = excluded.updated_at
      RETURNING id, host, is_root
    `)
    .get(createId(), project.id, host, projectDomains.includes(host) ? 1 : 0, now, now);

  db.prepare(`
    INSERT OR IGNORE INTO subdomain_sources (id, subdomain_id, source, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createId(), row.id, "manual", now);

  res.json({ ok: true, subdomainId: row.id, host: row.host, isRoot: Boolean(row.is_root) });
});

router.delete("/:id/subdomains", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = db
    .prepare(`
      SELECT id, is_root
      FROM subdomains
      WHERE project_id = ?
    `)
    .all(id);

  const deletable = rows.filter((row) => !row.is_root).map((row) => row.id);
  if (!deletable.length) {
    res.json({ ok: true, deleted: 0 });
    return;
  }

  const deleteStmt = db.prepare("DELETE FROM subdomains WHERE id = ?");
  const tx = db.transaction((ids) => {
    for (const subdomainId of ids) {
      deleteStmt.run(subdomainId);
    }
  });
  tx(deletable);

  res.json({ ok: true, deleted: deletable.length });
});

router.post("/:id/subdomains/delete-selected", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const requestedIds = Array.isArray(req.body?.subdomainIds) ? req.body.subdomainIds : [];
  const selectedRows = selectProjectSubdomainsByIds(id, requestedIds);
  if (!selectedRows.length) {
    res.status(400).json({ error: "No selected subdomains found" });
    return;
  }

  const deletable = selectedRows.filter((row) => !row.is_root).map((row) => row.id);
  if (!deletable.length) {
    res.json({ ok: true, deleted: 0 });
    return;
  }

  const deleteStmt = db.prepare("DELETE FROM subdomains WHERE id = ?");
  const tx = db.transaction((ids) => {
    for (const subdomainId of ids) {
      deleteStmt.run(subdomainId);
    }
  });
  tx(deletable);

  res.json({ ok: true, deleted: deletable.length });
});

router.put("/:id/subdomains/:subdomainId", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id, subdomainId } = req.params;
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const existing = db
    .prepare(`
      SELECT id, host, is_root
      FROM subdomains
      WHERE id = ? AND project_id = ?
      LIMIT 1
    `)
    .get(subdomainId, id);

  if (!existing) {
    res.status(404).json({ error: "Subdomain not found" });
    return;
  }
  if (existing.is_root) {
    res.status(400).json({ error: "Root domain cannot be edited" });
    return;
  }

  const host = normalizeHostInput(req.body?.host);
  if (!host || !isValidDomain(host)) {
    res.status(400).json({ error: "Invalid host" });
    return;
  }
  const projectDomains = getProjectScopeDomains(project.id, project.domain);
  if (!isHostInProjectScope(host, projectDomains)) {
    res.status(400).json({ error: formatProjectScopeMessage(projectDomains) });
    return;
  }
  if (projectDomains.includes(host)) {
    res.status(400).json({ error: "Root domain cannot be set via edit" });
    return;
  }

  try {
    db.prepare(`
      UPDATE subdomains
      SET host = ?, updated_at = ?
      WHERE id = ?
    `).run(host, nowIso(), subdomainId);
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      res.status(409).json({ error: "Subdomain with this host already exists" });
      return;
    }
    throw error;
  }

  db.prepare(`
    INSERT OR IGNORE INTO subdomain_sources (id, subdomain_id, source, created_at)
    VALUES (?, ?, ?, ?)
  `).run(createId(), subdomainId, "manual", nowIso());

  res.json({ ok: true, subdomainId, host });
});

router.delete("/:id/subdomains/:subdomainId", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id, subdomainId } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const row = db
    .prepare(`
      SELECT id, is_root
      FROM subdomains
      WHERE id = ? AND project_id = ?
      LIMIT 1
    `)
    .get(subdomainId, id);

  if (!row) {
    res.status(404).json({ error: "Subdomain not found" });
    return;
  }
  if (row.is_root) {
    res.status(400).json({ error: "Root domain cannot be deleted" });
    return;
  }

  db.prepare("DELETE FROM subdomains WHERE id = ?").run(subdomainId);
  res.json({ ok: true, subdomainId });
});

function parsePassiveScanScope(rawScope) {
  const value = String(rawScope || "core").trim().toLowerCase();
  if (["core", "extended", "all", "fullypassive", "dorks"].includes(value)) {
    return value;
  }
  if (value.startsWith("provider:")) {
    const providerId = value.slice("provider:".length).trim().toLowerCase();
    if (SUPPORTED_PASSIVE_SOURCE_IDS.includes(providerId)) {
      return `provider:${providerId}`;
    }
    return null;
  }
  if (value === "fully-passive" || value === "fully_passive") {
    return "fullypassive";
  }
  return null;
}

function parseDnsScope(rawScope) {
  const value = String(rawScope || "fast").trim().toLowerCase();
  if (value === "fast") {
    return "core";
  }
  if (value === "extended") {
    return "extended";
  }
  return null;
}

function enqueueRun(req, res, type) {
  const { db } = getDbState();
  const { id } = req.params;

  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const scanScope =
    type === "PASSIVE_SCAN"
      ? parsePassiveScanScope(req.body?.scope)
      : parseDnsScope(req.body?.scope);

  if (type === "PASSIVE_SCAN" && !scanScope) {
    res.status(400).json({ error: "Invalid scan scope. Use core, extended, dorks, all, fullypassive, or provider:<id>." });
    return;
  }
  if (type === "DNS_RESOLVE" && !scanScope) {
    res.status(400).json({ error: "Invalid DNS scope. Use fast or extended." });
    return;
  }

  const run = startRun(id, type, { scanScope: scanScope || "core" });
  enqueueScanJob({ runId: run.id, projectId: id, type, scanScope: run.scanScope });

  res.json({ ok: true, runId: run.id, scanScope: run.scanScope });
}

router.post("/:id/scan", requireApiUser(), (req, res) => {
  enqueueRun(req, res, "PASSIVE_SCAN");
});

router.post("/:id/scan-selected", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const scanScope = parsePassiveScanScope(req.body?.scope);
  if (!scanScope || !scanScope.startsWith("provider:")) {
    res.status(400).json({ error: "Invalid provider scope. Use provider:<id>." });
    return;
  }

  const rawIds = Array.isArray(req.body?.subdomainIds) ? req.body.subdomainIds : [];
  const subdomainIds = Array.from(new Set(rawIds.map((item) => String(item || "").trim()).filter(Boolean)));
  if (!subdomainIds.length) {
    res.status(400).json({ error: "No subdomains selected" });
    return;
  }

  const placeholders = subdomainIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, host FROM subdomains WHERE project_id = ? AND id IN (${placeholders})`)
    .all(id, ...subdomainIds);
  if (!rows.length) {
    res.status(400).json({ error: "Selected subdomains are not found in project" });
    return;
  }

  const validIds = rows.map((row) => row.id);
  const targetDomains = rows.map((row) => normalizeHostInput(row.host)).filter(Boolean);
  const providerId = scanScope.slice("provider:".length);
  const run = startRun(id, "PASSIVE_SCAN", {
    scanScope,
    taskKind: "PASSIVE_SCAN_SELECTED",
    taskPayload: { subdomainIds: validIds, targetDomains },
  });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "PASSIVE_SCAN_SELECTED",
    taskPayload: { subdomainIds: validIds, targetDomains },
  });

  res.json({ ok: true, runId: run.id, scanScope: run.scanScope, provider: providerId, selected: validIds.length });
});

router.get("/:id/passive-sources", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ sources: SUPPORTED_PASSIVE_SOURCE_IDS });
});

router.get("/:id/whois", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const refresh = String(req.query?.refresh || "").trim() === "1";
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!refresh) {
    const cached = getCachedWhois(project.id);
    if (cached) {
      res.json({ whois: cached, cached: true });
      return;
    }
  }

  try {
    const primaryDomain = ensureProjectHasPrimaryDomain(project, "run WHOIS");
    const whois = await fetchDomainWhoisLib(primaryDomain);
    saveCachedWhois(project.id, whois);
    res.json({ whois, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch WHOIS";
    res.status(400).json({ error: message });
  }
});

router.get("/:id/vt-deep", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const refresh = String(req.query?.refresh || "").trim() === "1";
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!refresh) {
    const cached = getCachedVtDeep(project.id);
    if (cached) {
      res.json({ result: cached, cached: true });
      return;
    }
  }

  const settings = new Map(getProviderRuntimeSettings().map((item) => [item.provider, item]));
  const vt = settings.get("virustotal");
  if (!vt || !vt.enabled || !vt.token) {
    res.status(400).json({ error: "VirusTotal provider is disabled or token is missing" });
    return;
  }

  try {
    const primaryDomain = ensureProjectHasPrimaryDomain(project, "load VT deep data");
    const result = await fetchVtDeepForDomain(primaryDomain, vt.token);
    saveCachedVtDeep(project.id, result);
    res.json({ result, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load VirusTotal deep data";
    res.status(400).json({ error: message });
  }
});

router.get("/:id/intelx-leaks", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const cached = getCachedIntelxLeaks(project.id);
  if (cached) {
    res.json({ result: cached, cached: true });
    return;
  }

  res.json({
    result: null,
    cached: false,
    message: "No IntelX data yet. Start the IntelX task to collect and save results.",
  });
});

router.put("/:id/intelx-leaks/hit", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const ref = normalizeIntelxHitRef(req.body);
  if (!ref) {
    res.status(400).json({ error: "Invalid IntelX hit reference" });
    return;
  }

  const nextLine = String(req.body?.line ?? "").trim();
  const nextFileName = String(req.body?.fileName ?? "").trim();
  if (!nextLine) {
    res.status(400).json({ error: "IntelX hit line is required" });
    return;
  }

  try {
    const result = updateCachedIntelxLeaks(id, (data) => {
      const search = Array.isArray(data.searches) ? data.searches[ref.searchIndex] : null;
      const hit = search && Array.isArray(search.hits) ? search.hits[ref.hitIndex] : null;
      if (!hit) {
        const error = new Error("IntelX hit not found");
        error.status = 404;
        throw error;
      }
      hit.line = nextLine;
      if (nextFileName) {
        hit.fileName = nextFileName;
      } else {
        delete hit.fileName;
      }
      return data;
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(error.status || 400).json({ error: error instanceof Error ? error.message : "Failed to update IntelX hit" });
  }
});

router.post("/:id/intelx-leaks/delete", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const refs = Array.isArray(req.body?.hits)
    ? req.body.hits.map(normalizeIntelxHitRef).filter(Boolean)
    : [];
  const uniqueRefs = Array.from(
    new Map(refs.map((ref) => [`${ref.searchIndex}:${ref.hitIndex}`, ref])).values(),
  );
  if (!uniqueRefs.length) {
    res.status(400).json({ error: "No IntelX hits selected" });
    return;
  }

  try {
    const result = updateCachedIntelxLeaks(id, (data) => {
      const bySearch = new Map();
      for (const ref of uniqueRefs) {
        if (!bySearch.has(ref.searchIndex)) {
          bySearch.set(ref.searchIndex, new Set());
        }
        bySearch.get(ref.searchIndex).add(ref.hitIndex);
      }

      for (const [searchIndex, hitIndexes] of bySearch.entries()) {
        const search = Array.isArray(data.searches) ? data.searches[searchIndex] : null;
        if (!search || !Array.isArray(search.hits)) {
          continue;
        }
        search.hits = search.hits.filter((_hit, hitIndex) => !hitIndexes.has(hitIndex));
      }
      return data;
    });
    res.json({ ok: true, deleted: uniqueRefs.length, result });
  } catch (error) {
    res.status(error.status || 400).json({ error: error instanceof Error ? error.message : "Failed to delete IntelX hits" });
  }
});

router.get("/:id/intelx-file", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const storageid = String(req.query?.storageid || "").trim();
  const bucket = String(req.query?.bucket || "leaks.public.general").trim() || "leaks.public.general";
  if (!storageid) {
    res.status(400).json({ error: "Missing storageid" });
    return;
  }

  const cached = getCachedIntelxLeaks(project.id);
  const allowed = Boolean(
    cached &&
      Array.isArray(cached.searches) &&
      cached.searches.some((search) =>
        Array.isArray(search?.hits) &&
        search.hits.some(
          (hit) =>
            String(hit?.storageid || "").trim() === storageid &&
            String(hit?.bucket || "leaks.public.general").trim() === bucket,
        ),
      ),
  );

  if (!allowed) {
    res.status(404).json({ error: "IntelX file is not available in saved project results" });
    return;
  }

  const settings = new Map(getProviderRuntimeSettings().map((item) => [item.provider, item]));
  const intelx = settings.get("intelx");
  if (!intelx || !intelx.enabled || !intelx.token) {
    res.status(400).json({ error: "IntelX provider is disabled or token is missing" });
    return;
  }

  try {
    const client = createIntelxClient(intelx.token);
    const text = await client.fetchFileText(storageid, bucket);
    res.type("text/plain; charset=utf-8").send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load IntelX file";
    res.status(400).json({ error: message });
  }
});

router.get("/:id/webarchive", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id, name, domain FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const cached = getCachedWebArchive(project.id);
  if (cached) {
    res.json({ result: cached, cached: true });
    return;
  }

  res.json({
    result: null,
    cached: false,
    message: "No WebArchive data yet. Start the WebArchive task to collect and save results.",
  });
});

router.get("/:id/dork-stats", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const cached = getCachedDorkStats(project.id);
  if (cached) {
    res.json({ result: cached, cached: true });
    return;
  }

  res.json({
    result: null,
    cached: false,
    message: "No dork stats yet. Start the dork stats task to collect and save results.",
  });
});

router.post("/:id/dork-stats-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  let engines = ["google", "yandex", "duckduckgo"];
  if (Array.isArray(req.body?.engines)) {
    engines = req.body.engines.filter(e => e === "google" || e === "yandex" || e === "duckduckgo");
  }

  const run = startRun(id, "PASSIVE_SCAN", {
    scanScope: "dorks",
    taskKind: "DORK_STATS",
    taskPayload: { engines },
  });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "DORK_STATS",
    taskPayload: { engines },
  });
  res.json({ ok: true, runId: run.id, taskKind: "DORK_STATS" });
});

router.delete("/:id/dork-stats", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  db.prepare("DELETE FROM project_dork_stats WHERE project_id = ?").run(id);
  res.json({ ok: true });
});

router.get("/:id/dork-captcha", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const { runId, engine } = req.query;

  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).send("Project not found");
    return;
  }

  const session = db.prepare("SELECT * FROM dork_captcha_sessions WHERE run_id = ? AND engine = ?").get(runId, engine);
  if (!session) {
    res.status(404).send("Captcha session not found or already expired");
    return;
  }

  // Set the initial session cookies saved by the worker
  if (session.cookies) {
    const cookiesList = session.cookies.split(";");
    for (const cookie of cookiesList) {
      const trimmed = cookie.trim();
      if (trimmed && trimmed.includes("=")) {
        res.append("Set-Cookie", trimmed);
      }
    }
  }

  let html = session.captcha_html;
  const submitUrl = `${req.protocol}://${req.get('host')}/api/projects/${id}/dork-captcha/submit?runId=${runId}&engine=${engine}`;
  const baseHref = engine === "yandex"
    ? "https://yandex.ru/"
    : engine === "duckduckgo"
      ? "https://duckduckgo.com/html/"
      : "https://www.google.com/";

  // Add base href tag right after <head> to load assets
  html = html.replace(/<head>/i, `<head><base href="${baseHref}">`);

  // For DuckDuckGo, rewrite relative challenge asset paths to our proxy path
  if (engine === "duckduckgo") {
    html = html.replace(/\.\.\/assets\/anomaly\//g, "/assets/anomaly/");
  }

  // Replace form action attributes with our absolute submit path
  html = html.replace(/action=(["'])([^"'\s>]+)\1/gi, (match, quote, action) => {
    if (action.startsWith("/") || action.includes("checkcaptcha") || action.includes("sorry") || action.includes("anomaly")) {
      const separator = submitUrl.includes("?") ? "&" : "?";
      return `action="${submitUrl}${separator}original_action=${encodeURIComponent(action)}"`;
    }
    return match;
  });

  res.send(html);
});

router.all("/:id/dork-captcha/submit", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const { runId, engine, original_action } = req.query;

  const params = { ...req.query, ...req.body };
  delete params.runId;
  delete params.engine;
  delete params.original_action;

  const session = db.prepare("SELECT * FROM dork_captcha_sessions WHERE run_id = ? AND engine = ?").get(runId, engine);
  if (!session) {
    res.status(404).send("Session not found");
    return;
  }

  const clientCookies = req.headers["cookie"] || "";
  const cleanedCookies = clientCookies
    .split(";")
    .map(c => c.trim())
    .filter(c => c && !c.startsWith("token=") && !c.startsWith("recon_session="))
    .join("; ");

  const targetHost = engine === "yandex"
    ? "https://yandex.ru"
    : engine === "duckduckgo"
      ? "https://duckduckgo.com"
      : "https://www.google.com";
  let submitPath = original_action || (
    engine === "yandex"
      ? "/checkcaptcha"
      : engine === "duckduckgo"
        ? "/html/"
        : "/sorry/index"
  );
  if (!submitPath.startsWith("/") && !submitPath.startsWith("http")) {
    submitPath = "/" + submitPath;
  }

  const url = new URL(submitPath, targetHost);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru,en;q=0.8",
    };
    if (cleanedCookies) {
      fetchHeaders["Cookie"] = cleanedCookies;
    }

    let body = undefined;
    if (req.method === "POST") {
      const bodyParams = new URLSearchParams();
      for (const [k, v] of Object.entries(req.body || {})) {
        bodyParams.append(k, v);
      }
      body = bodyParams.toString();
      fetchHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await fetch(url.toString(), {
      method: req.method,
      headers: fetchHeaders,
      body,
      redirect: "manual",
    });

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
    const newCookies = parsedCookies.join("; ");

    const cookieMap = new Map();
    const parseStr = (str) => {
      if (!str) return;
      str.split(";").forEach(part => {
        const trimmed = part.trim();
        if (!trimmed || !trimmed.includes("=")) return;
        const eqIdx = trimmed.indexOf("=");
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (k) cookieMap.set(k, v);
      });
    };
    parseStr(cleanedCookies);
    parseStr(newCookies);

    let finalResponse = response;
    let responseHtml = "";

    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get("location");
      if (location) {
        const redirectUrl = new URL(location, targetHost);
        const nextHeaders = { ...fetchHeaders };
        const combinedRedirectCookies = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
        if (combinedRedirectCookies) {
          nextHeaders["Cookie"] = combinedRedirectCookies;
        }
        const redirectResponse = await fetch(redirectUrl.toString(), {
          method: "GET",
          headers: nextHeaders,
          redirect: "manual",
        });
        finalResponse = redirectResponse;

        const redirectRawCookies = redirectResponse.headers.getSetCookie ? redirectResponse.headers.getSetCookie() : redirectResponse.headers.get("set-cookie");
        const redirectCookieHeader = Array.isArray(redirectRawCookies) ? redirectRawCookies.join("; ") : String(redirectRawCookies || "");
        const redirectParsed = [];
        if (redirectCookieHeader) {
          const parts = redirectCookieHeader.split(/,(?=[^;]*=)/);
          for (const part of parts) {
            const cookiePair = part.split(";")[0].trim();
            if (cookiePair && cookiePair.includes("=")) {
              redirectParsed.push(cookiePair);
            }
          }
        }
        if (redirectParsed.length) {
          const redirectNewCookies = redirectParsed.join("; ");
          parseStr(redirectNewCookies);
        }
        
        responseHtml = await redirectResponse.text();
      }
    } else {
      responseHtml = await response.text();
    }

    const savedCookies = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");

    if (savedCookies || finalResponse.status === 302 || finalResponse.status === 301 || finalResponse.status === 200 || finalResponse.status === 202) {
      db.prepare(`
        UPDATE dork_captcha_sessions
        SET status = 'RESOLVED', cookies = ?, resolved_html = ?, resolved_at = ?
        WHERE run_id = ? AND engine = ?
      `).run(savedCookies || "", responseHtml || "", nowIso(), runId, engine);

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Капча решена</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #e1e1e6; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1a1a1e; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); text-align: center; max-width: 400px; border: 1px solid #2a2a30; }
            h1 { color: #4caf50; margin-top: 0; }
            p { color: #a0a0a8; line-height: 1.5; }
            .btn { display: inline-block; background: #3b82f6; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin-top: 1rem; cursor: pointer; border: none; }
            .btn:hover { background: #2563eb; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Успешно!</h1>
            <p>Решение передано. Задача сканирования на сервере продолжится автоматически.</p>
            <p>Вы можете закрыть эту вкладку.</p>
            <button class="btn" onclick="window.close()">Закрыть вкладку</button>
          </div>
          <script>
            setTimeout(() => {
              window.close();
            }, 3000);
          </script>
        </body>
        </html>
      `);
    } else {
      const responseHtml = await response.text();
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Ошибка решения капчи</title>
          <style>
            body { font-family: sans-serif; background: #121214; color: #e1e1e6; padding: 2rem; }
            .error { color: #f43f5e; font-weight: bold; }
            a { color: #3b82f6; }
          </style>
        </head>
        <body>
          <h2>Не удалось подтвердить решение капчи.</h2>
          <p class="error">Пожалуйста, попробуйте отправить форму еще раз.</p>
          <p><a href="/api/projects/${id}/dork-captcha?runId=${runId}&engine=${engine}">Попробовать еще раз</a></p>
          <hr>
          <h3>Ответ поисковика (HTTP ${response.status}):</h3>
          <div>${responseHtml ? responseHtml.slice(0, 1000) : "Пустой ответ"}</div>
        </body>
        </html>
      `);
    }
  } catch (error) {
    res.status(500).send(`Ошибка при отправке решения: ${error.message}`);
  }
});

router.get("/:id/emails", requireApiUser(), async (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    result: collectProjectEmails(id),
    cached: true,
  });
});

router.post("/:id/emails", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const email = normalizeEmailValue(req.body?.email);
  if (!isValidEmailValue(email)) {
    res.status(400).json({ error: "Invalid email" });
    return;
  }

  const now = nowIso();
  const sourceKey = `manual:${createId()}`;
  db.prepare(`
    INSERT INTO project_email_overrides (
      id, project_id, source_email, email, is_deleted, is_manual, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 1, ?, ?)
  `).run(createId(), id, sourceKey, email, now, now);

  res.json({ ok: true, result: collectProjectEmails(id) });
});

router.put("/:id/emails/:sourceKey", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id, sourceKey } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const normalizedSourceKey = String(sourceKey || "").trim();
  const email = normalizeEmailValue(req.body?.email);
  if (!normalizedSourceKey) {
    res.status(400).json({ error: "Missing source key" });
    return;
  }
  if (!isValidEmailValue(email)) {
    res.status(400).json({ error: "Invalid email" });
    return;
  }

  const now = nowIso();
  db.prepare(`
    INSERT INTO project_email_overrides (
      id, project_id, source_email, email, is_deleted, is_manual, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(project_id, source_email)
    DO UPDATE SET
      email = excluded.email,
      is_deleted = 0,
      updated_at = excluded.updated_at
  `).run(createId(), id, normalizedSourceKey, email, normalizedSourceKey.startsWith("manual:") ? 1 : 0, now, now);

  res.json({ ok: true, result: collectProjectEmails(id) });
});

router.post("/:id/emails/delete", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rawSourceKeys = Array.isArray(req.body?.sourceKeys) ? req.body.sourceKeys : [];
  const sourceKeys = Array.from(new Set(rawSourceKeys.map((item) => String(item || "").trim()).filter(Boolean)));
  if (!sourceKeys.length) {
    res.status(400).json({ error: "No emails selected" });
    return;
  }

  const now = nowIso();
  const upsert = db.prepare(`
    INSERT INTO project_email_overrides (
      id, project_id, source_email, email, is_deleted, is_manual, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(project_id, source_email)
    DO UPDATE SET
      is_deleted = 1,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const sourceKey of sourceKeys) {
      const isManual = sourceKey.startsWith("manual:");
      upsert.run(createId(), id, sourceKey, sourceKey, isManual ? 1 : 0, now, now);
    }
  });
  tx();

  res.json({ ok: true, deleted: sourceKeys.length, result: collectProjectEmails(id) });
});

router.post("/:id/vt-deep-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const run = startRun(id, "PASSIVE_SCAN", { scanScope: "core", taskKind: "VT_DEEP" });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "VT_DEEP",
  });
  res.json({ ok: true, runId: run.id, taskKind: "VT_DEEP" });
});

router.post("/:id/intelx-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const customQuery = String(req.body?.customQuery || "").trim();
  const taskPayload = customQuery ? { customQuery } : null;
  const run = startRun(id, "PASSIVE_SCAN", {
    scanScope: "core",
    taskKind: "INTELX_LEAKS",
    taskPayload,
  });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "INTELX_LEAKS",
    taskPayload,
  });
  res.json({ ok: true, runId: run.id, taskKind: "INTELX_LEAKS", customQuery: customQuery || null });
});

router.post("/:id/webarchive-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const run = startRun(id, "PASSIVE_SCAN", {
    scanScope: "core",
    taskKind: "WEBARCHIVE",
  });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "WEBARCHIVE",
  });
  res.json({ ok: true, runId: run.id, taskKind: "WEBARCHIVE" });
});

router.post("/:id/webarchive-metadata-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const run = startRun(id, "PASSIVE_SCAN", {
    scanScope: "core",
    taskKind: "WEBARCHIVE_METADATA",
  });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "WEBARCHIVE_METADATA",
  });
  res.json({ ok: true, runId: run.id, taskKind: "WEBARCHIVE_METADATA" });
});

router.get("/:id/asn", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const row = db.prepare("SELECT data_json, updated_at FROM project_asn WHERE project_id = ? LIMIT 1").get(id);
  if (!row) {
    res.json({ result: null });
    return;
  }
  let data;
  try {
    data = JSON.parse(row.data_json);
  } catch {
    data = null;
  }
  res.json({ result: data, updatedAt: row.updated_at });
});

router.post("/:id/asn-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const run = startRun(id, "PASSIVE_SCAN", { scanScope: "core", taskKind: "ASN" });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "ASN",
  });
  res.json({ ok: true, runId: run.id, taskKind: "ASN" });
});

router.post("/:id/whois-task", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const run = startRun(id, "PASSIVE_SCAN", { scanScope: "core", taskKind: "WHOIS" });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "PASSIVE_SCAN",
    scanScope: run.scanScope,
    taskKind: "WHOIS",
  });
  res.json({ ok: true, runId: run.id, taskKind: "WHOIS" });
});

router.post("/:id/resolve", requireApiUser(), (req, res) => {
  enqueueRun(req, res, "DNS_RESOLVE");
});

router.post("/:id/resolve-selected", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").get(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const scanScope = parseDnsScope(req.body?.scope);
  if (!scanScope) {
    res.status(400).json({ error: "Invalid DNS scope. Use fast or extended." });
    return;
  }

  const rawIds = Array.isArray(req.body?.subdomainIds) ? req.body.subdomainIds : [];
  const subdomainIds = Array.from(new Set(rawIds.map((item) => String(item || "").trim()).filter(Boolean)));
  if (!subdomainIds.length) {
    res.status(400).json({ error: "No subdomains selected" });
    return;
  }

  const placeholders = subdomainIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM subdomains WHERE project_id = ? AND id IN (${placeholders})`)
    .all(id, ...subdomainIds);
  const validIds = rows.map((row) => row.id);
  if (!validIds.length) {
    res.status(400).json({ error: "Selected subdomains are not found in project" });
    return;
  }

  const run = startRun(id, "DNS_RESOLVE", {
    scanScope,
    taskKind: "DNS_RESOLVE_SELECTED",
    taskPayload: { subdomainIds: validIds },
  });
  enqueueScanJob({
    runId: run.id,
    projectId: id,
    type: "DNS_RESOLVE",
    scanScope: run.scanScope,
    taskKind: "DNS_RESOLVE_SELECTED",
    taskPayload: { subdomainIds: validIds },
  });
  res.json({ ok: true, runId: run.id, selected: validIds.length });
});

router.post("/:id/runs/:runId/cancel", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id, runId } = req.params;

  const run = db
    .prepare(`
      SELECT id, project_id, status, cancel_requested, progress, processed, total
      FROM scan_runs
      WHERE id = ? AND project_id = ?
      LIMIT 1
    `)
    .get(runId, id);

  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  if (run.status === "SUCCESS" || run.status === "FAILED") {
    res.status(409).json({ error: `Run already finished with status ${run.status}` });
    return;
  }

  const now = nowIso();

  if (run.status === "QUEUED") {
    db.prepare("DELETE FROM scan_jobs WHERE run_id = ?").run(runId);
    db.prepare(`
      UPDATE scan_runs
      SET
        status = 'FAILED',
        cancel_requested = 1,
        stage = 'Canceled',
        error = 'Canceled by user',
        progress = 100,
        finished_at = ?
      WHERE id = ?
    `).run(now, runId);

    db.prepare(`
      INSERT INTO scan_run_events (id, run_id, progress, stage, processed, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createId(), runId, 100, "Canceled by user", run.processed || 0, run.total || 0, now);

    res.json({ ok: true, runId, state: "canceled" });
    return;
  }

  if (!run.cancel_requested) {
    db.prepare(`
      UPDATE scan_runs
      SET cancel_requested = 1, stage = 'Cancel requested by user'
      WHERE id = ?
    `).run(runId);

    db.prepare(`
      INSERT INTO scan_run_events (id, run_id, progress, stage, processed, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId(),
      runId,
      Number(run.progress) || 0,
      "Cancel requested by user",
      Number(run.processed) || 0,
      Number(run.total) || 0,
      now,
    );
  }

  res.json({ ok: true, runId, state: "cancel_requested" });
});

router.delete("/:id", requireApiUser(), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;

  const project = db
    .prepare("SELECT id FROM projects WHERE id = ? LIMIT 1")
    .get(id);

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const runIds = db
    .prepare("SELECT id FROM scan_runs WHERE project_id = ?")
    .all(id)
    .map((row) => row.id);

  const queueCleanup = removeScanJobsByRunIds(runIds);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);

  res.json({
    ok: true,
    deletedProjectId: id,
    queueCleanup,
  });
});

module.exports = { projectsRouter: router };
