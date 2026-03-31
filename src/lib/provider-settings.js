const YAML = require("yaml");
const { getDbState } = require("../db");
const { encryptToken, decryptToken } = require("./crypto");
const { providerCatalog, providerMap } = require("./providers");
const { createId, nowIso } = require("./utils");

function ensureProviderSettings() {
  const { db } = getDbState();
  const selectStmt = db.prepare("SELECT provider FROM provider_settings");
  const insertStmt = db.prepare(`
    INSERT INTO provider_settings (id, provider, description, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `);

  const now = nowIso();
  const existingSet = new Set(selectStmt.all().map((row) => row.provider));

  for (const provider of providerCatalog) {
    if (existingSet.has(provider.id)) {
      continue;
    }

    insertStmt.run(createId(), provider.id, provider.description, now, now);
  }
}

function listProviderSettings() {
  ensureProviderSettings();

  const { db } = getDbState();
  const rows = db
    .prepare("SELECT provider, description, token_encrypted, enabled, updated_at FROM provider_settings ORDER BY provider ASC")
    .all();

  return rows
    .filter((row) => providerMap.has(row.provider))
    .map((row) => ({
      provider: row.provider,
      title: providerMap.get(row.provider)?.title || row.provider,
      description: row.description,
      enabled: Boolean(row.enabled),
      hasToken: Boolean(row.token_encrypted),
      updatedAt: row.updated_at,
    }));
}

function updateProviderSetting(input) {
  const provider = providerMap.get(input.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${input.provider}`);
  }

  ensureProviderSettings();

  const { db } = getDbState();
  const now = nowIso();

  const row = db
    .prepare("SELECT provider, token_encrypted, enabled FROM provider_settings WHERE provider = ?")
    .get(input.provider);

  if (!row) {
    db.prepare(`
      INSERT INTO provider_settings (id, provider, description, token_encrypted, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId(),
      input.provider,
      provider.description,
      typeof input.token === "string" && input.token.trim() ? encryptToken(input.token.trim()) : null,
      typeof input.enabled === "boolean" ? (input.enabled ? 1 : 0) : 1,
      now,
      now,
    );
    return;
  }

  let tokenEncrypted = row.token_encrypted;
  if (input.clearToken) {
    tokenEncrypted = null;
  } else if (typeof input.token === "string") {
    const normalized = input.token.trim();
    if (normalized) {
      tokenEncrypted = encryptToken(normalized);
    }
  }

  const enabled = typeof input.enabled === "boolean" ? (input.enabled ? 1 : 0) : row.enabled;

  db.prepare(`
    UPDATE provider_settings
    SET description = ?, token_encrypted = ?, enabled = ?, updated_at = ?
    WHERE provider = ?
  `).run(provider.description, tokenEncrypted, enabled, now, input.provider);
}

function buildProviderConfigYaml() {
  ensureProviderSettings();

  const { db } = getDbState();
  const rows = db
    .prepare("SELECT provider, token_encrypted, enabled FROM provider_settings")
    .all();

  const rowMap = new Map(rows.map((row) => [row.provider, row]));
  const config = {};

  for (const provider of providerCatalog) {
    const setting = rowMap.get(provider.id);
    if (!setting || !setting.enabled || !setting.token_encrypted) {
      config[provider.id] = [];
      continue;
    }

    try {
      const token = decryptToken(setting.token_encrypted).trim();
      config[provider.id] = token ? [token] : [];
    } catch {
      config[provider.id] = [];
    }
  }

  return YAML.stringify(config);
}

function getProviderRuntimeSettings() {
  ensureProviderSettings();

  const { db } = getDbState();
  const rows = db
    .prepare("SELECT provider, token_encrypted, enabled FROM provider_settings")
    .all();

  return rows
    .filter((row) => providerMap.has(row.provider))
    .map((row) => {
      let token = null;
      if (row.token_encrypted) {
        try {
          const decrypted = decryptToken(row.token_encrypted).trim();
          token = decrypted || null;
        } catch {
          token = null;
        }
      }

      return {
        provider: row.provider,
        enabled: Boolean(row.enabled),
        token,
      };
    });
}

module.exports = {
  ensureProviderSettings,
  listProviderSettings,
  updateProviderSetting,
  buildProviderConfigYaml,
  getProviderRuntimeSettings,
};
