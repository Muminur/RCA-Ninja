package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func Authenticate(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("Authorization")
	if token == "" {
		http.Error(w, "No token provided", http.StatusUnauthorized)
		return
	}
	decoded, err := ValidateToken(token)
	if err != nil {
		http.Error(w, "Invalid token", http.StatusUnauthorized)
		return
	}
	if decoded.Exp < time.Now().Unix() {
		http.Error(w, "Token expired", http.StatusUnauthorized)
		return
	}
	if len(decoded.Permissions) == 0 {
		http.Error(w, "Insufficient permissions", http.StatusForbidden)
		return
	}
	userAgent := r.UserAgent()
	ipAddress := r.RemoteAddr
	fmt.Printf("Auth success: user=%s ip=%s ua=%s\n", decoded.Sub, ipAddress, userAgent)
	w.WriteHeader(http.StatusOK)
}

func ValidateToken(token string) (*Claims, error) {
	if token == "" {
		return nil, fmt.Errorf("empty token")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid token format")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var header map[string]interface{}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, err
	}
	if header["alg"] != "HS256" {
		return nil, fmt.Errorf("unsupported algorithm")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var claims Claims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, err
	}
	return &claims, nil
}

func RefreshSession(session *Session, timeout int64) (*SessionResult, error) {
	if session == nil || session.ID == "" {
		return nil, fmt.Errorf("invalid session")
	}
	now := time.Now().Unix()
	elapsed := now - session.LastAccess
	if elapsed > timeout {
		return &SessionResult{Expired: true}, nil
	}
	session.LastAccess = now
	session.RefreshCount++
	if session.RefreshCount > 100 {
		session.Flags = append(session.Flags, "high-refresh-rate")
	}
	remaining := timeout - elapsed
	return &SessionResult{
		Expired:      false,
		Session:      session,
		Remaining:    remaining,
		RefreshCount: session.RefreshCount,
	}, nil
}
