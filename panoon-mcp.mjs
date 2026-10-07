#!/usr/bin/env node
/**
 * PanoOn MCP server — expose PanoOn street-view workflows to any MCP-capable agent.
 *
 * Transport: MCP stdio (newline-delimited JSON-RPC 2.0). Zero dependencies; runs with
 * any Node >= 18, including the PanoOn bundled runtime:
 *
 *   node mcp/panoon-mcp.mjs
 *   panoon-service-runtime.exe mcp/panoon-mcp.mjs
 *
 * Environment:
 *   PANOON_SERVICE_URL   local service base URL (default http://127.0.0.1:8787)
 *
 * All HTTP calls target the PanoOn local service (area jobs) and/or the distributed
 * controller (image download jobs). Stdout carries protocol frames only; diagnostics
 * go to stderr.
 */
import { promises as fs } from "node:fs";
import readline from "node:readline";
import process from "node:process";

const DEFAULT_SERVICE_URL = (process.env.PANOON_SERVICE_URL || "http://127.0.0.1:8787").trim();
const DEFAULT_NAMING_TEMPLATE = "{lat},{lon}_{year}-{month}_{panoid}_d{heading}_z{zoom}.jpg";
const PROTOCOL_FALLBACK = "2025-06-18";
const MAX_PANOIDS_PER_JOB = 250_000;
const TERMINAL_STATES = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

const log = (...parts) => process.stderr.write(`[panoon-mcp] ${parts.join(" ")}\n`);

function normalizeBase(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_SERVICE_URL;
}

