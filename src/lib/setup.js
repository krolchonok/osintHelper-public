const crypto = require("node:crypto");
const { getDbState } = require("../db");
const { config } = require("./config");
const { createId, nowIso, sha256 } = require("./utils");

const SETUP_TOKEN_TTL_HOURS = 24;

function hashSetupToken(token) {
  return sha256(token);
}

function buildSetupUrl(token) {
  return `${config.appBaseUrl}/setup?token=${encodeURIComponent(token)}`;
}

function isSystemInitialized() {
  const { db } = getDbState();
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  return Number(row.c) > 0;
}

function createFreshSetupToken() {
  const { db } = getDbState();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const now = nowIso();

  db.prepare("DELETE FROM setup_tokens WHERE used_at IS NULL OR expires_at < ?").run(now);

  db.prepare(`
    INSERT INTO setup_tokens (id, token_hash, expires_at, used_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).run(createId(), hashSetupToken(token), expiresAt, now);

  return { token, expiresAt };
}

function validateSetupToken(rawToken) {
  const { db } = getDbState();
  return db
    .prepare(`
      SELECT id, token_hash, expires_at, used_at, created_at
      FROM setup_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      LIMIT 1
    `)
    .get(hashSetupToken(rawToken), nowIso());
}

function markSetupTokenUsed(tokenId) {
  const { db } = getDbState();
  const now = nowIso();
  db.prepare("UPDATE setup_tokens SET used_at = ? WHERE id = ?").run(now, tokenId);
  db.prepare("DELETE FROM setup_tokens WHERE id <> ?").run(tokenId);
}

module.exports = {
  hashSetupToken,
  buildSetupUrl,
  isSystemInitialized,
  createFreshSetupToken,
  validateSetupToken,
  markSetupTokenUsed,
};
