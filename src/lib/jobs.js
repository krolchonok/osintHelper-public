const { getDbState } = require("../db");
const { executePassiveScan } = require("./passive-scan");
const { executeDnsResolve } = require("./dns-resolve");
const { executeWhoisTask } = require("./whois-task");
const { executeVtDeepTask } = require("./vt-deep-task");
const { executeIntelxLeaksTask } = require("./intelx-task");
const { executeWebArchiveTask, executeWebArchiveMetadataTask } = require("./webarchive-task");
const { executeDorkStatsTask } = require("./dork-stats-task");
const { executeAsnTask } = require("./asn-task");
const { executeAvailabilityTask } = require("./availability-task");
const { clampProgress, createId, nowIso } = require("./utils");

class RunDeletedError extends Error {
  constructor() {
    super("Run was deleted");
    this.name = "RunDeletedError";
  }
}

class RunCanceledError extends Error {
  constructor() {
    super("Canceled by user");
    this.name = "RunCanceledError";
  }
}

function isCancelRequested(runId) {
  const { db } = getDbState();
  const row = db
    .prepare("SELECT cancel_requested FROM scan_runs WHERE id = ? LIMIT 1")
    .get(runId);
  if (!row) {
    throw new RunDeletedError();
  }
  return Boolean(row.cancel_requested);
}

