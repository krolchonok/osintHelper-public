const { getDbState } = require("../db");
const { getPrimaryProjectDomain } = require("./project-domains");
const { nowIso } = require("./utils");
const { fetchDomainWhois } = require("./whois");

async function executeWhoisTask(projectId, onProgress) {
  const { db } = getDbState();
  const emit = async (progress, stage) => {
    if (onProgress) {
      await onProgress({ progress, stage, processed: 0, total: 0 });
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
  if (!primaryDomain) {
    throw new Error("Add a domain to the project before running WHOIS");
  }
  await emit(20, `WHOIS request: ${primaryDomain}`);
  const whois = await fetchDomainWhois(primaryDomain);

  await emit(75, "Saving WHOIS");
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_whois (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project.id, JSON.stringify(whois || {}), whois?.source || whois?.rdapUrl || null, now, now);

  await emit(98, "WHOIS task completed");
  return { ok: true };
}

module.exports = {
  executeWhoisTask,
};
