require("dotenv").config({ quiet: true });

const { openDatabase } = require("./db");
const { config } = require("./lib/config");
const { startScanWorker } = require("./lib/job-queue");

openDatabase(config.sqlitePath);

const worker = startScanWorker({
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.workerPollIntervalMs,
  onError(error, job) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] failed ${job.runId}: ${message}`);
  },
});

console.log(
  `[worker] started (concurrency=${config.workerConcurrency}, poll=${config.workerPollIntervalMs}ms)`,
);
if (config.httpErrorLogEnabled) {
  console.log(`[worker] passive HTTP error logging enabled: ${config.httpErrorLogFile}`);
}

function shutdown(signal) {
  console.log(`[worker] shutting down (${signal})`);
  worker.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
