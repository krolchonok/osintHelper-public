const { getDbState } = require("../db");
const { getProjectScopeDomains } = require("./project-domains");
const { nowIso } = require("./utils");

const TIMEOUT_MS = 8000;
const MAX_TARGETS = 200;

function withTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

function normalizeHost(host) {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

async function probeUrl(url, method) {
  const started = Date.now();
  const timeout = withTimeoutSignal(TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: timeout.signal,
      headers: {
        "User-Agent": "osintHelper-ready-check/1.0",
        Accept: "*/*",
      },
    });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      statusText: response.statusText || "",
      finalUrl: response.url || url,
      ms: Date.now() - started,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      statusText: "",
      finalUrl: url,
      ms: Date.now() - started,
      error: error && error.name === "AbortError" ? "timeout" : String(error?.message || error || "request failed"),
    };
  } finally {
    timeout.done();
  }
}

async function checkHost(host) {
  const urls = [`https://${host}/`, `http://${host}/`];
  const checks = [];

  for (const url of urls) {
    let result = await probeUrl(url, "HEAD");
    if (!result.ok && (result.status === 405 || result.status === 403 || result.status === null)) {
      const getResult = await probeUrl(url, "GET");
      result = {
        ...getResult,
        headStatus: result.status,
        headError: result.error,
      };
    }
    checks.push({ url, method: "HEAD/GET", ...result });
  }

  const best = checks.find((item) => item.ok) || checks[0] || null;
  return {
    host,
    ok: Boolean(best && best.ok),
    bestUrl: best ? best.finalUrl || best.url : "",
    bestStatus: best ? best.status : null,
    bestMs: best ? best.ms : null,
    checks,
  };
}

async function mapWithConcurrency(items, fn, limit = 8) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function executeAvailabilityTask(projectId, onProgress) {
  const { db } = getDbState();
  const project = db.prepare("SELECT id, domain, ready_mode_enabled FROM projects WHERE id = ? LIMIT 1").get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  if (!project.ready_mode_enabled) {
    throw new Error("Ready mode is disabled for this project");
  }

  const rootDomains = getProjectScopeDomains(project.id, project.domain).map(normalizeHost).filter(Boolean);
  const subdomains = db
    .prepare("SELECT host FROM subdomains WHERE project_id = ? ORDER BY is_root DESC, host ASC LIMIT ?")
    .all(projectId, MAX_TARGETS)
    .map((row) => normalizeHost(row.host))
    .filter(Boolean);
  const targets = Array.from(new Set([...rootDomains, ...subdomains])).slice(0, MAX_TARGETS);
  if (!targets.length) {
    throw new Error("Add at least one domain before running ready checks");
  }

  if (onProgress) {
    await onProgress({ progress: 5, stage: `Ready check targets: ${targets.length}`, processed: 0, total: targets.length });
  }

  const rows = await mapWithConcurrency(targets, async (host, index) => {
    const result = await checkHost(host);
    if (onProgress) {
      await onProgress({
        progress: 5 + Math.floor(((index + 1) / targets.length) * 90),
        stage: `curl-like check: ${host}`,
        processed: index + 1,
        total: targets.length,
      });
    }
    return result;
  }, 8);

  const reachable = rows.filter((row) => row.ok).length;
  const data = {
    mode: "curl",
    total: rows.length,
    reachable,
    unreachable: rows.length - reachable,
    checkedAt: nowIso(),
    warning: "Active HTTP/HTTPS availability checks were sent to project hosts.",
    rows,
  };

  const now = nowIso();
  db.prepare(`
    INSERT INTO project_availability (project_id, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id)
    DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
  `).run(projectId, JSON.stringify(data), now, now);

  if (onProgress) {
    await onProgress({ progress: 98, stage: "Ready check results saved", processed: rows.length, total: rows.length });
  }

  return data;
}

module.exports = { executeAvailabilityTask };
