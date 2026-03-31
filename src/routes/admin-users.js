const express = require("express");
const { z } = require("zod");
const { requireApiUser, invalidateAllSessionsForUser, clearSessionCookie } = require("../lib/auth");
const { hashPassword } = require("../lib/passwords");
const { getDbState } = require("../db");
const { createId, nowIso } = require("../lib/utils");

const router = express.Router();

const roleEnum = z.enum(["ADMIN", "USER"]);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: roleEnum.default("USER"),
});

const updateUserSchema = z.object({
  role: roleEnum.optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

function selectUsers() {
  const { db } = getDbState();

  return db
    .prepare(`
      SELECT id, email, role, is_active, created_at, updated_at
      FROM users
      ORDER BY created_at ASC
    `)
    .all()
    .map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

function ensureAdminSafety(targetUserId, nextRole, nextActive) {
  const { db } = getDbState();

  const target = db
    .prepare("SELECT role, is_active FROM users WHERE id = ? LIMIT 1")
    .get(targetUserId);

  if (!target) {
    throw new Error("User not found");
  }

  const currentlyAdminActive = target.role === "ADMIN" && Boolean(target.is_active);
  const futureAdminActive = nextRole === "ADMIN" && nextActive;

  if (!currentlyAdminActive || futureAdminActive) {
    return;
  }

  const activeAdminCount = Number(
    db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND is_active = 1")
      .get().c,
  );

  if (activeAdminCount <= 1) {
    throw new Error("At least one active ADMIN must remain");
  }
}

router.get("/users", requireApiUser("ADMIN"), (_req, res) => {
  res.json({ users: selectUsers() });
});

router.post("/users", requireApiUser("ADMIN"), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { db } = getDbState();
  const email = parsed.data.email.trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);

  if (existing) {
    res.status(409).json({ error: "User already exists" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const now = nowIso();
  const id = createId();

  db.prepare(`
    INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, email, passwordHash, parsed.data.role, now, now);

  const user = db
    .prepare(`
      SELECT id, email, role, is_active, created_at, updated_at
      FROM users
      WHERE id = ?
    `)
    .get(id);

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: Boolean(user.is_active),
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    },
  });
});

router.put("/users/:id", requireApiUser("ADMIN"), async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { db } = getDbState();
  const { id } = req.params;

  const current = db
    .prepare("SELECT id, role, is_active FROM users WHERE id = ? LIMIT 1")
    .get(id);

  if (!current) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const nextRole = parsed.data.role || current.role;
  const nextActive = typeof parsed.data.isActive === "boolean" ? parsed.data.isActive : Boolean(current.is_active);

  try {
    ensureAdminSafety(id, nextRole, nextActive);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid update";
    res.status(400).json({ error: message });
    return;
  }

  const updates = [];
  const params = [];

  if (parsed.data.role) {
    updates.push("role = ?");
    params.push(parsed.data.role);
  }

  if (typeof parsed.data.isActive === "boolean") {
    updates.push("is_active = ?");
    params.push(parsed.data.isActive ? 1 : 0);
  }

  if (parsed.data.password) {
    updates.push("password_hash = ?");
    params.push(await hashPassword(parsed.data.password));
  }

  updates.push("updated_at = ?");
  params.push(nowIso());
  params.push(id);

  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  if (parsed.data.password || parsed.data.isActive === false) {
    invalidateAllSessionsForUser(id);
  }

  const user = db
    .prepare(`
      SELECT id, email, role, is_active, created_at, updated_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `)
    .get(id);

  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: Boolean(user.is_active),
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    },
  });
});

router.delete("/users/:id", requireApiUser("ADMIN"), (req, res) => {
  const { db } = getDbState();
  const { id } = req.params;

  const current = db
    .prepare("SELECT id, role, is_active FROM users WHERE id = ? LIMIT 1")
    .get(id);

  if (!current) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    ensureAdminSafety(id, "USER", false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cannot delete user";
    res.status(400).json({ error: message });
    return;
  }

  const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  invalidateAllSessionsForUser(id);
  const isSelfDelete = req.authUser && req.authUser.id === id;
  if (isSelfDelete) {
    clearSessionCookie(res);
  }

  res.json({
    ok: true,
    deletedId: id,
    loggedOut: Boolean(isSelfDelete),
  });
});

module.exports = { adminUsersRouter: router };