function appendRunEvent(runId, update) {
  const { db } = getDbState();
  try {
    db.prepare(`
      INSERT INTO scan_run_events (id, run_id, progress, stage, processed, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId(),
      runId,
      clampProgress(update.progress),
      update.stage,
      typeof update.processed === "number" ? update.processed : 0,
      typeof update.total === "number" ? update.total : 0,
      nowIso(),
    );
  } catch {
    throw new RunDeletedError();
  }
}

function updateRunProgress(runId, update) {
  const { db } = getDbState();
  const result = db.prepare(`
    UPDATE scan_runs
    SET progress = ?, stage = ?, processed = ?, total = ?
    WHERE id = ?
  `).run(
    clampProgress(update.progress),
    update.stage,
    typeof update.processed === "number" ? update.processed : 0,
    typeof update.total === "number" ? update.total : 0,
    runId,
  );

  if (result.changes === 0) {
    throw new RunDeletedError();
  }
}

function startRun(projectId, type, options = {}) {
  const { db } = getDbState();
  const now = nowIso();
  const runId = createId();
  const scanScope = options.scanScope || "core";
  const taskKind = options.taskKind || null;
  const taskPayload = options.taskPayload || null;

  db.prepare(`
    INSERT INTO scan_runs (
      id, project_id, type, task_kind, task_payload, scan_scope, cancel_requested, status, progress, stage, processed, total, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'QUEUED', 0, 'Queued', 0, 0, ?)
  `).run(runId, projectId, type, taskKind, taskPayload ? JSON.stringify(taskPayload) : null, scanScope, now);

  appendRunEvent(runId, {
    progress: 0,
    stage: "Queued",
    processed: 0,
    total: 0,
  });

  return {
    id: runId,
    projectId,
    type,
    taskKind,
    taskPayload,
    scanScope,
    status: "QUEUED",
    progress: 0,
    stage: "Queued",
    processed: 0,
    total: 0,
    createdAt: now,
  };
}

async function executeRun(payload, onQueueProgress) {
  const { db } = getDbState();

  const startResult = db.prepare(`
    UPDATE scan_runs
    SET
      status = 'RUNNING',
      started_at = ?,
      error = NULL,
      progress = 2,
      stage = 'Worker started',
      processed = 0,
      total = 0
    WHERE id = ?
  `).run(nowIso(), payload.runId);

  if (startResult.changes === 0) {
    return;
  }

  appendRunEvent(payload.runId, {
    progress: 2,
    stage: "Worker started",
    processed: 0,
    total: 0,
  });

  if (onQueueProgress) {
    await onQueueProgress({ progress: 2, stage: "Worker started", processed: 0, total: 0 });
  }

  let lastEventSignature = "2|Worker started|0|0";

  const progressReporter = async (update) => {
    if (isCancelRequested(payload.runId)) {
      throw new RunCanceledError();
    }

    const signature = `${clampProgress(update.progress)}|${update.stage}|${update.processed ?? ""}|${update.total ?? ""}`;

    if (signature !== lastEventSignature) {
      lastEventSignature = signature;
      appendRunEvent(payload.runId, update);
    }

    updateRunProgress(payload.runId, update);

    if (onQueueProgress) {
      await onQueueProgress(update);
    }

    if (isCancelRequested(payload.runId)) {
      throw new RunCanceledError();
    }
  };

  try {
    let result = null;
    if (payload.taskKind === "WHOIS") {
      result = await executeWhoisTask(payload.projectId, progressReporter);
    } else if (payload.taskKind === "VT_DEEP") {
      result = await executeVtDeepTask(payload.projectId, progressReporter);
    } else if (payload.taskKind === "WEBARCHIVE") {
      result = await executeWebArchiveTask(payload.projectId, progressReporter);
    } else if (payload.taskKind === "WEBARCHIVE_METADATA") {
      result = await executeWebArchiveMetadataTask(payload.projectId, progressReporter);
    } else if (payload.taskKind === "INTELX_LEAKS") {
      result = await executeIntelxLeaksTask(payload.projectId, progressReporter, payload.taskPayload || null);
    } else if (payload.taskKind === "DORK_STATS") {
      result = await executeDorkStatsTask(payload.projectId, progressReporter, payload.runId);
    } else if (payload.taskKind === "ASN") {
      result = await executeAsnTask(payload.projectId, progressReporter);
    } else if (payload.taskKind === "READY_CHECK") {
      result = await executeAvailabilityTask(payload.projectId, progressReporter);
    } else if (payload.type === "ASN_LOOKUP") {
      result = await executeAsnTask(payload.projectId, progressReporter);
    } else if (payload.type === "PASSIVE_SCAN") {
      result = await executePassiveScan(
        payload.projectId,
        progressReporter,
        payload.scanScope || "core",
        payload.taskPayload || null,
      );
    } else {
      result = await executeDnsResolve(payload.projectId, progressReporter, payload.scanScope || "core", payload.taskPayload || null);
    }

    if (isCancelRequested(payload.runId)) {
      throw new RunCanceledError();
    }

    const successResult = db.prepare(`
      UPDATE scan_runs
      SET status = 'SUCCESS', finished_at = ?, progress = 100, stage = 'Completed', report_json = ?
      WHERE id = ?
    `).run(nowIso(), result?.report ? JSON.stringify(result.report) : null, payload.runId);

    if (successResult.changes === 0) {
      return;
    }

    appendRunEvent(payload.runId, { progress: 100, stage: "Completed" });

    if (onQueueProgress) {
      await onQueueProgress({ progress: 100, stage: "Completed" });
    }
  } catch (error) {
    if (error instanceof RunDeletedError) {
      return;
    }

    const isCanceled = error instanceof RunCanceledError;
    const message = isCanceled
      ? "Canceled by user"
      : error instanceof Error
        ? error.message
        : "Unknown job error";

    const failedResult = db.prepare(`
      UPDATE scan_runs
      SET status = 'FAILED', finished_at = ?, error = ?, stage = ?, progress = 100
      WHERE id = ?
    `).run(nowIso(), message, isCanceled ? "Canceled" : "Failed", payload.runId);

    if (failedResult.changes > 0) {
      appendRunEvent(payload.runId, {
        progress: 100,
        stage: isCanceled ? "Canceled by user" : `Failed: ${message}`,
      });

      if (onQueueProgress) {
        await onQueueProgress({
          progress: 100,
          stage: isCanceled ? "Canceled by user" : `Failed: ${message}`,
        });
      }
    }

    if (isCanceled) {
      return;
    }

    throw error;
  }
}

module.exports = {
  startRun,
  executeRun,
};
