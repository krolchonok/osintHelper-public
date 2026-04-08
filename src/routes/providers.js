const express = require("express");
const { z } = require("zod");
const { requireApiUser } = require("../lib/auth");
const {
  addIntelxKey,
  listProviderSettings,
  removeIntelxKey,
  updateProviderSetting,
  getProviderRuntimeSettings,
} = require("../lib/provider-settings");
const { checkProviderLimit } = require("../lib/provider-limit-check");

const router = express.Router();

const updateSchema = z.object({
  provider: z.string().min(1),
  enabled: z.boolean().optional(),
  token: z.string().optional(),
  clearToken: z.boolean().optional(),
});

const checkLimitSchema = z.object({
  provider: z.string().min(1),
});

const intelxKeySchema = z.object({
  key: z.string().min(1),
});

router.get("/providers", requireApiUser("ADMIN"), (req, res) => {
  const providers = listProviderSettings();
  res.json({ providers });
});

router.put("/providers", requireApiUser("ADMIN"), (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    updateProviderSetting(parsed.data);
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    res.status(400).json({ error: message });
  }
});

router.post("/providers/check-limit", requireApiUser("ADMIN"), async (req, res) => {
  const parsed = checkLimitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const provider = String(parsed.data.provider || "").trim().toLowerCase();
  const runtime = getProviderRuntimeSettings();
  const setting = runtime.find((item) => item.provider === provider);
  if (!setting) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }
  if (!setting.token) {
    res.status(400).json({ error: "Provider token is not set" });
    return;
  }

  try {
    const result = await checkProviderLimit(provider, setting.token);
    res.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Limit check failed";
    res.status(400).json({ error: message });
  }
});

router.post("/providers/intelx/keys", requireApiUser("ADMIN"), (req, res) => {
  const parsed = intelxKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    addIntelxKey(parsed.data.key);
    const provider = listProviderSettings().find((item) => item.provider === "intelx") || null;
    res.json({ ok: true, provider });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add IntelX key";
    res.status(400).json({ error: message });
  }
});

router.delete("/providers/intelx/keys/:index", requireApiUser("ADMIN"), (req, res) => {
  const index = Number.parseInt(String(req.params.index || ""), 10);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "Invalid IntelX key index" });
    return;
  }

  try {
    removeIntelxKey(index);
    const provider = listProviderSettings().find((item) => item.provider === "intelx") || null;
    res.json({ ok: true, provider });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove IntelX key";
    res.status(400).json({ error: message });
  }
});

module.exports = { providersRouter: router };
