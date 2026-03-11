# Usage Provider/Plugin — Review Notes

## Current State

`server.js` calls `readClaudeUsage()` which shells out via `execFile` to the
external `claude-usage.sh` script. The script:
1. Reads macOS Keychain with `security find-generic-password -s "Claude Code-credentials" -w`
2. Parses the JSON blob with `grep -o` + `sed` (fragile regex)
3. Calls `https://api.anthropic.com/api/oauth/usage` with `curl`
4. Parses the response again with `grep/sed`
5. Computes `resets_in` by stripping the trailing `Z` from ISO timestamps before
   passing to `date -j` — this loses timezone info and is wrong for non-UTC offsets
6. Caches output in `/tmp/claude-usage-cache` (shared global temp file)
7. Refreshes expired tokens by running `echo "2+2" | claude` (extremely hacky)

The `CLAUDE_USAGE_SCRIPT` env var points to a path two levels above the app
(`../../skills/claude-code-usage/scripts/claude-usage.sh`), making portability
fragile.

---

## Target Shape

### File layout

```
server.js                    (existing — minimal change)
plugins/
  claude-usage.js            (new integrated provider)
```

A `plugins/` directory establishes the abstraction point. If a second provider
is added later (e.g. a different model provider) it drops in alongside
`claude-usage.js` with the same exported interface.

### Provider interface

```js
// plugins/claude-usage.js
module.exports = {
  // Returns usage data or throws
  getUsage({ forceRefresh = false } = {}): Promise<UsageResult>,
  // Optional: current provider health
  status: 'ok' | 'error' | 'stale' | 'unavailable',
};
```

`UsageResult` shape (must remain backward-compatible with the frontend):

```js
{
  session: {
    utilization: number,   // 0-100
    resets_in: string,     // human string, e.g. "3h 20m"
    resets_at: string,     // ISO 8601 with timezone
  },
  weekly: {
    utilization: number,
    resets_in: string,
    resets_at: string,
  },
  cached_at: string,       // ISO 8601
  provider: string,        // "claude-oauth" — new field, ignored by existing UI
  status: string,          // "ok" | "error" | "stale"
}
```

---

## Implementation Guidance

### 1. Credential reading (Node, not shell)

Replace the shell `security` call with `execFile` directly from Node:

```js
const { execFile } = require('node:child_process');

function getCredentials() {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return reject(new Error('keychain read failed'));
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error('keychain returned invalid JSON'));
        }
      }
    );
  });
}
```

- On non-macOS: catch the error, return `{ status: 'unavailable', ... }` gracefully
- Do NOT attempt token refresh by spawning the Claude CLI — if the token is
  expired, return an `error` status and let the user re-authenticate manually.
  The poll loop will recover on the next successful cycle.

### 2. HTTP request (Node https, not curl)

```js
const https = require('node:https');

function fetchUsageFromAPI(token) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://api.anthropic.com/api/oauth/usage',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('API returned invalid JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
  });
}
```

### 3. JSON parsing (real parser, not grep/sed)

```js
function extractUsagePeriod(raw, key) {
  const period = raw[key];
  if (!period) return null;
  const resetsAt = period.resets_at;           // real ISO string
  const secsLeft = resetsAt
    ? Math.max(0, Math.floor((new Date(resetsAt).getTime() - Date.now()) / 1000))
    : null;
  return {
    utilization: Number(period.utilization ?? 0),
    resets_in:   secsLeft != null ? secsToHuman(secsLeft) : 'unknown',
    resets_at:   resetsAt ?? '',
  };
}
```

`new Date(isoString)` handles ISO 8601 with timezone offsets correctly.
This fixes the bug in the shell script where `${SESSION_RESET%Z}` strips `Z`
but passes the string to `date -j` without timezone awareness.

### 4. `secsToHuman` — keep format consistent with front-end

`app.js:isResetPending()` looks for:
- `"0m"` or `"0h 0m"` or `"0m 0s"`

The shell script produces things like `"3h 20m"`, `"2d 5h"`, `"0m"`.
The Node implementation must produce the same format or — better — update
`isResetPending` to use `resets_at` directly (compare timestamps instead of
parsing a human string). **Recommended: use `resets_at` timestamp comparison
in `app.js` and stop relying on the `resets_in` string for logic.**

Suggested `secsToHuman` for display-only use:

```js
function secsToHuman(secs) {
  if (secs <= 0) return '0m';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
```

### 5. In-process cache

Replace the `/tmp/claude-usage-cache` file with a module-level in-memory cache:

```js
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function getUsage({ forceRefresh = false } = {}) {
  const age = Date.now() - _cacheAt;
  if (!forceRefresh && _cache && age < CACHE_TTL_MS) return _cache;
  // ... fetch fresh ...
  _cache = result;
  _cacheAt = Date.now();
  return _cache;
}
```

Benefits: no temp-file contention, no cross-user leakage, cleared on restart
(acceptable — data is fetched from API in < 1 second when stale).

### 6. API route change in `server.js`

