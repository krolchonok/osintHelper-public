const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { getDbState } = require("../db");
const { encryptToken, decryptToken } = require("./crypto");
const { parseIntelxKeys } = require("./intelx");
const { providerCatalog, providerMap } = require("./providers");
const { createId, nowIso } = require("./utils");

function readEnvFileValue(filePath, key) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    return "";
  }

  try {
    const text = fs.readFileSync(resolvedPath, "utf8");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) {
        continue;
      }
      if (match[1] !== key) {
        continue;
      }
      return String(match[2] || "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
  } catch {
    return "";
  }

  return "";
}

function readEnvProviderToken(providerId) {
  if (providerId === "intelx") {
    const raw =
      process.env.INTELXPROD ||
      process.env.intelxprod ||
      process.env.INTELX_API_KEYS ||
      process.env.INTELX ||
      process.env.intelx ||
      readEnvFileValue("../intelxProd/.env", "INTELX_API_KEYS") ||
      readEnvFileValue("../intelxProd/.env", "INTELXPROD") ||
      readEnvFileValue("../intelxProd/.env", "intelxprod");
    return typeof raw === "string" ? raw.trim() : "";
  }

  if (providerId === "netlas") {
    const raw =
      process.env.NETLAS_API_KEY ||
      process.env.NETLAS ||
      process.env.netlas;
    return typeof raw === "string" ? raw.trim() : "";
  }

  return "";
}

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

  const rows = db
    .prepare("SELECT provider, token_encrypted FROM provider_settings")
    .all();
  const updateStmt = db.prepare(`
    UPDATE provider_settings
    SET token_encrypted = ?, updated_at = ?
    WHERE provider = ?
  `);

  for (const row of rows) {
    if (row.token_encrypted) {
      continue;
    }

    const envToken = readEnvProviderToken(row.provider);
    if (!envToken) {
      continue;
    }

    updateStmt.run(encryptToken(envToken), nowIso(), row.provider);
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
    .map((row) => {
      let token = "";
      if (row.token_encrypted) {
        try {
          token = decryptToken(row.token_encrypted).trim();
        } catch {
          token = "";
        }
      }

      return {
        provider: row.provider,
        title: providerMap.get(row.provider)?.title || row.provider,
        description: row.description,
        enabled: Boolean(row.enabled),
        hasToken: Boolean(row.token_encrypted),
        tokenPartsCount: row.provider === "intelx" ? parseIntelxKeys(token).length : (token ? 1 : 0),
        helpLinks: providerMap.get(row.provider)?.helpLinks || null,
        updatedAt: row.updated_at,
      };
    });
}

function addIntelxKey(rawKey) {
  const nextKey = String(rawKey || "").trim();
  if (!nextKey) {
    throw new Error("IntelX key is required");
  }

  ensureProviderSettings();
  const { db } = getDbState();
  const now = nowIso();
  const row = db
    .prepare("SELECT token_encrypted, enabled FROM provider_settings WHERE provider = 'intelx' LIMIT 1")
    .get();

  const currentToken = row?.token_encrypted ? decryptToken(row.token_encrypted).trim() : "";
  const keys = parseIntelxKeys(currentToken);
  if (!keys.includes(nextKey)) {
    keys.push(nextKey);
  }

  db.prepare(`
    UPDATE provider_settings
    SET token_encrypted = ?, enabled = 1, updated_at = ?
    WHERE provider = 'intelx'
  `).run(encryptToken(keys.join(",")), now);
}

function removeIntelxKey(index) {
  ensureProviderSettings();
  const keyIndex = Number.parseInt(String(index), 10);
  if (!Number.isInteger(keyIndex) || keyIndex < 0) {
    throw new Error("Invalid IntelX key index");
  }

  const { db } = getDbState();
  const now = nowIso();
  const row = db
    .prepare("SELECT token_encrypted, enabled FROM provider_settings WHERE provider = 'intelx' LIMIT 1")
    .get();

  const currentToken = row?.token_encrypted ? decryptToken(row.token_encrypted).trim() : "";
  const keys = parseIntelxKeys(currentToken);
  if (keyIndex >= keys.length) {
    throw new Error("IntelX key index is out of range");
  }

  keys.splice(keyIndex, 1);

  db.prepare(`
    UPDATE provider_settings
    SET token_encrypted = ?, updated_at = ?
    WHERE provider = 'intelx'
  `).run(keys.length ? encryptToken(keys.join(",")) : null, now);
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
  addIntelxKey,
  ensureProviderSettings,
  listProviderSettings,
  removeIntelxKey,
  updateProviderSetting,
  buildProviderConfigYaml,
  getProviderRuntimeSettings,
};
