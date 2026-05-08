use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn authenticate(headers: &HashMap<String, String>) -> Result<AuthResult, AuthError> {
    let token = headers.get("Authorization")
        .ok_or(AuthError::NoToken)?;

    let decoded = validate_token(token)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    if decoded.exp < now {
        return Err(AuthError::TokenExpired);
    }

    if decoded.permissions.is_empty() {
        return Err(AuthError::InsufficientPermissions);
    }

    let user_agent = headers.get("User-Agent")
        .map(|s| s.as_str())
        .unwrap_or("unknown");
    let ip_address = headers.get("X-Forwarded-For")
        .map(|s| s.as_str())
        .unwrap_or("unknown");

    println!("Auth success: user={} ip={} ua={}", decoded.sub, ip_address, user_agent);
    Ok(AuthResult { authenticated: true, user: decoded.sub })
}

pub fn validate_token(token: &str) -> Result<Claims, AuthError> {
    if token.is_empty() {
        return Err(AuthError::InvalidToken);
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(AuthError::InvalidToken);
    }
    let header_bytes = base64_decode(parts[0])
        .map_err(|_| AuthError::InvalidToken)?;
    let header: HashMap<String, String> = serde_json::from_slice(&header_bytes)
        .map_err(|_| AuthError::InvalidToken)?;
    if header.get("alg").map(|s| s.as_str()) != Some("HS256") {
        return Err(AuthError::UnsupportedAlgorithm);
    }
    let payload_bytes = base64_decode(parts[1])
        .map_err(|_| AuthError::InvalidToken)?;
    let claims: Claims = serde_json::from_slice(&payload_bytes)
        .map_err(|_| AuthError::InvalidToken)?;
    Ok(claims)
}

pub fn refresh_session(session: &mut Session, timeout: u64) -> SessionResult {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let elapsed = now - session.last_access;
    if elapsed > timeout {
        return SessionResult { expired: true, session: None, remaining: 0, refresh_count: 0 };
    }
    session.last_access = now;
    session.refresh_count += 1;
    if session.refresh_count > 100 {
        session.flags.push("high-refresh-rate".to_string());
    }
    let remaining = timeout - elapsed;
    SessionResult {
        expired: false,
        session: Some(session.clone()),
        remaining,
        refresh_count: session.refresh_count,
    }
}
