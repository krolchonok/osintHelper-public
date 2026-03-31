const express = require("express");
const { z } = require("zod");
const { getDbState } = require("../db");
const { createId, nowIso } = require("../lib/utils");
const {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  invalidateSessionByToken,
  getCurrentUserFromRequest,
} = require("../lib/auth");
const { verifyPassword, hashPassword } = require("../lib/passwords");
const { isSystemInitialized, validateSetupToken, markSetupTokenUsed } = require("../lib/setup");

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const setupSchema = z.object({
  token: z.string().min(16),
  email: z.string().email(),
  password: z.string().min(8),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();

  const { db } = getDbState();
  const user = db
    .prepare("SELECT id, email, role, is_active, password_hash FROM users WHERE email = ? LIMIT 1")
    .get(email);

  if (!user || !user.is_active) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const validPassword = await verifyPassword(parsed.data.password, user.password_hash);
  if (!validPassword) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  });
});

router.post("/logout", (req, res) => {
  const token = req.cookies?.recon_session;
  if (token) {
    invalidateSessionByToken(token);
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const user = getCurrentUserFromRequest(req);
  if (!user) {
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    user,
  });
});

router.post("/setup", async (req, res) => {
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  if (isSystemInitialized()) {
    res.status(409).json({ error: "System already initialized" });
    return;
  }

  const { db } = getDbState();
  const email = parsed.data.email.trim().toLowerCase();
  const passwordHash = await hashPassword(parsed.data.password);

  const tx = db.transaction((payload) => {
    const tokenRow = validateSetupToken(payload.token);
    if (!tokenRow) {
      throw new Error("Invalid or expired setup token");
    }

    const usersCount = Number(db.prepare("SELECT COUNT(*) AS c FROM users").get().c);
    if (usersCount > 0) {
      throw new Error("System already initialized");
    }

    const now = nowIso();
    const userId = createId();

    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'ADMIN', 1, ?, ?)
    `).run(userId, payload.email, payload.passwordHash, now, now);

    markSetupTokenUsed(tokenRow.id);

    return {
      id: userId,
      email: payload.email,
      role: "ADMIN",
    };
  });

  try {
    const user = tx({
      token: parsed.data.token,
      email,
      passwordHash,
    });

    const sessionToken = createSession(user.id);
    setSessionCookie(res, sessionToken);

    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup failed";
    res.status(400).json({ error: message });
  }
});

module.exports = { authRouter: router };
