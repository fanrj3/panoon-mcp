# PanoOn MCP + agent skills

Give any MCP-capable code agent the ability to scan and download Street View data
through PanoOn: `mcp/panoon-mcp.mjs` is a zero-dependency MCP stdio server that
wraps the PanoOn local service and the distributed controller.

## Quick start (npm)

```sh
npx -y panoon-mcp
```

The npm package `panoon-mcp` exposes the `panoon-mcp` bin. You can also download
`panoon-mcp.zip` from <https://app.rjfan.org/panoon/mcp/>, or use the copy bundled
with PanoOn 0.2.21+ (`<install>\mcp\panoon-mcp.mjs`).

Prerequisite: the PanoOn app/service is running on the same machine
(`http://127.0.0.1:8787`; the desktop app starts it automatically since 0.2.20).

## The server

```sh
node mcp/panoon-mcp.mjs
# or with the runtime bundled with PanoOn (no Node install required):
"C:\Users\<you>\AppData\Local\PanoOn\panoon-service-runtime.exe" mcp\panoon-mcp.mjs
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANOON_SERVICE_URL` | `http://127.0.0.1:8787` | Local service base URL. |

Tools: `panoon_status`, `panoon_area_scan`, `panoon_area_status`,
`panoon_area_result`, `panoon_area_cancel`, `panoon_download`,
`panoon_job_status`, `panoon_jobs`, `panoon_workers`, `panoon_cancel_job`.

## Install per agent

### OpenCode (V2)

```sh
opencode mcp add panoon --global -- node <repo>\mcp\panoon-mcp.mjs
opencode mcp list
```

or by hand in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "panoon": {
        "type": "local",
        "command": ["node", "<repo>/mcp/panoon-mcp.mjs"],
        "environment": { "PANOON_SERVICE_URL": "http://127.0.0.1:8787" }
      }
    }
  }
}
```

Skill: copy `mcp/skills/panoon/` into your OpenCode skills location (or reference
the folder from the `skills` configuration field).

### Claude Code

```sh
claude mcp add --scope user panoon -- node <repo>/mcp/panoon-mcp.mjs
```

or `.mcp.json`:

```json
{ "mcpServers": { "panoon": { "command": "node", "args": ["<repo>/mcp/panoon-mcp.mjs"] } } }
```

Skill: copy `mcp/skills/panoon/` to `~/.claude/skills/panoon/`.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.panoon]
command = "node"
args = ["<repo>/mcp/panoon-mcp.mjs"]
env = { PANOON_SERVICE_URL = "http://127.0.0.1:8787" }
```

For Codex, paste the workflow section of `mcp/skills/panoon/SKILL.md` into your
`AGENTS.md` so the agent knows the intended flow.

### Any other MCP client (stdio)

Use the generic stdio contract:

```json
{
  "command": "node",
  "args": ["<repo>/mcp/panoon-mcp.mjs"],
  "env": { "PANOON_SERVICE_URL": "http://127.0.0.1:8787" }
}
```

### DeepSeek Harness (dsh)

```sh
deepseek mcp add panoon --command node --arg <repo>\mcp\panoon-mcp.mjs
deepseek mcp list
```

This writes `~/.deepseek/mcp.json` (`servers.panoon`; tools surface namespaced by
the harness). Install the skill by copying `mcp/skills/panoon/` into
`~/.deepseek/skills/panoon/` — dsh uses the same `SKILL.md` contract as Claude
Code — then restart the harness so both are picked up.

On this machine the working example is:

```sh
deepseek mcp add panoon --command node --arg D:\04_Dev\PanoOn\mcp\panoon-mcp.mjs
copy D:\04_Dev\PanoOn\mcp\skills\panoon %USERPROFILE%\.deepseek\skills\panoon
```

## Typical agent flow

1. `panoon_status` → service healthy, strategies available.
2. `panoon_area_scan { polygon: [{lat,lng}, ...] }` → jobId; `panoon_area_result` → PanoIDs.
3. Confirm output directory with the user.
4. `panoon_download { panoids, outputDir }` → jobId; `panoon_job_status` for progress.

Safety: downloads are large (~0.5 MB/image) and consume proxy quota. Agents should
confirm scope and output paths before submitting jobs; scans are cheap and can be
cancelled at any time.
