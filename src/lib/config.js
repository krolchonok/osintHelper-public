const path = require("node:path");
const argv = process.argv.slice(2);

function parseBoolean(raw, defaultValue) {
  if (typeof raw !== "string") {
    return defaultValue;
  }

  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return defaultValue;
}

function parseNumber(raw, defaultValue) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return value;
}

function hasArg(flag) {
  return argv.includes(flag);
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const raw = argv.find((item) => item.startsWith(prefix));
  if (!raw) {
    return "";
  }
  return raw.slice(prefix.length).trim();
}

function resolvePath(rawPath, fallbackPath) {
  const candidate = String(rawPath || "").trim();
  if (!candidate) {
    return fallbackPath;
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(process.cwd(), candidate);
}

const config = {
  port: parseNumber(process.env.PORT, 3001),
  sqlitePath: process.env.SQLITE_PATH || "./data/app.db",
  encryptionKey: process.env.ENCRYPTION_KEY || "dev-insecure-key-change-me",
  appBaseUrl: (process.env.APP_BASE_URL || "http://localhost:3001").replace(/\/$/, ""),
  adminEmail: process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim().toLowerCase() : "",
  adminPassword: process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : "",
  sessionTtlDays: parseNumber(process.env.SESSION_TTL_DAYS, 7),
  enableInlineWorker: parseBoolean(process.env.ENABLE_INLINE_WORKER, true),
  workerConcurrency: Math.max(1, parseNumber(process.env.SCAN_WORKER_CONCURRENCY, 2)),
  workerPollIntervalMs: Math.max(250, parseNumber(process.env.SCAN_WORKER_POLL_MS, 1000)),
  passiveSourceConcurrency: Math.max(1, parseNumber(process.env.PASSIVE_SOURCE_CONCURRENCY, 24)),
  httpErrorLogEnabled: parseBoolean(process.env.HTTP_ERROR_LOG_ENABLED, hasArg("--log-http-errors")),
  httpErrorLogFile: resolvePath(
    process.env.HTTP_ERROR_LOG_FILE || getArgValue("--log-http-errors-file"),
    path.resolve(process.cwd(), "data", "http-errors.log"),
  ),
  projectRoot: process.cwd(),
  dataDir: path.resolve(process.cwd(), "data"),
};

module.exports = { config };
