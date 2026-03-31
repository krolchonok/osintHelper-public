const { getDbState } = require("../db");
const { executeRun } = require("./jobs");
const { nowIso } = require("./utils");

function enqueueScanJob(payload) {
  const { db } = getDbState();
  const scanScope = payload.scanScope || "core";
  const taskKind = payload.taskKind || null;
  const taskPayload = payload.taskPayload ? JSON.stringify(payload.taskPayload) : null;
  db.prepare(`
    INSERT INTO scan_jobs (run_id, project_id, type, task_kind, task_payload, scan_scope, status, created_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, NULL)
    ON CONFLICT(run_id)
    DO UPDATE SET
      status = 'QUEUED',
      project_id = excluded.project_id,
      type = excluded.type,
      task_kind = excluded.task_kind,
      task_payload = excluded.task_payload,
      scan_scope = excluded.scan_scope,
      started_at = NULL
  `).run(payload.runId, payload.projectId, payload.type, taskKind, taskPayload, scanScope, nowIso());
}

function removeScanJobsByRunIds(runIds) {
  const { db } = getDbState();
  const uniqueRunIds = Array.from(new Set((runIds || []).filter(Boolean)));

  let removed = 0;
  let locked = 0;
  let missing = 0;

  const selectStmt = db.prepare("SELECT run_id, status FROM scan_jobs WHERE run_id = ?");
  const deleteStmt = db.prepare("DELETE FROM scan_jobs WHERE run_id = ? AND status = 'QUEUED'");

  for (const runId of uniqueRunIds) {
    const row = selectStmt.get(runId);
    if (!row) {
      missing += 1;
      continue;
    }

    if (row.status === "RUNNING") {
      locked += 1;
      continue;
    }

    const result = deleteStmt.run(runId);
    if (result.changes > 0) {
      removed += 1;
    } else {
      missing += 1;
    }
  }

  return {
    requested: uniqueRunIds.length,
    removed,
    locked,
    missing,
  };
}

function startScanWorker(options = {}) {
  const { db } = getDbState();
  const concurrency = Math.max(1, Number(options.concurrency) || 1);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || 1000);
  const onError = typeof options.onError === "function" ? options.onError : () => {};

  const recoverTx = db.transaction(() => {
    db.prepare("UPDATE scan_jobs SET status = 'QUEUED', started_at = NULL WHERE status = 'RUNNING'").run();
    db.prepare(`
      UPDATE scan_runs
      SET status = 'QUEUED', stage = 'Recovered after restart', started_at = NULL
      WHERE id IN (SELECT run_id FROM scan_jobs WHERE status = 'QUEUED')
      AND status = 'RUNNING'
    `).run();
  });

  recoverTx();

  const claimTx = db.transaction(() => {
    const row = db
      .prepare("SELECT run_id, project_id, type, task_kind, task_payload, scan_scope FROM scan_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1")
      .get();

    if (!row) {
      return null;
    }

    const result = db
      .prepare("UPDATE scan_jobs SET status = 'RUNNING', started_at = ? WHERE run_id = ? AND status = 'QUEUED'")
      .run(nowIso(), row.run_id);

    if (result.changes === 0) {
      return null;
    }

    let parsedTaskPayload = null;
    if (row.task_payload) {
      try {
        parsedTaskPayload = JSON.parse(row.task_payload);
      } catch {
        parsedTaskPayload = null;
      }
    }

    return {
      runId: row.run_id,
      projectId: row.project_id,
      type: row.type,
      taskKind: row.task_kind || null,
      taskPayload: parsedTaskPayload,
      scanScope: row.scan_scope || "core",
    };
  });

  const finalizeStmt = db.prepare("DELETE FROM scan_jobs WHERE run_id = ?");

  let stopped = false;
  let active = 0;
  let timer = null;
  let ticking = false;
  let tickRequested = false;

  async function processJob(job) {
    active += 1;

    try {
      await executeRun(job);
    } catch (error) {
      onError(error, job);
    } finally {
      finalizeStmt.run(job.runId);
      active -= 1;
      if (!stopped) {
        void tick();
      }
    }
  }

  async function tick() {
    if (stopped) {
      return;
    }
    if (ticking) {
      tickRequested = true;
      return;
    }
    ticking = true;

    try {
      do {
        tickRequested = false;
        while (!stopped && active < concurrency) {
          const job = claimTx();
          if (!job) {
            break;
          }
          void processJob(job);
        }
      } while (!stopped && tickRequested);
    } finally {
      ticking = false;
    }
  }

  timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

module.exports = {
  enqueueScanJob,
  removeScanJobsByRunIds,
  startScanWorker,
};
