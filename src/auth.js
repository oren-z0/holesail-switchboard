const nodeCrypto = require('crypto');

// Constants
const defaultScryptParams = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const keyLength = 64;
const saltLength = 32;
const refreshTokenExpirySeconds = 7 * 24 * 3600; // 7 days
const maxSessions = 100;

function encodeScryptParams(params) {
  // Compact and ":"-safe (third segment of the stored hash).
  return `${params.N},${params.r},${params.p},${params.maxmem}`;
}

function decodeScryptParams(encoded) {
  const parts = encoded.split(',');
  if (parts.length !== 4) return null;
  const [N, r, p, maxmem] = parts.map((v) => Number.parseInt(v, 10));
  if (![N, r, p, maxmem].every((v) => Number.isSafeInteger(v) && v > 0)) return null;
  return { N, r, p, maxmem };
}

// In-memory state
const sessionsById = new Map(); // sessionId -> { refreshTokenHash, issuedAt, refreshExpiresAt }
const sessionIdByRefreshTokenHash = new Map(); // refreshTokenHash -> sessionId
let cleanupInterval = null;

/**
 * Initialize auth module
 */
function initAuth() {
  // Start cleanup interval (every 60 seconds)
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  cleanupInterval = setInterval(cleanupExpiredSessions, 60000);
}

function createRefreshToken() {
  // Opaque token intended for storage in an HttpOnly cookie (or similar).
  return nodeCrypto.randomBytes(32).toString('base64url');
}

function hashRefreshToken(refreshToken) {
  return nodeCrypto.createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

/**
 * Hash a password using scrypt
 * @param {string} password - The password to hash
 * @returns {Promise<string>} - "salt:derivedKey:params" (salt/derivedKey hex; params "N,r,p,maxmem")
 */
async function hashPassword(password) {
  const salt = nodeCrypto.randomBytes(saltLength);
  const derivedKey = await new Promise((resolve, reject) => {
    nodeCrypto.scrypt(password, salt, keyLength, defaultScryptParams, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  const paramsEncoded = encodeScryptParams(defaultScryptParams);
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}:${paramsEncoded}`;
}

/**
 * Verify a password against a stored hash using timing-safe comparison
 * @param {string} password - The password to verify
 * @param {string} storedHash - The stored "salt:derivedKey" or "salt:derivedKey:params" hash
 * @returns {Promise<boolean>} - Whether the password is correct
 */
async function verifyPassword(password, storedHash) {
  const [saltHex, storedKeyHex, paramsEncoded] = storedHash.split(':');
  if (!saltHex || !storedKeyHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const storedKey = Buffer.from(storedKeyHex, 'hex');
  const params = decodeScryptParams(paramsEncoded);

  const derivedKey = await new Promise((resolve, reject) => {
    nodeCrypto.scrypt(password, salt, keyLength, params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  if (derivedKey.length !== storedKey.length) {
    return false;
  }
  return nodeCrypto.timingSafeEqual(derivedKey, storedKey);
}

/**
 * Create a new session (refresh token + access token)
 * @returns {{ refreshToken: string, refreshExpiresAt: number, sessionId: string }}
 */
function createSession() {
  cleanupExpiredSessions();
  if (maxSessions <= sessionsById.size) {
    return null;
  }
  const sessionId = nodeCrypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const refreshExpiresAt = issuedAt + refreshTokenExpirySeconds;

  const refreshToken = createRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  sessionsById.set(sessionId, { refreshTokenHash, issuedAt, refreshExpiresAt });
  sessionIdByRefreshTokenHash.set(refreshTokenHash, sessionId);

  return {
    refreshToken,
    refreshExpiresAt,
    sessionId,
  };
}

/**
 * Refresh a session using a refresh token (rotates refresh token)
 * @param {string} refreshToken - The refresh token
 * @returns {{ sessionId: string, refreshToken: string, refreshExpiresAt: number } | null}
 */
function refreshSession(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    return null;
  }

  const refreshTokenHash = hashRefreshToken(refreshToken);
  const sessionId = sessionIdByRefreshTokenHash.get(refreshTokenHash);
  if (!sessionId) {
    return null;
  }

  const session = sessionsById.get(sessionId);
  if (!session) {
    sessionIdByRefreshTokenHash.delete(refreshTokenHash);
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (session.refreshExpiresAt < now) {
    // Expired: invalidate.
    sessionIdByRefreshTokenHash.delete(refreshTokenHash);
    sessionsById.delete(sessionId);
    return null;
  }

  // Rotate refresh token
  sessionIdByRefreshTokenHash.delete(refreshTokenHash);
  const newRefreshToken = createRefreshToken();
  const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
  session.refreshTokenHash = newRefreshTokenHash;
  sessionIdByRefreshTokenHash.set(newRefreshTokenHash, sessionId);

  return {
    sessionId,
    refreshToken: newRefreshToken,
    refreshExpiresAt: session.refreshExpiresAt,
  };
}

/**
 * Invalidate a session
 * @param {string} sessionId - The session id to invalidate
 */
function invalidateSession(sessionId) {
  const session = sessionsById.get(sessionId);
  if (session && session.refreshTokenHash) {
    sessionIdByRefreshTokenHash.delete(session.refreshTokenHash);
  }
  sessionsById.delete(sessionId);
}

/**
 * Invalidate all sessions
 */
function invalidateAllSessions(exceptSessionId = null) {
  const session = exceptSessionId && sessionsById.get(exceptSessionId);
  sessionsById.clear();
  sessionIdByRefreshTokenHash.clear();
  if (session) {
    sessionsById.set(exceptSessionId, session);
    sessionIdByRefreshTokenHash.set(session.refreshTokenHash, exceptSessionId);
  }
}

/**
 * Invalidate a session by refresh token
 * @param {string} refreshToken - The refresh token
 */
function invalidateSessionByRefreshToken(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') return;
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const sessionId = sessionIdByRefreshTokenHash.get(refreshTokenHash);
  if (!sessionId) return;
  invalidateSession(sessionId);
}

/**
 * Check if a session is active
 * @param {string} sessionId - The session id to check
 * @returns {boolean}
 */
function isSessionActive(sessionId) {
  const session = sessionsById.get(sessionId);
  if (!session) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (session.refreshExpiresAt < now) {
    invalidateSession(sessionId);
    return false;
  }
  return true;
}

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  for (const [sessionId, session] of sessionsById) {
    if (session.refreshExpiresAt < now) {
      invalidateSession(sessionId);
    }
  }
}

/**
 * Check if a new session can be created
 * @returns {boolean}
 */
function canCreateSession() {
  cleanupExpiredSessions();
  return sessionsById.size < maxSessions;
}

/**
 * Get session count (for testing/debugging)
 * @returns {number}
 */
function getSessionCount() {
  cleanupExpiredSessions();
  return sessionsById.size;
}

module.exports = {
  initAuth,
  hashPassword,
  verifyPassword,
  createSession,
  refreshSession,
  invalidateSession,
  invalidateSessionByRefreshToken,
  invalidateAllSessions,
  isSessionActive,
  canCreateSession,
  cleanupExpiredSessions,
  getSessionCount,
};
