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
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Proxy captcha assets (JS/CSS/images/etc.) to avoid 404s and asset load errors
app.use(async (req, res, next) => {
  const p = req.path;
  let targetUrl = null;

  if (p.includes("captcha_smart") || p.includes("smartcaptcha") || p.startsWith("/checkcaptcha")) {
    targetUrl = "https://yandex.ru" + req.originalUrl;
  } else if (p.startsWith("/sorry/") || p.includes("google-captcha")) {
    targetUrl = "https://www.google.com" + req.originalUrl;
  } else if (p.includes("/assets/anomaly/")) {
    targetUrl = "https://duckduckgo.com" + req.originalUrl;
  }

  if (targetUrl) {
    try {
      const clientCookies = req.headers["cookie"] || "";
      const cleanedCookies = clientCookies
        .split(";")
        .map(c => c.trim())
        .filter(c => c && !c.startsWith("token="))
        .join("; ");

      const fetchHeaders = {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: req.headers["accept"] || "*/*",
        "Accept-Language": req.headers["accept-language"] || "ru,en;q=0.8",
      };
      if (cleanedCookies) {
        fetchHeaders["Cookie"] = cleanedCookies;
      }

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: fetchHeaders,
      });

      // Proxy cookies from target to client (strip domain and secure attributes)
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get("set-cookie");
      if (rawCookies) {
        const cookieHeaders = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
        for (const cookieHeader of cookieHeaders) {
          const parts = cookieHeader.split(";").map(part => {
            const trimmed = part.trim();
            const lower = trimmed.toLowerCase();
            if (lower.startsWith("domain=") || lower === "secure") {
              return null;
            }
            return trimmed;
          }).filter(Boolean);
          res.append("Set-Cookie", parts.join("; "));
        }
      }

      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.setHeader("content-type", contentType);
      }
      res.status(response.status);

      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
      return;
    } catch (err) {
      console.error("[captcha-proxy] failed to proxy", targetUrl, err);
    }
  }
  next();
});

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

  server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${config.port}`);
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
