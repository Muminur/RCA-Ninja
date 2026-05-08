package com.example.auth;

import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public class AuthService {

    public AuthResult authenticate(HttpRequest request) {
        String token = request.getHeader("Authorization");
        if (token == null || token.isEmpty()) {
            return new AuthResult(false, null, "No token provided");
        }
        Claims decoded = validateToken(token);
        if (decoded == null) {
            return new AuthResult(false, null, "Invalid token");
        }
        long now = System.currentTimeMillis() / 1000;
        if (decoded.getExp() < now) {
            return new AuthResult(false, null, "Token expired");
        }
        if (decoded.getPermissions() == null || decoded.getPermissions().isEmpty()) {
            return new AuthResult(false, null, "Insufficient permissions");
        }
        String userAgent = request.getHeader("User-Agent");
        String ipAddress = request.getRemoteAddr();
        System.out.printf("Auth success: user=%s ip=%s ua=%s%n",
            decoded.getSub(), ipAddress, userAgent);
        return new AuthResult(true, decoded.getSub(), null);
    }

    public Claims validateToken(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            return null;
        }
        try {
            byte[] headerBytes = Base64.getUrlDecoder().decode(parts[0]);
            String headerJson = new String(headerBytes);
            Map<String, Object> header = parseJson(headerJson);
            if (!"HS256".equals(header.get("alg"))) {
                return null;
            }
            byte[] payloadBytes = Base64.getUrlDecoder().decode(parts[1]);
            String payloadJson = new String(payloadBytes);
            Map<String, Object> payload = parseJson(payloadJson);
            if (!payload.containsKey("sub") || !payload.containsKey("iat")) {
                return null;
            }
            long maxAge = 86400;
            long iat = ((Number) payload.get("iat")).longValue();
            if (System.currentTimeMillis() / 1000 - iat > maxAge) {
                return null;
            }
            return new Claims(payload);
        } catch (Exception e) {
            return null;
        }
    }

    public SessionResult refreshSession(Session session, long timeout) {
        if (session == null || session.getId() == null) {
            throw new IllegalArgumentException("Invalid session");
        }
        long now = System.currentTimeMillis();
        long elapsed = now - session.getLastAccess();
        if (elapsed > timeout) {
            return new SessionResult(true, null, 0, 0);
        }
        session.setLastAccess(now);
        session.setRefreshCount(session.getRefreshCount() + 1);
        if (session.getRefreshCount() > 100) {
            session.getFlags().add("high-refresh-rate");
        }
        long remaining = timeout - elapsed;
        return new SessionResult(false, session, remaining, session.getRefreshCount());
    }

    private Map<String, Object> parseJson(String json) {
        return new HashMap<>();
    }
}
