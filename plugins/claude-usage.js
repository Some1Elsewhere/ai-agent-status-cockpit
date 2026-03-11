/**
 * claude-usage plugin
 * Integrated Claude Code OAuth usage provider.
 * Reads credentials from macOS Keychain and queries the Anthropic usage API.
 * No shell scripts required.
 */

const https = require("node:https");
const { execFile } = require("node:child_process");

const USAGE_API = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 60_000; // 1 minute

let _cache = null;
let _cacheTime = 0;

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
          const creds = JSON.parse(stdout.trim());
          if (!creds.accessToken) return reject(new Error("No accessToken in Claude credentials"));
          resolve(creds);
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
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
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

function formatPeriod(raw) {
  if (!raw) return null;
  const utilization = raw.utilization ?? 0;
  const resetsAt = raw.resets_at || null;
  let resetsIn = "unknown";
  if (resetsAt) {
    const secsLeft = Math.floor((new Date(resetsAt).getTime() - Date.now()) / 1000);
    resetsIn = secsToHuman(secsLeft);
  }
  return { utilization, resets_in: resetsIn, resets_at: resetsAt };
}

async function fetchUsage() {
  // Return in-memory cached data if fresh
  if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS) {
    return { ..._cache, status: "ok" };
  }

  let creds;
  try {
    creds = await readCredentials();
  } catch (err) {
    if (_cache) return { ..._cache, status: "stale" };
    throw err;
  }

  if (creds.expiresAt && Date.now() > creds.expiresAt) {
    if (_cache) return { ..._cache, status: "stale" };
    throw new Error("OAuth token expired; re-authenticate with the Claude CLI");
  }

  let result;
  try {
    result = await httpGet(USAGE_API, {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    });
  } catch (err) {
    if (_cache) return { ..._cache, status: "stale" };
    throw err;
  }

  const { status: httpStatus, data } = result;
  if (httpStatus !== 200) {
    if (_cache) return { ..._cache, status: "stale" };
    throw new Error(`Usage API returned HTTP ${httpStatus}`);
  }

  const session = formatPeriod(data.five_hour);
  const weekly = formatPeriod(data.seven_day);
  const cachedAt = new Date().toISOString();

  _cache = { session, weekly, cached_at: cachedAt };
  _cacheTime = Date.now();

  return { session, weekly, cached_at: cachedAt, status: "ok" };
}

module.exports = {
  name: "claude-usage",
  description: "Integrated Claude Code OAuth usage provider",
  fetchUsage,
};
