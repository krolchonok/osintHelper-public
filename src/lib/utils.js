const crypto = require("node:crypto");

function createId() {
  return crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function clampProgress(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function asBoolean(value) {
  return Boolean(value);
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  createId,
  sha256,
  clampProgress,
  asBoolean,
  nowIso,
};
