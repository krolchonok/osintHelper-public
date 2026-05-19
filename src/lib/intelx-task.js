const { getDbState } = require("../db");
const { getProjectScopeDomains, getPrimaryProjectDomain } = require("./project-domains");
const { getProviderRuntimeSettings } = require("./provider-settings");
const { nowIso } = require("./utils");
const { createIntelxClient } = require("./intelx");

function normalizeCustomQuery(rawQuery) {
  return String(rawQuery || "").trim();
}

async function executeIntelxLeaksTask(projectId, onProgress, options = null) {
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

  const settings = new Map(getProviderRuntimeSettings().map((item) => [item.provider, item]));
  const intelx = settings.get("intelx");
  if (!intelx || !intelx.enabled || !intelx.token) {
    throw new Error("IntelX provider is disabled or token is missing");
  }

  const primaryDomain = getPrimaryProjectDomain(project.id, project.domain);
  const customQuery = normalizeCustomQuery(options?.customQuery);
  const terms = customQuery
    ? [customQuery]
    : Array.from(new Set(getProjectScopeDomains(project.id, project.domain).filter(Boolean)));
  if (!terms.length) {
    throw new Error("Add at least one domain to the project before running IntelX");
  }
  const querySource = customQuery ? "custom" : "project_domains";
  const client = createIntelxClient(intelx.token);
  const searches = [];
  const warnings = [];

  await emit(12, `Prepared ${terms.length} search terms`, 0, terms.length);

  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    await emit(
      Math.min(85, 15 + Math.round((index / Math.max(terms.length, 1)) * 60)),
      `IntelX search: ${term}`,
      index,
      terms.length,
    );
    const result = await client.searchLeaks(term);
    searches.push({
      term,
      hits: result.hits.map((hit) => ({
        line: String(hit?.line || ""),
        storageid: String(hit?.storageid || ""),
        bucket: String(hit?.bucket || ""),
        fileName: String(hit?.fileName || ""),
      })),
      count: result.hits.length,
      warnings: result.warnings,
    });
    warnings.push(...(Array.isArray(result.warnings) ? result.warnings.map((item) => `${term}: ${item}`) : []));
  }

  const totalHits = searches.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  const result = {
    primaryDomain: primaryDomain || null,
    customQuery: customQuery || null,
    querySource,
    terms,
    searches,
    summary: {
      searches: searches.length,
      hits: totalHits,
    },
    warnings: Array.from(new Set(warnings)),
    source: "intelx",
    loadedAt: nowIso(),
  };

  await emit(92, "Saving IntelX results", searches.length, searches.length);
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_intelx_leaks (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project.id, JSON.stringify(result), "intelx", now, now);

  await emit(98, "IntelX leak search completed", searches.length, searches.length);
  return { ok: true, summary: result.summary };
}

module.exports = {
  executeIntelxLeaksTask,
};
