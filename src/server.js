require("dotenv").config({ quiet: true });

const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { openDatabase } = require("./db");
const { config } = require("./lib/config");
const { authRouter } = require("./routes/auth");
const { projectsRouter } = require("./routes/projects");
const { providersRouter } = require("./routes/providers");
const { adminUsersRouter } = require("./routes/admin-users");
const { startScanWorker } = require("./lib/job-queue");
const { initAdminBootstrap } = require("./lib/bootstrap");

const app = express();
const { dbPath } = openDatabase(config.sqlitePath);
const publicDir = path.resolve(process.cwd(), "public");
const spaIndexPath = path.join(publicDir, "index.html");

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    dbPath,
    inlineWorker: config.enableInlineWorker,
  });
});

app.get("/api/setup/status", (_req, res) => {
  const { isSystemInitialized } = require("./lib/setup");
  res.json({ initialized: isSystemInitialized() });
});

app.use("/api/auth", authRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/settings", providersRouter);
app.use("/api/admin", adminUsersRouter);

app.use((req, res, next) => {
  if (req.method !== "GET") {
    next();
    return;
  }

  if (req.path.startsWith("/api/")) {
    next();
    return;
  }

  if (req.path === "/health") {
    next();
    return;
  }

  if (path.extname(req.path)) {
    next();
    return;
  }

  res.sendFile(spaIndexPath);
});

app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error("[http] unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

let scanWorker = null;
let server = null;

async function start() {
  await initAdminBootstrap();

  if (config.enableInlineWorker) {
    scanWorker = startScanWorker({
      concurrency: config.workerConcurrency,
      pollIntervalMs: config.workerPollIntervalMs,
      onError(error, job) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[worker] failed ${job.runId}: ${message}`);
      },
    });
    console.log(
      `[worker] inline started (concurrency=${config.workerConcurrency}, poll=${config.workerPollIntervalMs}ms)`,
    );
  }

  server = app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
    console.log(`SQLite file: ${dbPath}`);
    if (config.httpErrorLogEnabled) {
      console.log(`[passive] HTTP error logging enabled: ${config.httpErrorLogFile}`);
    }
  });
}

function shutdown(signal) {
  console.log(`Received ${signal}. Closing server...`);
  if (scanWorker) {
    scanWorker.stop();
    scanWorker = null;
  }

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("[bootstrap] failed:", message);
  process.exit(1);
});
