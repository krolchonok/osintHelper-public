const { getDbState } = require("../db");
const { getPrimaryProjectDomain } = require("./project-domains");
const { nowIso } = require("./utils");
const { getProviderRuntimeSettings } = require("./provider-settings");
const { fetchVtDeepForDomain } = require("./vt-deep");

async function executeVtDeepTask(projectId, onProgress) {
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

  const settings = new Map(getProviderRuntimeSettings().map((item) => [item.provider, item]));
  const vt = settings.get("virustotal");
  if (!vt || !vt.enabled || !vt.token) {
    throw new Error("VirusTotal provider is disabled or token is missing");
  }

  await emit(20, `VT deep request: ${primaryDomain}`);
  const result = await fetchVtDeepForDomain(primaryDomain, vt.token);

  await emit(75, "Saving VT deep data");
  const now = nowIso();
  db.prepare(`
    INSERT INTO project_vt_deep (project_id, data_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET
      data_json = excluded.data_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(project.id, JSON.stringify(result || {}), "virustotal", now, now);

  await emit(98, "VT deep task completed");
  return { ok: true };
}

module.exports = {
  executeVtDeepTask,
};
