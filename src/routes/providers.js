const express = require("express");
const { z } = require("zod");
const { requireApiUser } = require("../lib/auth");
const { listProviderSettings, updateProviderSetting, getProviderRuntimeSettings } = require("../lib/provider-settings");
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

module.exports = { providersRouter: router };
