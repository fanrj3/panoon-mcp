---
name: panoon
description: Download Google Street View data with PanoOn. Use when the user asks to download street view imagery, extract PanoIDs for an area/polygon, monitor a PanoOn download job, or manage PanoOn workers. Requires the PanoOn MCP server (tools named panoon_*).
---

# PanoOn — Street View data downloads

PanoOn collects Google Street View imagery: an **Area scan** turns a polygon into PanoIDs,
then a **download job** fetches the JPEGs. Everything is driven through the PanoOn MCP tools.

## Prerequisites

- The PanoOn desktop app (or its local service) must be running on the same machine
  (`http://127.0.0.1:8787`). On Windows the app starts the service automatically (0.2.20+).
- The machine needs a working Google route: a local HTTP/mixed proxy whose port is set in
  the PanoOn app (used by the service) — the same proxy the desktop app downloads through.

## Tools

| Tool | Purpose |
| --- | --- |
| `panoon_status` | Service health, version, area strategies. Call first when something fails. |
| `panoon_area_scan` | Start a polygon → PanoID scan. `waitSeconds` blocks until done (≤600). |
| `panoon_area_status` | Poll a scan's progress. |
| `panoon_area_result` | Counts + PanoID preview; `savePath` writes the full JSON. |
| `panoon_area_cancel` | Stop a scan. |
| `panoon_download` | Queue a JPEG download for PanoIDs into `outputDir`. |
| `panoon_job_status` | Poll a download job (`waitSeconds` blocks). |
| `panoon_jobs` | Recent jobs, newest first. |
| `panoon_workers` | Worker nodes and throughput. |
| `panoon_cancel_job` | Cancel a download job. |

## Typical workflow

1. `panoon_status` — confirm the service is up.
2. `panoon_area_scan { polygon: [...] }` — with `waitSeconds: 60` for small areas.
   Report `uniquePanoIds` and `checkedLocations` to the user.
3. `panoon_area_result { jobId, savePath, maxIds }` — save the PanoID list.
4. **Confirm with the user** the output directory and the scope before downloading.
5. `panoon_download { panoids: [...], outputDir: "D:\\...\\images" }` — then
   `panoon_job_status { jobId, waitSeconds: 60 }` to report progress.

## Rules

- Never start a large download without confirming `outputDir` and the expected size
  (an image is roughly 0.5 MB; a 100 000-PanoID job is tens of GB and consumes proxy quota).
- Prefer the default naming template (`{lat},{lon}_{year}-{month}_{panoid}_d{heading}_z{zoom}.jpg`).
- Scans are cheap and run locally; downloads are queued and can be cancelled safely.
- On failures, call `panoon_status` first and surface the exact error to the user.
