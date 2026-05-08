"""Authentication module - test fixture for AST extraction."""


def authenticate(request):
    """Authenticate a request using token-based auth."""
    token = request.headers.get("Authorization")
    if not token:
        return {"error": "No token provided"}, 401

    decoded = validate_token(token)
    if decoded is None:
        return {"error": "Invalid token"}, 401

    if decoded.get("exp", 0) < time.time():
        return {"error": "Token expired"}, 401

    permissions = decoded.get("permissions", [])
    if not permissions:
        return {"error": "Insufficient permissions"}, 403

    user_agent = request.headers.get("User-Agent", "unknown")
    ip_address = request.remote_addr
    print(f"Auth success: user={decoded['sub']} ip={ip_address} ua={user_agent}")
    return {"authenticated": True, "user": decoded["sub"]}, 200


def validate_token(token):
    """Validate a JWT token and return its payload."""
    if not token or not isinstance(token, str):
        return None

    parts = token.split(".")
    if len(parts) != 3:
        return None

    try:
        import base64
        import json
        header = json.loads(base64.urlsafe_b64decode(parts[0] + "=="))
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))

        if header.get("alg") != "HS256":
            return None
        if "sub" not in payload or "iat" not in payload:
            return None

        max_age = 86400
        if time.time() - payload["iat"] > max_age:
            return None
        return payload
    except Exception:
        return None


def refresh_session(session, timeout=3600):
    """Refresh a session and check expiry."""
    if not session or "id" not in session:
        raise ValueError("Invalid session")

    now = time.time()
    elapsed = now - session.get("last_access", 0)

    if elapsed > timeout:
        return {"expired": True, "session": None}

    session["last_access"] = now
    session["refresh_count"] = session.get("refresh_count", 0) + 1

    if session["refresh_count"] > 100:
        session.setdefault("flags", []).append("high-refresh-rate")

    remaining = timeout - elapsed
    return {
        "expired": False,
        "session": session,
        "remaining": remaining,
        "refresh_count": session["refresh_count"],
    }
