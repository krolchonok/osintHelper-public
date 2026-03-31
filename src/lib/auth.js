const { getDbState } = require("../db");
const { config } = require("./config");
const { createId, nowIso, sha256 } = require("./utils");

const SESSION_COOKIE = "recon_session";
const LAST_SEEN_REFRESH_MS = 10 * 60 * 1000;

function sessionExpiryIso() {
  return new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
}

function createSession(userId) {
  const { db } = getDbState();
  const token = require("node:crypto").randomBytes(32).toString("hex");
  const now = nowIso();

  db.prepare(`
    INSERT INTO auth_sessions (id, token_hash, user_id, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(createId(), sha256(token), userId, sessionExpiryIso(), now, now);

  return token;
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.cookie(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

function invalidateSessionByToken(token) {
  const { db } = getDbState();
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
}

function invalidateAllSessionsForUser(userId) {
  const { db } = getDbState();
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
}

function getCurrentUserFromRequest(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  const { db } = getDbState();
  const session = db
    .prepare(`
      SELECT
        s.id,
        s.expires_at,
        s.last_seen_at,
        u.id AS user_id,
        u.email,
        u.role,
        u.is_active
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
      LIMIT 1
    `)
    .get(sha256(token));

  if (!session) {
    return null;
  }

  const nowMs = Date.now();
  if (Date.parse(session.expires_at) <= nowMs || !session.is_active) {
    db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(session.id);
    return null;
  }

  const lastSeenAge = nowMs - Date.parse(session.last_seen_at);
  if (lastSeenAge > LAST_SEEN_REFRESH_MS) {
    db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), session.id);
  }

  return {
    id: session.user_id,
    email: session.email,
    role: session.role,
    isActive: Boolean(session.is_active),
  };
}

function requireApiUser(requiredRole) {
  return (req, res, next) => {
    const user = getCurrentUserFromRequest(req);

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (requiredRole && user.role !== requiredRole) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    req.authUser = user;
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  invalidateSessionByToken,
  invalidateAllSessionsForUser,
  getCurrentUserFromRequest,
  requireApiUser,
};
