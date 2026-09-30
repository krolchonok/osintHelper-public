function serializeError(error, depth = 0) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const details = {
    name: error.name,
    message: error.message,
  };
  if (error.code !== undefined) details.code = error.code;
  if (error.status !== undefined) details.status = error.status;
  if (error.stack) details.stack = error.stack;
  if (depth < 4 && error.cause !== undefined) {
    details.cause = serializeError(error.cause, depth + 1);
  }
  return details;
}

function logWorkerFailure(error, job, timing = {}) {
  const details = {
    runId: job?.runId ?? null,
    projectId: job?.projectId ?? null,
    type: job?.type ?? null,
    taskKind: job?.taskKind ?? null,
    scanScope: job?.scanScope ?? null,
    durationMs: timing.durationMs ?? null,
    error: serializeError(error),
  };
  console.error(`[worker] failed ${JSON.stringify(details)}`);
}

module.exports = { logWorkerFailure };
