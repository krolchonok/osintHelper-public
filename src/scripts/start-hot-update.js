const { spawn } = require("node:child_process");
const readline = require("node:readline");

const serverArgs = ["src/server.js", ...process.argv.slice(2)];
let server = null;
let busy = false;
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[hot-update] ${message}\n`);
}

function spawnCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal || code}`));
    });
  });
}

function startServer() {
  server = spawn(process.execPath, serverArgs, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });

  server.on("exit", (code, signal) => {
    server = null;
    if (!shuttingDown && !busy) {
      log(`server stopped (${signal || code}); wrapper is still running`);
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    const child = server;
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 8000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function updateAndRestart() {
  if (busy) {
    log("update already running");
    return;
  }

  busy = true;
  log("updating: git pull --ff-only");
  try {
    await spawnCommand("git", ["pull", "--ff-only"]);
    log("installing dependencies: npm ci");
    await spawnCommand("npm", ["ci"]);
    log("restarting server");
    await stopServer();
    startServer();
    log("server restarted");
  } catch (error) {
    log(error instanceof Error ? error.message : "update failed");
    if (!server) {
      startServer();
    }
  } finally {
    busy = false;
  }
}

async function restartOnly() {
  if (busy) {
    log("operation already running");
    return;
  }

  busy = true;
  try {
    log("restarting server");
    await stopServer();
    startServer();
    log("server restarted");
  } finally {
    busy = false;
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("stopping");
  await stopServer();
  process.exit(0);
}

startServer();
log("started. Press Ctrl+U to pull/update/restart, Ctrl+R to restart, Ctrl+C to stop.");

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("keypress", (_str, key) => {
  if (!key) {
    return;
  }
  if (key.ctrl && key.name === "c") {
    void shutdown();
    return;
  }
  if (key.ctrl && key.name === "u") {
    void updateAndRestart();
    return;
  }
  if (key.ctrl && key.name === "r") {
    void restartOnly();
  }
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