async function api(base, path, { method = "GET", body, timeoutMs = 20_000 } = {}) {
  const target = `${normalizeBase(base)}${path}`;
  let response;
  try {
    response = await fetch(target, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Cannot reach the PanoOn service at ${target} (${error?.message ?? error}). Start the PanoOn app or its local service first.`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail = json?.message ?? json?.error ?? text.slice(0, 300);
    throw new Error(`PanoOn service returned HTTP ${response.status}: ${detail}`);
  }
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function areaSummary(snapshot) {
  const progress = snapshot?.progress ?? {};
  return {
    jobId: snapshot?.jobId ?? "",
    state: snapshot?.state ?? "",
    stage: snapshot?.stage ?? "",
    checkedLocations: progress.checkedLocations ?? 0,
    totalLocations: progress.totalLocations ?? 0,
    uniquePanoIds: progress.uniquePanoIds ?? 0,
    errorCount: progress.errorCount ?? 0,
    elapsedMillis: progress.elapsedMillis ?? 0,
  };
}

function jobSummary(job) {
  const progress = job?.progress ?? {};
  return {
    jobId: job?.jobId ?? "",
    state: job?.state ?? "",
    total: progress.total ?? 0,
    completed: progress.completed ?? 0,
    failed: progress.failed ?? 0,
    skippedExisting: progress.skippedExisting ?? 0,
    percent: progress.percent ?? 0,
    outputDir: job?.options?.outputDir ?? "",
  };
}

function validatePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new Error("polygon must be an array with at least 3 { lat, lng } points.");
  }
  return polygon.map((point, index) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(`polygon[${index}] must be { lat: number, lng: number }.`);
    }
    return { lat, lng };
  });
}

async function waitForTerminal(fetchSnapshot, waitSeconds, intervalMs = 2000) {
  const seconds = Math.max(0, Math.min(600, Number(waitSeconds) || 0));
  let snapshot = await fetchSnapshot();
  if (seconds === 0 || TERMINAL_STATES.has(snapshot?.state)) return snapshot;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    snapshot = await fetchSnapshot();
    if (TERMINAL_STATES.has(snapshot?.state)) return snapshot;
  }
  return snapshot;
}

const tools = [
  {
    name: "panoon_status",
    description:
      "Check the PanoOn local service: reachability, version, area-metadata capabilities and supported strategies. Call this first when anything fails.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const [health, version] = await Promise.all([
        api(DEFAULT_SERVICE_URL, "/health", { timeoutMs: 8000 }),
        api(DEFAULT_SERVICE_URL, "/version", { timeoutMs: 8000 }),
      ]);
      return {
        serviceUrl: normalizeBase(DEFAULT_SERVICE_URL),
        health,
        version: version?.version ?? "",
        buildId: version?.buildId ?? "",
        areaMetadataSupported: Array.isArray(version?.features) && version.features.includes("area-metadata"),
        strategies: version?.areaMetadata?.strategies ?? [],
      };
    },
  },
  {
    name: "panoon_area_scan",
    description:
      "Start an Area PanoID scan: collect every Street View panorama inside a polygon and return their PanoIDs. The scan runs on the local service; poll with panoon_area_status (or pass waitSeconds) and fetch results with panoon_area_result.",
    inputSchema: {
      type: "object",
      properties: {
        polygon: {
          type: "array",
          description: "Polygon outline, at least 3 { lat, lng } points.",
          items: { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } }, required: ["lat", "lng"] },
        },
        strategy: {
          type: "string",
          description: "Area strategy. Default fast-geophoto (coverage tiles). Others: dense-rpc-grid, official-metadata, hybrid, custom.",
        },
        crawlingDistanceMeters: { type: "number", description: "Probe spacing in meters (default 463; smaller = denser probes)." },
        outputDir: { type: "string", description: "Optional directory for saved area output files." },
        waitSeconds: { type: "integer", description: "0-600. Wait up to this long for completion before returning." },
      },
      required: ["polygon"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const boundsCoordinates = validatePolygon(args.polygon);
      const created = await api(DEFAULT_SERVICE_URL, "/v1/area/jobs", {
        method: "POST",
        body: {
          strategy: args.strategy || "fast-geophoto",
          boundsCoordinates,
          crawlingDistanceMeters: Number(args.crawlingDistanceMeters ?? 463),
          options: { outdoorOnly: true },
          filters: { date: { from: "", to: "" }, copyright: "", sampleSize: 0 },
          outputDir: String(args.outputDir ?? "").trim(),
        },
      });
      const jobId = created?.jobId ?? "";
      if (!jobId) throw new Error("The service did not return a job id.");
      const snapshot = await waitForTerminal(
        () => api(DEFAULT_SERVICE_URL, `/v1/area/jobs/${jobId}`),
        args.waitSeconds,
      );
      return areaSummary(snapshot);
    },
  },
  {
    name: "panoon_area_status",
    description: "Fetch the progress of an Area PanoID scan started with panoon_area_scan. Optional waitSeconds blocks until it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        waitSeconds: { type: "integer", description: "0-600. Wait up to this long for completion." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error("jobId is required.");
      const snapshot = await waitForTerminal(
        () => api(DEFAULT_SERVICE_URL, `/v1/area/jobs/${jobId}`),
        args.waitSeconds,
      );
      return areaSummary(snapshot);
    },
  },
  {
    name: "panoon_area_result",
    description:
      "Fetch the final result of an Area PanoID scan: counts plus a preview of unique PanoIDs. Pass savePath to write the full JSON result to disk.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        maxIds: { type: "integer", description: "How many PanoIDs to include in the preview (default 2000)." },
        savePath: { type: "string", description: "Optional file path to save the complete result JSON." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error("jobId is required.");
      const result = await api(DEFAULT_SERVICE_URL, `/v1/area/jobs/${jobId}/result`, { timeoutMs: 120_000 });
      const ids = Array.isArray(result?.uniquePanoIds) ? result.uniquePanoIds : [];
      const maxIds = Math.max(0, Number(args.maxIds ?? 2000));
      let savedPath = "";
      if (args.savePath) {
        savedPath = String(args.savePath);
        await fs.writeFile(savedPath, JSON.stringify(result, null, 1), "utf8");
      }
      return {
        jobId,
        checkedLocations: result?.checkedLocations ?? 0,
        successResults: result?.successResults?.length ?? ids.length,
        errorResults: result?.errorResults?.length ?? 0,
        uniquePanoIds: ids.length,
        previewPanoIds: ids.slice(0, maxIds),
        savedPath,
      };
    },
  },
  {
    name: "panoon_area_cancel",
    description: "Cancel a running Area PanoID scan.",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error("jobId is required.");
      return api(DEFAULT_SERVICE_URL, `/v1/area/jobs/${jobId}/cancel`, { method: "POST" });
    },
  },
  {
    name: "panoon_download",
    description:
      "Queue a street-view image download job for a list of PanoIDs. Images are written as JPEG under outputDir by the controller/workers. Returns a jobId; monitor with panoon_job_status. Confirm outputDir and scope with the user before large jobs.",
    inputSchema: {
      type: "object",
      properties: {
        panoids: { type: "array", items: { type: "string" }, description: "PanoIDs to download (max 250000 per job)." },
        outputDir: { type: "string", description: "Absolute output directory for the JPEG files." },
        zoom: { type: "integer", description: "Zoom level (default 3 → 2048x1024)." },
        jpegQuality: { type: "integer", description: "JPEG quality 1-100 (default 95)." },
        namingTemplate: { type: "string", description: "Filename template. Default \"{lat},{lon}_{year}-{month}_{panoid}_d{heading}_z{zoom}.jpg\"." },
        serverUrl: { type: "string", description: "Distributed controller URL. Default: the local service." },
      },
      required: ["panoids", "outputDir"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const panoids = (Array.isArray(args.panoids) ? args.panoids : [])
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (!panoids.length) throw new Error("panoids must contain at least one PanoID.");
      if (panoids.length > MAX_PANOIDS_PER_JOB) {
        throw new Error(`panoids exceeds the per-job limit of ${MAX_PANOIDS_PER_JOB}.`);
      }
      const outputDir = String(args.outputDir ?? "").trim();
      if (!outputDir) throw new Error("outputDir is required.");
      const zoom = Number(args.zoom ?? 3);
      const job = await api(normalizeBase(args.serverUrl), "/v1/distributed/jobs", {
        method: "POST",
        timeoutMs: 120_000,
        body: {
          options: { storageMode: "upload-back", outputDir, overwrite: false },
          panoids,
          payload: {
            outputMode: "upload-back",
            namingTemplate: String(args.namingTemplate ?? DEFAULT_NAMING_TEMPLATE),
            image: {
              zoom,
              width: zoom >= 3 ? 2048 : 1024,
              height: zoom >= 3 ? 1024 : 512,
              jpegQuality: Number(args.jpegQuality ?? 95),
              saveDepthMaps: false,
              overwrite: false,
            },
          },
        },
      });
      return jobSummary(job);
    },
  },
  {
    name: "panoon_job_status",
    description: "Fetch progress of a download job started with panoon_download. Optional waitSeconds blocks until it reaches a terminal state.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        serverUrl: { type: "string" },
        waitSeconds: { type: "integer", description: "0-600. Wait up to this long for a terminal state." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error("jobId is required.");
      const base = normalizeBase(args.serverUrl);
      const job = await waitForTerminal(() => api(base, `/v1/distributed/jobs/${jobId}`), args.waitSeconds);
      return jobSummary(job);
    },
  },
  {
    name: "panoon_jobs",
    description: "List recent download jobs (newest first) from the local service or a distributed controller.",
    inputSchema: {
      type: "object",
      properties: { serverUrl: { type: "string" }, limit: { type: "integer" } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
      const payload = await api(normalizeBase(args.serverUrl), `/v1/distributed/jobs?limit=${limit}`);
      return { jobs: (payload?.jobs ?? []).map(jobSummary) };
    },
  },
  {
    name: "panoon_workers",
    description: "Show distributed worker nodes: online counts, running tasks and per-node throughput.",
    inputSchema: { type: "object", properties: { serverUrl: { type: "string" } }, additionalProperties: false },
    handler: async (args) => {
      const payload = await api(normalizeBase(args.serverUrl), "/v1/distributed/workers");
      const workers = (payload?.workers ?? [])
        .filter((worker) => worker.online)
        .map((worker) => ({
          name: worker.name,
          state: worker.state,
          imagesPerMinute: worker.metrics?.imagesPerMinute ?? 0,
          success: worker.metrics?.success ?? 0,
          failed: worker.metrics?.failed ?? 0,
        }));
      return { summary: payload?.summary ?? {}, workers };
    },
  },
  {
    name: "panoon_cancel_job",
    description: "Cancel a download job (local service or distributed controller).",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" }, serverUrl: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "").trim();
      if (!jobId) throw new Error("jobId is required.");
      return api(normalizeBase(args.serverUrl), `/v1/distributed/jobs/${jobId}/cancel`, { method: "POST" });
    },
  },
];

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

async function handleToolCall(params) {
  const tool = toolByName.get(String(params?.name ?? ""));
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
  }
  try {
    const result = await tool.handler(params?.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    log("tool error:", tool.name, String(error?.message ?? error));
    return { content: [{ type: "text", text: `Error in ${tool.name}: ${error?.message ?? error}` }], isError: true };
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === undefined) return; // response frames from the client: ignore
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_FALLBACK;
      respond(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "panoon", version: "1.0.0" },
        instructions:
          "PanoOn street-view toolkit. Typical flow: panoon_status → panoon_area_scan (polygon) → panoon_area_result (PanoIDs) → panoon_download (panoids + outputDir) → panoon_job_status. Large downloads consume proxy quota; confirm outputDir and scope with the user.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (!isNotification) respond(id, {});
      return;
    case "tools/list":
      respond(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case "tools/call": {
      if (isNotification) return;
      const result = await handleToolCall(params);
      respond(id, result);
      return;
    }
    default:
      if (!isNotification) respondError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log("dropped unparseable line");
    return;
  }
  void handleMessage(message).catch((error) => {
    log("handler failure:", String(error?.message ?? error));
    if (message?.id !== undefined && message?.id !== null) {
      respondError(message.id, -32603, `Internal error: ${error?.message ?? error}`);
    }
  });
});
rl.on("close", () => process.exit(0));
log(`ready; service=${normalizeBase(DEFAULT_SERVICE_URL)}; tools=${tools.length}`);
