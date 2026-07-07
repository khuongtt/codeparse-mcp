---
name: run-codeparse-mcp
description: Build, run, and interact with codeparse-mcp. Use when asked to start the MCP server, run the CLI pipeline (init/sync/status), parse Java/Xtend files, query the graph DB, take screenshots of MCP tool output, or run tests.
---

All paths relative to `/home/kaj/codeparse-mcp/`.

This is a **CLI + MCP server** — no GUI. Drive it via the driver script at `.claude/skills/run-codeparse-mcp/driver.mjs`, which wraps both the CLI and the MCP JSON-RPC protocol.

## Prerequisites

```bash
# Runtime
node >= 20, npm >= 10
```

## Setup

```bash
npm install
npm install-scripts approve better-sqlite3  # native module build
```

## Run (agent path)

### Smoke test — verifies the full pipeline end-to-end

```bash
node .claude/skills/run-codeparse-mcp/driver.mjs smoke /path/to/java-project
```

Runs: init → sync → status (CLI) → codeparse_status (MCP) → search_classes (MCP). Exits 0 on success.

### CLI mode

```bash
# Initialize DB
node .claude/skills/run-codeparse-mcp/driver.mjs cli /path/to/project init

# Parse files (incremental — re-parses only changed files via SHA-256)
node .claude/skills/run-codeparse-mcp/driver.mjs cli /path/to/project sync --verbose

# Show graph DB stats
node .claude/skills/run-codeparse-mcp/driver.mjs cli /path/to/project status
```

### MCP mode (query the server programmatically)

```bash
# Get DB status
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project codeparse_status

# Get class info
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project get_class '{"qualifiedName":"com.example.MyClass"}'

# Get full UT context (class + methods + CFG + MC/DC + mock targets)
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project get_ut_context '{"qualifiedName":"com.example.MyClass"}'

# Search methods
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project search_methods '{"pattern":"divide"}'

# Get MC/DC analysis for a class
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project get_mcdc_for_class '{"qualifiedName":"com.example.MyClass"}'

# Get CFG for a method
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project get_cfg '{"methodId":1}'

# List all 14 available MCP tools
node .claude/skills/run-codeparse-mcp/driver.mjs mcp /path/to/project codeparse_status
```

### Direct invocation (MCP server on stdio)

For interactive debugging or MCP client testing:

```bash
cd /path/to/project && node src/mcp/server.js
```

The server listens on stdio and speaks JSON-RPC. Send requests by writing newline-delimited JSON. Compatible with GitHub Copilot, Claude Desktop.

### Direct invocation (parsing internals)

For import-and-call without the full pipeline:

```js
import { parseJava } from './src/parser/java-parser.js';
const result = parseJava(sourceCode, 'path/to/File.java');
// → { packageName, imports, classes, errors }
```

Available exports:
- `parseJava(source, filePath)` — full CST-based parser
- `parseXtend(source, filePath)` — pattern-based parser
- `decomposeBoolean(expr)` — split boolean expression into sub-conditions
- `buildTruthTable(subConds)` — full truth table (n ≤ 8)
- `computeMcdcPairs(subConds, truthTable)` — independence pairs for MC/DC

## Run (human path)

```bash
npm start        # start MCP server on stdio
npm run dev      # auto-reload on file changes (--watch)
npm run cli -- <command>   # run CLI
```

Stop with Ctrl-C.

## Test

```bash
npm test
```

Runs `node --test`. No tests written yet.

## Gotchas

- **SQLite double-quote gotcha**: `SELECT ... WHERE status="ok"` fails in SQLite — must use single quotes (`status='ok'`). Already fixed in `src/db/database.js:318`.
- **get_class double-JSON-parse**: `getClassByQualifiedName()` already parses `interfaces` and `annotations` from JSON, but the MCP handler was `JSON.parse`'ing them again. Already fixed in `src/mcp/server.js:354`.
- **`npm install` may warn about install scripts**: `better-sqlite3` needs native compilation. Run `npm install-scripts approve better-sqlite3` if needed.
- **Incremental sync uses SHA-256**: unchanged files are skipped. Use `--force` to re-parse everything.
- **No tests yet**: `npm test` reports 0 tests — not a failure.
- **Xtend parser is pattern-based** (no CST): complex Xtend expressions (lambdas, closures, templates) may produce incomplete CFG.

## Troubleshooting

- **`SqliteError: no such column: ok`**: The status query uses `status="ok"` instead of `status='ok'`. Apply the fix from `src/db/database.js:318`.
- **`Error: Unexpected end of JSON input` on get_class**: The handler double-parses `interfaces/annotations` that are already parsed. Apply the fix from `src/mcp/server.js:354`.
- **MCP server prints nothing on stdout**: The server logs startup to stderr. stdout is the JSON-RPC transport.
