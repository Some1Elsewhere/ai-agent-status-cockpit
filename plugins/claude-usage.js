/**
 * claude-usage plugin
 * Integrated Claude Code OAuth usage provider.
 * Reads credentials from macOS Keychain and queries the Anthropic usage API.
 *
 * Features:
 * - In-memory cache (CACHE_TTL_MS, default 60s)
 * - HTTP 429 handling with Retry-After / exponential backoff
 * - Serves stale cached data on transient failures instead of hard-failing
 * - Never throws — always returns a structured result object
 */

const https = require("node:https");
const { execFile } = require("node:child_process");

const USAGE_API = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA = "oauth-2025-04-20";
const CACHE_TTL_MS = Number(process.env.CLAUDE_USAGE_CACHE_TTL) || 60_000;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 1_800_000;

let _cache = null;
let _cacheTime = 0;
let _nextRetryAt = 0;
let _backoffMs = MIN_BACKOFF_MS;

function secsToHuman(secs) {
  if (secs <= 0) return "0m";
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function readCredentials() {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return reject(new Error("Claude Code credentials not found in keychain"));
        try {
          const raw = JSON.parse(stdout.trim());
          const oauth = raw.claudeAiOauth || raw;
          if (!oauth.accessToken) return reject(new Error("No accessToken in Claude credentials"));
          resolve(oauth);
        } catch {
          reject(new Error("Could not parse Claude Code credentials JSON"));
        }
      }
    );
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return resolve({ status: res.statusCode, headers: res.headers, body });
        }
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch {
          reject(new Error("Failed to parse API response as JSON"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("Usage API request timed out")));
    req.end();
  });
}

function normalizeUtilization(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  // Anthropic currently returns percentages directly (e.g. 21.0).
  // Keep backward compatibility only for fractional values like 0.21.
  return value < 1 ? Math.round(value * 100) : Math.round(value);
}

function formatPeriod(raw) {
  if (!raw) return null;
  const utilization = normalizeUtilization(raw.utilization);
  const resetsAt = raw.resets_at || null;
  let resetsIn = "unknown";
  if (resetsAt) {
    const resetMs = new Date(resetsAt).getTime();
    if (Number.isFinite(resetMs)) {
      const secsLeft = Math.floor((resetMs - Date.now()) / 1000);
      resetsIn = secsToHuman(secsLeft);
    }
  }
  return { utilization, resets_in: resetsIn, resets_at: resetsAt };
}

async function getUsage({ forceRefresh = false } = {}) {
  try {
    if (!forceRefresh && _cache && Date.now() - _cacheTime < CACHE_TTL_MS) {
      return { ..._cache, status: "ok" };
    }

    if (!forceRefresh && Date.now() < _nextRetryAt) {
      const retryIn = Math.ceil((_nextRetryAt - Date.now()) / 1000);
      if (_cache) return { ..._cache, status: "stale", backoff_retry_in: retryIn };
      return { session: null, weekly: null, status: "throttled", provider: "claude-oauth", error: `Rate limited; retry in ${retryIn}s` };
    }

    let creds;
    try {
      creds = await readCredentials();
    } catch (err) {
      if (_cache) return { ..._cache, status: "stale" };
      return { session: null, weekly: null, status: "unavailable", provider: "claude-oauth", error: err.message };
    }

    let result;
    try {
      result = await httpGet(USAGE_API, {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": ANTHROPIC_BETA,
      });
    } catch (err) {
      if (_cache) return { ..._cache, status: "stale" };
      return { session: null, weekly: null, status: "error", provider: "claude-oauth", error: err.message };
    }

    const { status: httpStatus, headers, data } = result;

    if (httpStatus === 429) {
      let retryAfterMs = _backoffMs;
      const retryAfterHeader = headers?.["retry-after"];
      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!Number.isNaN(parsed) && parsed > 0) retryAfterMs = parsed * 1000;
      }
      _nextRetryAt = Date.now() + retryAfterMs;
      _backoffMs = Math.min(_backoffMs * 2, MAX_BACKOFF_MS);
      const retryIn = Math.ceil(retryAfterMs / 1000);
      if (_cache) return { ..._cache, status: "stale", backoff_retry_in: retryIn, error: `Rate limited; retry in ${retryIn}s` };
      return { session: null, weekly: null, status: "throttled", provider: "claude-oauth", error: `Rate limited; retry in ${retryIn}s` };
    }

    if (httpStatus !== 200) {
      if (_cache) return { ..._cache, status: "stale" };
      return { session: null, weekly: null, status: "error", provider: "claude-oauth", error: `Usage API returned HTTP ${httpStatus}` };
    }

    _backoffMs = MIN_BACKOFF_MS;
    _nextRetryAt = 0;

    const session = formatPeriod(data.five_hour);
    const weekly = formatPeriod(data.seven_day);
    const cachedAt = new Date().toISOString();

    _cache = { session, weekly, cached_at: cachedAt, provider: "claude-oauth" };
    _cacheTime = Date.now();

    return { ..._cache, status: "ok" };
  } catch (err) {
    if (_cache) return { ..._cache, status: "stale" };
    return { session: null, weekly: null, status: "error", provider: "claude-oauth", error: `Unexpected error: ${err.message}` };
  }
}

module.exports = {
  name: "claude-usage",
  description: "Integrated Claude Code OAuth usage provider",
  getUsage,
  fetchUsage: getUsage,
};