Replace `readClaudeUsage()` with the provider import:

```js
const claudeUsageProvider = require('./plugins/claude-usage');

// In handleAPI:
if (url.pathname === '/api/claude-usage') {
  try {
    const data = await claudeUsageProvider.getUsage();
    return json(200, data);
  } catch (err) {
    return json(200, {
      error: err.message,
      status: 'error',
      session: null,
      weekly: null,
    });
  }
}
```

Return 200 even on errors — the frontend already handles `usageRes.error` and
shows `--`. A 500 would cause the `.catch(() => null)` path in `app.js:poll()`
to silently discard the badge.

### 7. Remove external dependency

Delete:
```js
const CLAUDE_USAGE_SCRIPT = process.env.CLAUDE_USAGE_SCRIPT || ...;
```

Remove `execFile` import unless still used elsewhere (it is, for `mcporterCall`).

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| macOS keychain returns unexpectedly structured JSON | Medium | Validate `creds.accessToken` exists before use; return graceful error |
| Anthropic API changes the `oauth/usage` response shape | Medium | Parse defensively; log unknown fields; return partial data |
| `isResetPending()` breaks if `resets_in` string format changes | Medium | Migrate to timestamp comparison using `resets_at` field |
| Token expiry with no auto-refresh | Low | Provider returns `status: 'stale'`; user re-auths manually; next poll recovers |
| Non-macOS hosts (Linux CI, etc.) | Low | Catch `security` exec error; return `{ status: 'unavailable' }`; badge shows `--` |
| Memory cache survives stale data across server restarts | Low | Cache is process-local; restart always triggers a fresh fetch |
| `anthropic-beta` header value hardcoded | Low | Move to a named constant at top of file for easy updating |

---

## Front-end `app.js` — what to update

1. **`isResetPending(session)`** — rewrite to use `resets_at`:
   ```js
   function isResetPending(session) {
     if (!session?.resets_at) return false;
     const pct = Number(session.utilization);
     const resetMs = new Date(session.resets_at).getTime();
     return pct >= 95 && resetMs <= Date.now() + 60_000; // within 1 min
   }
   ```
   This is more robust than matching the `"0m"` string.

2. **Badge error state** — currently shows `--` when `claudeUsage` is null.
   Consider a distinct visual state when `usageRes.status === 'error'` (e.g.
   a small error icon or tooltip with the error message) vs. `'unavailable'`
   (credentials not configured) vs. loading.

---

## Verification Criteria

### Functional
- [ ] `/api/claude-usage` returns valid JSON with `session` and `weekly` fields
      when Claude credentials are present in Keychain
- [ ] `/api/claude-usage` returns `{ error: "...", status: "error", session: null, weekly: null }`
      when credentials are absent — **not** a 500
- [ ] Response `resets_at` values are valid ISO 8601 strings parseable by `new Date()`
- [ ] `utilization` values are integers 0–100
- [ ] Second request within 60s returns cached result (verify via timestamp or
      reduced latency; check `cached_at` field in response)
- [ ] `forceRefresh=true` (or a `?refresh=1` query param) bypasses cache
- [ ] Header badge renders correctly with real data: `42% session`, countdown, weekly
- [ ] Header badge shows `--` gracefully when credentials are unavailable
- [ ] Reset-pending note appears when `resets_at` is within 60 seconds and `utilization >= 95`
- [ ] All existing worker features (list, inspect, events, message, close) unaffected

### Structural
- [ ] `server.js` no longer references `CLAUDE_USAGE_SCRIPT`
- [ ] No `execFile` to a shell script for usage (only for `mcporter`)
- [ ] `plugins/claude-usage.js` exists and exports `getUsage`
- [ ] No `grep` or `sed` in the usage path
- [ ] `resets_at` is parsed with `new Date()`, not `date -j`

### Platform
- [ ] On a machine without `security` command (Linux), server starts cleanly and
      badge shows `--` (not a crash)

### README
- [ ] README updated: remove "optional: the `claude-code-usage` script/skill..."
      and replace with "Claude usage badge is built-in; no external script needed"
- [ ] README env vars table: remove `CLAUDE_USAGE_SCRIPT` if it was documented;
      add `CLAUDE_USAGE_CACHE_TTL` if TTL override is desired

---

## Non-goals / Out of Scope

- Do not add npm dependencies — the project is intentionally zero-dependency
- Do not add a `/api/claude-usage/refresh` endpoint (overkill; `?refresh=1` param is enough)
- Do not implement Linux `secret-tool` support unless specifically requested
- Do not implement automatic token refresh via Claude CLI subprocess

---

## File Change Summary

| File | Change |
|---|---|
| `server.js` | Remove `CLAUDE_USAGE_SCRIPT`, `readClaudeUsage()`; import and call `plugins/claude-usage.js` |
| `plugins/claude-usage.js` | **New** — integrated provider |
| `public/app.js` | Update `isResetPending()` to use `resets_at` timestamp; optionally improve error badge state |
| `README.md` | Update usage badge section; remove external script dependency mention |
