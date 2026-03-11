const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const os = require("node:os");

const PORT = process.env.PORT || 7700;
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || path.join(os.homedir(), "obsidian-vault");
const MCP_SERVER = process.env.MCP_SERVER || "claude-team-http";

const claudeUsagePlugin = require("./plugins/claude-usage");

// Shell out to mcporter to call the configured MCP worker server
function mcporterCall(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const cmdArgs = ["call", `${MCP_SERVER}.${tool}`];
    for (const [k, v] of Object.entries(args)) {
      cmdArgs.push(`${k}=${v}`);
    }
    execFile("mcporter", cmdArgs, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`mcporter ${tool} failed: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ raw: stdout });
      }
    });
  });
}

// Check for Obsidian session notes matching a worker name/date
function findObsidianNote(workerName) {
  const today = new Date().toISOString().slice(0, 10);
  const candidates = [
    path.join(OBSIDIAN_VAULT, `${today}.md`),
    path.join(OBSIDIAN_VAULT, `workers/${workerName}.md`),
    path.join(OBSIDIAN_VAULT, `sessions/${today}-${workerName}.md`),
    path.join(OBSIDIAN_VAULT, `logs/${today}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { found: true, path: p };
    }
  }
  return {
    found: false,
    suggestion: `${today}-${workerName}.md`,
    search_paths: candidates.map((c) => path.relative(OBSIDIAN_VAULT, c)),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  try {
    // GET endpoints
    if (req.method === "GET") {
      if (url.pathname === "/api/workers") {
        const data = await mcporterCall("list_workers");
        return json(200, data);
      }
      if (url.pathname === "/api/examine") {
        const sid = url.searchParams.get("id");
        if (!sid) return json(400, { error: "missing id param" });
        const data = await mcporterCall("examine_worker", { session_id: sid });
        return json(200, data);
      }
      if (url.pathname === "/api/events") {
        const since = url.searchParams.get("since");
        const args = { include_summary: "true", limit: "50" };
        if (since) args.since = since;
        const data = await mcporterCall("worker_events", args);
        return json(200, data);
      }
      if (url.pathname === "/api/obsidian") {
        const name = url.searchParams.get("name");
        if (!name) return json(400, { error: "missing name param" });
        return json(200, findObsidianNote(name));
      }
      if (url.pathname === "/api/claude-usage") {
        const data = await claudeUsagePlugin.fetchUsage();
        return json(200, data);
      }
    }

    // POST action endpoints
    if (req.method === "POST") {
      if (url.pathname === "/api/action/close") {
        const body = await readBody(req);
        if (!body.session_id) return json(400, { error: "missing session_id" });
        const data = await mcporterCall("close_worker", { session_id: body.session_id });
        return json(200, data);
      }
      if (url.pathname === "/api/action/message") {
        const body = await readBody(req);
        if (!body.session_id || !body.message) return json(400, { error: "missing session_id or message" });
        const data = await mcporterCall("send_message", {
          session_id: body.session_id,
          message: body.message,
        });
        return json(200, data);
      }
    }

    json(404, { error: "not found" });
  } catch (err) {
    json(500, { error: err.message });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.join(__dirname, "public", filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleAPI(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`\n  ⬡ AI Agent Status Cockpit`);
  console.log(`  ➜ http://localhost:${PORT}\n`);
});
