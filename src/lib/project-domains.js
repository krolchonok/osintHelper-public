const { getDbState } = require("../db");
const { createId, nowIso } = require("./utils");

function listProjectDomains(projectId) {
  const { db } = getDbState();
  return db
    .prepare(`
      SELECT id, domain, is_primary, created_at, updated_at
      FROM project_domains
      WHERE project_id = ?
      ORDER BY is_primary DESC, domain ASC
    `)
    .all(projectId)
    .map((row) => ({
      id: row.id,
      domain: row.domain,
      isPrimary: Boolean(row.is_primary),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function getPrimaryProjectDomain(projectId, fallbackDomain = "") {
  const domains = listProjectDomains(projectId);
  const primary = domains.find((item) => item.isPrimary) || domains[0] || null;
  return primary ? primary.domain : String(fallbackDomain || "").trim().toLowerCase();
}

function getProjectScopeDomains(projectId, fallbackDomain = "") {
  const domains = listProjectDomains(projectId).map((item) => item.domain);
  if (domains.length) {
    return domains;
  }

  const fallback = String(fallbackDomain || "").trim().toLowerCase();
  return fallback ? [fallback] : [];
}

function isHostInProjectScope(host, projectDomains) {
  const normalizedHost = String(host || "").trim().toLowerCase();
  return projectDomains.some((domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
}

function upsertProjectDomain(projectId, domain, options = {}) {
  const { db } = getDbState();
  const now = nowIso();
  const isPrimary = options.isPrimary ? 1 : 0;

  return db
    .prepare(`
      INSERT INTO project_domains (id, project_id, domain, is_primary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, domain)
      DO UPDATE SET
        is_primary = CASE
          WHEN excluded.is_primary = 1 THEN 1
          ELSE project_domains.is_primary
        END,
        updated_at = excluded.updated_at
      RETURNING id, domain, is_primary, created_at, updated_at
    `)
    .get(createId(), projectId, domain, isPrimary, now, now);
}

module.exports = {
  getPrimaryProjectDomain,
  getProjectScopeDomains,
  isHostInProjectScope,
  listProjectDomains,
  upsertProjectDomain,
};
