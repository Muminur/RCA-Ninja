// Authentication module - test fixture for AST extraction
function authenticate(req, res) {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.user = decoded;
  // Additional validation checks
  if (decoded.exp < Date.now() / 1000) {
    return res.status(401).json({ error: 'Token expired' });
  }
  if (!decoded.permissions || decoded.permissions.length === 0) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const userAgent = req.headers['user-agent'] || 'unknown';
  const ipAddress = req.ip || req.connection.remoteAddress;
  console.log(`Auth success: user=${decoded.sub} ip=${ipAddress} ua=${userAgent}`);
  return res.status(200).json({ authenticated: true, user: decoded.sub });
}

function validateToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'HS256') {
      return null;
    }
    if (!payload.sub || !payload.iat) {
      return null;
    }
    const maxAge = 86400;
    if (Date.now() / 1000 - payload.iat > maxAge) {
      return null;
    }
    return payload;
  } catch (err) {
    return null;
  }
}

function refreshSession(session, options) {
  if (!session || !session.id) {
    throw new Error('Invalid session');
  }
  const now = Date.now();
  const elapsed = now - session.lastAccess;
  const timeout = options.timeout || 3600000;
  if (elapsed > timeout) {
    return { expired: true, session: null };
  }
  session.lastAccess = now;
  session.refreshCount = (session.refreshCount || 0) + 1;
  if (session.refreshCount > 100) {
    session.flags = session.flags || [];
    session.flags.push('high-refresh-rate');
  }
  const remaining = timeout - elapsed;
  return {
    expired: false,
    session,
    remaining,
    refreshCount: session.refreshCount,
  };
}

module.exports = { authenticate, validateToken, refreshSession };
