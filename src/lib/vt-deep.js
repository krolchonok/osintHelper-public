const { nowIso } = require("./utils");

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

module.exports = {
  fetchVtDeepForDomain,
};
