const { getDbState } = require("../db");
const { config } = require("./config");
const { hashPassword } = require("./passwords");
const { buildSetupUrl, createFreshSetupToken, isSystemInitialized } = require("./setup");
const { createId, nowIso } = require("./utils");

async function initAdminBootstrap() {
  const initialized = isSystemInitialized();
  if (initialized) {
    console.log("[auth:init-admin] users already exist, bootstrap skipped");
    return;
  }

  const email = config.adminEmail;
  const password = config.adminPassword;

  if (!email || !password) {
    const { token, expiresAt } = createFreshSetupToken();
    console.log("[auth:init-admin] no bootstrap admin credentials provided");
    console.log(`[auth:init-admin] setup URL: ${buildSetupUrl(token)}`);
    console.log(`[auth:init-admin] setup token expires at: ${expiresAt}`);
    return;
  }

  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters");
  }

  const { db } = getDbState();
  const now = nowIso();
  const passwordHash = await hashPassword(password);

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email);

  if (!existing) {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'ADMIN', 1, ?, ?)
    `).run(createId(), email, passwordHash, now, now);
    console.log(`[auth:init-admin] created admin ${email}`);
    return;
  }

  db.prepare(`
    UPDATE users
    SET password_hash = ?, role = 'ADMIN', is_active = 1, updated_at = ?
    WHERE id = ?
  `).run(passwordHash, now, existing.id);

  console.log(`[auth:init-admin] updated admin ${email}`);
}

module.exports = {
  initAdminBootstrap,
};
