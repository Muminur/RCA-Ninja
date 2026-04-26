---
title: 'Session middleware null-pointers when cookie domain mismatch occurs'
date: 2026-04-25T12:00:00Z
branch: main
confidence: high
files:
  - src/middleware/auth.js
  - src/lib/session.js
generated_by: claude-rca/0.1.0
ref: a3f2c1d
schema: claude-rca.rca.v1
tags: [rca, bugfix, auth, backend]
---

## Symptom

Requests intermittently returned 500 with TypeError Cannot read properties of undefined reading id when users hit /api/me shortly after the cookie domain was changed in config.

## Root Cause

The session loader returned undefined when the cookie domain mismatched the request host, and the auth middleware proceeded to dereference req.session.user.id without a null check.

## Fix

auth.js now treats req.session === undefined as unauthenticated and short-circuits to 401. session.js was also updated to log a warning when the cookie domain check fails so the upstream cause is observable.

## Impact

All endpoints behind requireAuth. User-visible: brief 500s on /api/me, /api/orders, /api/notifications. No data loss.

## References

- src/middleware/auth.js
- src/lib/session.js
