const { getDbState } = require("../db");
const zlib = require("node:zlib");
const { getProjectScopeDomains, getPrimaryProjectDomain } = require("./project-domains");
const { nowIso } = require("./utils");

const WAYBACK_BASE = "https://web.archive.org/cdx/search/cdx";
const WAYBACK_TIMEOUT_MS = 30000;
const WAYBACK_MAX_ROWS_PER_DOMAIN = 1200;
const DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx"];
const DOCUMENT_FETCH_CONCURRENCY = 8;

function normalizeUrl(rawUrl) {
  return String(rawUrl || "").trim();
}

function normalizeMime(rawMime) {
  return String(rawMime || "").trim().toLowerCase();
}

function detectExtensionFromUrl(rawUrl) {
  const value = normalizeUrl(rawUrl).toLowerCase();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const pathname = String(parsed.pathname || "").toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,8})(?:$|[?#])/);
    return match ? match[1] : "";
  } catch {
    const match = value.match(/\.([a-z0-9]{2,8})(?:$|[?#])/);
    return match ? match[1] : "";
  }
}

function detectDocumentType(url, mime) {
  const extension = detectExtensionFromUrl(url);
  if (DOCUMENT_EXTENSIONS.includes(extension)) {
    return extension;
  }
  if (mime.includes("pdf")) {
    return "pdf";
  }
  if (mime.includes("wordprocessingml") || mime.includes("docx")) {
    return "docx";
  }
  if (mime.includes("msword") || mime.includes("application/doc")) {
    return "doc";
  }
  return "";
}

function toArchiveUrl(timestamp, original) {
  if (!timestamp || !original) {
    return null;
  }
  return `https://web.archive.org/web/${encodeURIComponent(timestamp)}/${original}`;
}

function parseWaybackTimestamp(rawTimestamp) {
  const value = String(rawTimestamp || "").trim();
  if (!/^\d{14}$/.test(value)) {
    return null;
  }
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  return iso;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cleanupText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupOptionalText(value) {
  const normalized = cleanupText(value);
  return normalized || null;
}

function uniqueStrings(items) {
  return Array.from(new Set((items || []).map((item) => cleanupText(item)).filter(Boolean)));
}

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function isPlausibleEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email || email.length < 8 || email.length > 254) {
    return false;
  }
  const parts = email.split("@");
  if (parts.length !== 2) {
    return false;
  }

  const [localPart, domain] = parts;
  if (localPart.length < 2 || domain.length < 4) {
    return false;
  }
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return false;
  }

  const labels = domain.split(".");
  if (labels.length < 2) {
    return false;
  }
  if (labels.some((label) => label.length < 2)) {
    return false;
  }

  const tld = labels[labels.length - 1];
  if (tld.length < 2 || tld.length > 24) {
    return false;
  }

  return true;
}

function extractEmailsFromText(text) {
  const matches = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return Array.from(
    new Set(
      (matches || [])
        .map((item) => normalizeEmail(item))
        .filter((item) => isPlausibleEmail(item)),
    ),
  );
}

function extractEmailsFromStrings(strings) {
  return extractEmailsFromText((strings || []).join("\n"));
}

function maybeName(value) {
  const normalized = cleanupText(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length > 160) {
    return null;
  }
  if (/@/.test(normalized)) {
    return null;
  }
  return normalized;
}

function extractTagValue(xml, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(xml || "").match(pattern);
  return match ? cleanupText(decodeXmlEntities(match[1])) : null;
}

function stripXml(text) {
  return cleanupText(
    String(text || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"),
  );
}

function extractAsciiStrings(buffer, minLength = 4) {
  const strings = [];
  let current = "";
  for (let index = 0; index < buffer.length; index += 1) {
    const code = buffer[index];
    if (code >= 32 && code <= 126) {
      current += String.fromCharCode(code);
    } else {
      if (current.length >= minLength) {
        strings.push(current);
      }
      current = "";
    }
  }
  if (current.length >= minLength) {
    strings.push(current);
  }
  return strings;
}

function extractUtf16LeStrings(buffer, minLength = 4) {
  const strings = [];
  let current = "";
  for (let index = 0; index < buffer.length - 1; index += 2) {
    const low = buffer[index];
    const high = buffer[index + 1];
    if (high === 0 && low >= 32 && low <= 126) {
      current += String.fromCharCode(low);
    } else {
      if (current.length >= minLength) {
        strings.push(current);
      }
      current = "";
    }
  }
  if (current.length >= minLength) {
    strings.push(current);
  }
  return strings;
}

function extractLabeledValue(text, labels) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    for (const label of labels) {
      const pattern = new RegExp(`^\\s*${label}\\s*[:=]\\s*(.+)$`, "i");
      const match = line.match(pattern);
      if (match) {
        return maybeName(match[1]);
      }
    }
  }

  const fullText = String(text || "");
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[:=]\\s*([^\\r\\n|;]{2,120})`, "i");
    const match = fullText.match(pattern);
    if (match) {
      return maybeName(match[1]);
    }
  }
  return null;
}

function parsePdfLiteralString(raw) {
  const normalized = String(raw || "")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\\/g, "\\");

  if (normalized.startsWith("þÿ")) {
    const bytes = Buffer.from(normalized, "latin1");
    if (bytes.length >= 2) {
      const chars = [];
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        const code = bytes.readUInt16BE(index);
        if (code === 0) {
          continue;
        }
        chars.push(String.fromCharCode(code));
      }
      const decoded = cleanupText(chars.join(""));
      if (decoded) {
        return decoded;
      }
    }
  }

  return cleanupText(normalized);
}

function parseZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.slice(fileNameStart, fileNameEnd).toString("utf8");
    const dataStart = fileNameEnd + extraFieldLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.length) {
      break;
    }

    const compressed = buffer.slice(dataStart, dataEnd);
    let contentBuffer = null;
    if (compressionMethod === 0) {
      contentBuffer = compressed;
    } else if (compressionMethod === 8) {
      try {
        contentBuffer = zlib.inflateRawSync(compressed);
      } catch {
        contentBuffer = null;
      }
    }

    if (contentBuffer) {
      entries.set(fileName, contentBuffer);
    }

    offset = dataEnd;
  }

  return entries;
}

async function fetchDocumentBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "osintHelper/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

function extractDocxMetadata(buffer) {
  const entries = parseZipEntries(buffer);
  const coreXml = entries.get("docProps/core.xml")?.toString("utf8") || "";
  const appXml = entries.get("docProps/app.xml")?.toString("utf8") || "";
  const commentsXml = entries.get("word/comments.xml")?.toString("utf8") || "";
  const documentXml = entries.get("word/document.xml")?.toString("utf8") || "";
  const footnotesXml = entries.get("word/footnotes.xml")?.toString("utf8") || "";
  const combinedXml = [coreXml, appXml, commentsXml, documentXml, footnotesXml].filter(Boolean).join("\n");

  return {
    author: maybeName(extractTagValue(coreXml, "dc:creator")),
    lastModifiedBy: maybeName(extractTagValue(coreXml, "cp:lastModifiedBy")),
    title: cleanupOptionalText(extractTagValue(coreXml, "dc:title")),
    subject: cleanupOptionalText(extractTagValue(coreXml, "dc:subject")),
    description: cleanupOptionalText(extractTagValue(coreXml, "dc:description")),
    keywords: cleanupOptionalText(extractTagValue(coreXml, "cp:keywords")),
    category: cleanupOptionalText(extractTagValue(coreXml, "cp:category")),
    contentStatus: cleanupOptionalText(extractTagValue(coreXml, "cp:contentStatus")),
    language: cleanupOptionalText(extractTagValue(coreXml, "dc:language")),
    revision: cleanupOptionalText(extractTagValue(coreXml, "cp:revision")),
    createdAt: cleanupOptionalText(extractTagValue(coreXml, "dcterms:created")),
    modifiedAt: cleanupOptionalText(extractTagValue(coreXml, "dcterms:modified")),
    company: cleanupOptionalText(extractTagValue(appXml, "Company")),
    manager: cleanupOptionalText(extractTagValue(appXml, "Manager")),
    application: cleanupOptionalText(extractTagValue(appXml, "Application")),
    appVersion: cleanupOptionalText(extractTagValue(appXml, "AppVersion")),
    pages: cleanupOptionalText(extractTagValue(appXml, "Pages")),
    words: cleanupOptionalText(extractTagValue(appXml, "Words")),
    characters: cleanupOptionalText(extractTagValue(appXml, "Characters")),
    lines: cleanupOptionalText(extractTagValue(appXml, "Lines")),
    paragraphs: cleanupOptionalText(extractTagValue(appXml, "Paragraphs")),
    emails: extractEmailsFromText(stripXml(combinedXml)),
  };
}

function extractPdfMetadata(buffer) {
  const text = buffer.toString("latin1");
  const authorMatch = text.match(/\/Author\s*\(([\s\S]*?)\)/i);
  const creatorMatch = text.match(/\/Creator\s*\(([\s\S]*?)\)/i);
  const producerMatch = text.match(/\/Producer\s*\(([\s\S]*?)\)/i);
  const titleMatch = text.match(/\/Title\s*\(([\s\S]*?)\)/i);
  const subjectMatch = text.match(/\/Subject\s*\(([\s\S]*?)\)/i);
  const keywordsMatch = text.match(/\/Keywords\s*\(([\s\S]*?)\)/i);
  const creationDateMatch = text.match(/\/CreationDate\s*\(([\s\S]*?)\)/i);
  const modDateMatch = text.match(/\/ModDate\s*\(([\s\S]*?)\)/i);
  const printableStrings = extractAsciiStrings(buffer, 6).filter((item) => item.includes("@"));

  return {
    author: maybeName(authorMatch ? parsePdfLiteralString(authorMatch[1]) : ""),
    lastModifiedBy: maybeName(creatorMatch ? parsePdfLiteralString(creatorMatch[1]) : ""),
    title: cleanupOptionalText(titleMatch ? parsePdfLiteralString(titleMatch[1]) : ""),
    subject: cleanupOptionalText(subjectMatch ? parsePdfLiteralString(subjectMatch[1]) : ""),
    keywords: cleanupOptionalText(keywordsMatch ? parsePdfLiteralString(keywordsMatch[1]) : ""),
    company: null,
    producer: cleanupOptionalText(producerMatch ? parsePdfLiteralString(producerMatch[1]) : ""),
    creationDate: cleanupOptionalText(creationDateMatch ? parsePdfLiteralString(creationDateMatch[1]) : ""),
    modifiedDate: cleanupOptionalText(modDateMatch ? parsePdfLiteralString(modDateMatch[1]) : ""),
    emails: extractEmailsFromStrings(printableStrings),
  };
}

function extractDocMetadata(buffer) {
  const extractedStrings = uniqueStrings([
    ...extractAsciiStrings(buffer),
    ...extractUtf16LeStrings(buffer),
  ]);
  const combinedText = extractedStrings.join("\n");

  return {
    author: extractLabeledValue(combinedText, ["author", "author name"]),
    lastModifiedBy: extractLabeledValue(combinedText, ["last saved by", "lastsavedby", "editor", "modified by"]),
    title: cleanupOptionalText(extractLabeledValue(combinedText, ["title"]) || ""),
    subject: cleanupOptionalText(extractLabeledValue(combinedText, ["subject"]) || ""),
    keywords: cleanupOptionalText(extractLabeledValue(combinedText, ["keywords"]) || ""),
    company: cleanupOptionalText(extractLabeledValue(combinedText, ["company", "organization"]) || ""),
    manager: cleanupOptionalText(extractLabeledValue(combinedText, ["manager"]) || ""),
    application: cleanupOptionalText(extractLabeledValue(combinedText, ["application", "appname"]) || ""),
    emails: extractEmailsFromStrings(extractedStrings.filter((item) => item.includes("@"))),
  };
}

async function enrichDocumentMetadata(document) {
  if (!document || !document.archiveUrl) {
    return {
      ...document,
      metadataStatus: "skipped",
      metadataError: "Archive URL is missing",
      metadata: null,
    };
  }

  try {
    const buffer = await fetchDocumentBuffer(document.archiveUrl);
    let metadata;
    if (document.type === "docx") {
      metadata = extractDocxMetadata(buffer);
    } else if (document.type === "pdf") {
      metadata = extractPdfMetadata(buffer);
    } else if (document.type === "doc") {
      metadata = extractDocMetadata(buffer);
    } else {
      metadata = { author: null, lastModifiedBy: null, title: "", company: "", emails: [] };
    }

    return {
      ...document,
      metadataStatus: "ok",
      metadataError: null,
      metadata: {
        author: metadata.author || null,
        lastModifiedBy: metadata.lastModifiedBy || null,
        title: metadata.title || null,
        subject: metadata.subject || null,
        description: metadata.description || null,
        keywords: metadata.keywords || null,
        category: metadata.category || null,
        contentStatus: metadata.contentStatus || null,
        language: metadata.language || null,
        revision: metadata.revision || null,
        createdAt: metadata.createdAt || metadata.creationDate || null,
        modifiedAt: metadata.modifiedAt || metadata.modifiedDate || null,
        company: metadata.company || null,
        manager: metadata.manager || null,
        application: metadata.application || null,
        appVersion: metadata.appVersion || null,
        pages: metadata.pages || null,
        words: metadata.words || null,
        characters: metadata.characters || null,
        lines: metadata.lines || null,
        paragraphs: metadata.paragraphs || null,
        producer: metadata.producer || null,
        emails: uniqueStrings(metadata.emails || []),
      },
    };
  } catch (error) {
    return {
      ...document,
      metadataStatus: "failed",
      metadataError: error instanceof Error ? error.message : "Failed to extract metadata",
      metadata: null,
    };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => worker()),
  );
  return results;
}

function hasUsefulMetadata(document) {
  return Boolean(
    document?.metadata &&
      (
        document.metadata.author ||
        document.metadata.lastModifiedBy ||
        document.metadata.title ||
        document.metadata.subject ||
        document.metadata.company ||
        document.metadata.application ||
        document.metadata.producer ||
        (Array.isArray(document.metadata.emails) && document.metadata.emails.length > 0)
      ),
  );
}

function buildMetadataSummary(documents) {
  return {
    processed: documents.length,
    withAuthor: documents.filter((item) => item.metadata?.author).length,
    withEditor: documents.filter((item) => item.metadata?.lastModifiedBy).length,
    withEmails: documents.filter((item) => Array.isArray(item.metadata?.emails) && item.metadata.emails.length).length,
    failed: documents.filter((item) => item.metadataStatus === "failed").length,
  };
}

async function enrichExistingWebArchiveDocuments(result, emit = null, options = {}) {
  const documents = Array.isArray(result.documents) ? result.documents : [];
  if (!documents.length) {
    return {
      ...result,
      metadataSummary: {
        processed: 0,
        withAuthor: 0,
        withEditor: 0,
        withEmails: 0,
        failed: 0,
      },
      loadedAt: nowIso(),
    };
  }

  const skipSuccessful = options.skipSuccessful !== false;
  const pendingDocuments = documents.filter((document) => {
    if (!skipSuccessful) {
      return true;
    }
    return !(document?.metadataStatus === "ok" && hasUsefulMetadata(document));
  });

  if (!pendingDocuments.length) {
    return {
      ...result,
      metadataSummary: buildMetadataSummary(documents),
      loadedAt: nowIso(),
    };
  }

  if (emit) {
    await emit(88, "Extracting document metadata", 0, pendingDocuments.length);
  }

  const enrichedPendingDocuments = await mapWithConcurrency(
    pendingDocuments,
    DOCUMENT_FETCH_CONCURRENCY,
    async (document, index) => {
      if (emit) {
        await emit(
          Math.min(96, 88 + Math.round(((index + 1) / Math.max(pendingDocuments.length, 1)) * 8)),
          `Metadata: ${document.type.toUpperCase()} ${document.host || document.url}`,
          index + 1,
          pendingDocuments.length,
        );
      }
      return enrichDocumentMetadata(document);
    },
  );

  const enrichedByArchiveUrl = new Map(
    enrichedPendingDocuments.map((document) => [
      `${String(document.archiveUrl || "")}|${String(document.url || "")}`,
      document,
    ]),
  );

  const enrichedDocuments = documents.map((document) => {
    const key = `${String(document.archiveUrl || "")}|${String(document.url || "")}`;
    return enrichedByArchiveUrl.get(key) || document;
  });

  return {
    ...result,
    documents: enrichedDocuments,
    metadataSummary: buildMetadataSummary(enrichedDocuments),
    loadedAt: nowIso(),
  };
}

async function fetchWaybackRows(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);
  const url =
    `${WAYBACK_BASE}?url=${encodeURIComponent(`*.${domain}/*`)}` +
    "&output=json" +
    "&fl=timestamp,original,mimetype,statuscode,digest,length" +
    "&filter=statuscode:200" +
    "&collapse=digest" +
    `&limit=${WAYBACK_MAX_ROWS_PER_DOMAIN}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "osintHelper/1.0",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Wayback request failed with HTTP ${response.status}`);
    }

    let data;
    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      throw new Error("Wayback response is not valid JSON");
    }

    const rows = Array.isArray(data) ? data.slice(1) : [];
    return rows
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map((row) => ({
        timestamp: String(row[0] || "").trim(),
        original: normalizeUrl(row[1]),
        mimetype: normalizeMime(row[2]),
        statuscode: String(row[3] || "").trim(),
        digest: String(row[4] || "").trim(),
        length: Number.parseInt(String(row[5] || ""), 10) || null,
      }))
      .filter((row) => row.original);
  } finally {
    clearTimeout(timer);
  }
}

function summarizeWayback(scopeDomains, rows) {
  const hosts = new Set();
  const uniqueUrls = new Set();
  const documentStats = { pdf: 0, doc: 0, docx: 0 };
  const documents = [];
  let earliestCapture = null;
  let latestCapture = null;

  for (const row of rows) {
    let host = "";
    try {
      host = new URL(row.original).hostname.toLowerCase();
    } catch {
      host = "";
    }
    if (host) {
      hosts.add(host);
    }
    uniqueUrls.add(row.original);

    const capturedAt = parseWaybackTimestamp(row.timestamp);
    if (capturedAt && (!earliestCapture || capturedAt < earliestCapture)) {
      earliestCapture = capturedAt;
    }
    if (capturedAt && (!latestCapture || capturedAt > latestCapture)) {
      latestCapture = capturedAt;
    }

    const documentType = detectDocumentType(row.original, row.mimetype);
    if (documentType) {
      documentStats[documentType] += 1;
      documents.push({
        type: documentType,
        url: row.original,
        host: host || null,
        mimetype: row.mimetype || null,
        length: row.length,
        digest: row.digest || null,
        timestamp: row.timestamp || null,
        capturedAt,
        archiveUrl: toArchiveUrl(row.timestamp, row.original),
      });
    }
  }

  documents.sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));

  const recentUrls = rows
    .map((row) => {
      let host = "";
      try {
        host = new URL(row.original).hostname.toLowerCase();
      } catch {
        host = "";
      }
      return {
        url: row.original,
        host: host || null,
        mimetype: row.mimetype || null,
        length: row.length,
        capturedAt: parseWaybackTimestamp(row.timestamp),
        archiveUrl: toArchiveUrl(row.timestamp, row.original),
      };
    })
    .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))
    .slice(0, 250);

  return {
    primaryDomain: scopeDomains[0] || null,
    terms: scopeDomains,
    summary: {
      searchedDomains: scopeDomains.length,
      totalUrls: uniqueUrls.size,
      totalCaptures: rows.length,
      hosts: hosts.size,
      documents: documents.length,
      pdf: documentStats.pdf,
      doc: documentStats.doc,
      docx: documentStats.docx,
      earliestCapture,
      latestCapture,
    },
    documents: documents.slice(0, 250),
    recentUrls,
    metadataSummary: {
      processed: 0,
      withAuthor: 0,
      withEditor: 0,
      withEmails: 0,
      failed: 0,
    },
    source: "waybackarchive",
    loadedAt: nowIso(),
  };
}

async function executeWebArchiveTask(projectId, onProgress) {
  const { db } = getDbState();
  const emit = async (progress, stage, processed = 0, total = 0) => {
    if (onProgress) {
      await onProgress({ progress, stage, processed, total });
    }
  };

  await emit(5, "Loading project");
  const project = db
    .prepare("SELECT id, domain FROM projects WHERE id = ? LIMIT 1")
    .get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const primaryDomain = getPrimaryProjectDomain(project.id, project.domain);
  const scopeDomains = Array.from(new Set(getProjectScopeDomains(project.id, project.domain).filter(Boolean)));
  if (!scopeDomains.length) {
    throw new Error("Add a domain to the project before running WebArchive");
  }

  const allRows = [];
  for (let index = 0; index < scopeDomains.length; index += 1) {
    const domain = scopeDomains[index];
    await emit(
      Math.min(85, 15 + Math.round((index / Math.max(scopeDomains.length, 1)) * 60)),
      `Wayback search: ${domain}`,
      index,
      scopeDomains.length,
    );
    const rows = await fetchWaybackRows(domain);
    allRows.push(...rows);
  }

  const result = summarizeWayback(
    primaryDomain ? [primaryDomain, ...scopeDomains.filter((item) => item !== primaryDomain)] : scopeDomains,
    allRows,
  );
  const enrichedResult = await enrichExistingWebArchiveDocuments(result, emit, { skipSuccessful: false });

  await emit(92, "Saving WebArchive results", scopeDomains.length, scopeDomains.length);
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_webarchive (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project.id, JSON.stringify(enrichedResult), "waybackarchive", now, now);

  await emit(98, "WebArchive task completed", scopeDomains.length, scopeDomains.length);
  return { ok: true, summary: enrichedResult.summary };
}

async function executeWebArchiveMetadataTask(projectId, onProgress) {
  const { db } = getDbState();
  const emit = async (progress, stage, processed = 0, total = 0) => {
    if (onProgress) {
      await onProgress({ progress, stage, processed, total });
    }
  };

  await emit(5, "Loading cached WebArchive results");
  const project = db
    .prepare("SELECT id FROM projects WHERE id = ? LIMIT 1")
    .get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const row = db
    .prepare("SELECT data_json FROM project_webarchive WHERE project_id = ? LIMIT 1")
    .get(projectId);
  if (!row || !row.data_json) {
    throw new Error("Run WebArchive first before re-extracting metadata");
  }

  let cached;
  try {
    cached = JSON.parse(row.data_json);
  } catch {
    throw new Error("Cached WebArchive data is corrupted");
  }

  const refreshed = await enrichExistingWebArchiveDocuments(cached, emit, { skipSuccessful: true });

  await emit(92, "Saving refreshed metadata");
  const now = nowIso();
  db.prepare(`
    UPDATE project_webarchive
    SET data_json = ?, source = ?, updated_at = ?
    WHERE project_id = ?
  `).run(JSON.stringify(refreshed), "waybackarchive", now, projectId);

  await emit(98, "WebArchive metadata refresh completed");
  return { ok: true, summary: refreshed.metadataSummary || {} };
}

module.exports = {
  executeWebArchiveTask,
  executeWebArchiveMetadataTask,
};
