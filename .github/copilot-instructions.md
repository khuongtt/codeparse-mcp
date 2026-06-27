# Copilot Instructions for codeparse-mcp

Purpose: quick reference so future Copilot/AI sessions understand how to run, test, and extend this repository.

---

1) Build / run / test / lint commands

- Install dependencies: npm install
- Start MCP server (stdio): npm start
  - Equivalent: node src/mcp/server.js
- Run CLI: npm run cli or use installed binary: codeparse <command>
- Dev server (auto-reload): npm run dev
- Parse / sync examples (from README):
  - Init DB: node src/cli/index.js init --root /path/to/project
  - Full sync: node src/cli/index.js sync --root /path/to/project
  - Sync single file: node src/cli/index.js sync-file path/to/File.java
  - Status: node src/cli/index.js status
- Tests: npm test (runs Node's built-in test runner: node --test)
  - Run a single test file: node --test test/path/to/file.test.js
  - Running a single test by file is preferred; no test framework (Jest/Mocha) configured.
- Lint: no linter configured in package.json. (Add ESLint if desired.)

Note: Node.js >= 20 is required (see engines).

---

2) High-level architecture (short)

- Parsers (src/parser/*.js) parse Java and Xtend into AST/CST and produce:
  packageName, imports, classes (fields, methods), CFG nodes/edges, call sites, MC/DC conditions.
- Graph Builder (src/graph/builder.js) orchestrates file scanning, parsing, and persists everything to a SQLite graph DB via GraphDatabase (src/db/database.js).
- SQLite Graph DB stores tables: files, packages, classes, methods, fields, cfg_nodes, cfg_edges, call_edges, dependencies, mcdc_conditions, parse_errors, etc.
- MCP server (src/mcp/server.js) exposes ~14 tools over MCP stdio (compatible with GitHub Copilot, Claude Desktop). Primary tool: get_ut_context which returns class+method+CFG+MC/DC+mock data for AI-driven unit test generation.
- CLI (src/cli/index.js) wraps common flows (init, sync, status, sync-file, serve) for local and CI usage.
- Incremental sync is SHA-256 based: unchanged files are skipped, changed files re-parsed and replaced in DB.
- Docker: Dockerfile and docker-compose.yml provide containerized runs (README has examples for init/sync/status).

---

3) Key repository conventions and patterns

- Project config: .codeparse.json (project root) controls projectRoot, dbPath, include/exclude globs. CLI and MCP server load this.
- Include/exclude: default include is **/*.java and **/*.xtend; default excludes common build folders.
- Incremental sync: file content hashed with sha256 (src/db/database.js -> sha256). Builder checks DB file record and skips unchanged files.
- Parser extension pattern: add a new file at src/parser/<lang>-parser.js exposing parse<Lang>(source, path) and return { packageName, imports, classes, errors, ... }. Register parsing branch in src/graph/builder.js (syncProject / syncFile). Follow existing java/xtend implementations.
- DB schema: schema applied from src/db/schema.sql (GraphDatabase._applySchema). Use GraphDatabase transaction() for multi-insert operations.
- Call graph resolution: builder inserts call_edges with callee_name then GraphDatabase.resolveCalleeIds() attempts to map to method IDs in a second pass.
- MCP tools naming: tool names are literal (e.g., codeparse_sync, get_ut_context). Clients should call these exact tool names.
- MCP server: runs over stdio; examples for Copilot and Docker are in README (also config/*.json contains examples for CLAUDE/Desktop).
- CLI scripts: package.json exposes "cli" script and a bin entry so `codeparse` can be used if installed globally or via npm link.

---

4) Where to look first (important files)

- src/mcp/server.js — MCP tool definitions and handlers.
- src/graph/builder.js — parsing orchestration and persistence logic.
- src/db/database.js — DB helpers, schema application, and queries used by tools.
- src/cli/index.js — user-facing commands (init, sync, status, sync-file, serve).
- src/parser/ — place to add/inspect language parsers (java-parser.js, xtend-parser.js).
- README.md — usage examples, Docker and MCP client examples.

---

5) Notes for AI sessions

- Prefer `get_ut_context` as the single query that returns the full context needed for unit test generation (class metadata, methods, CFG, MC/DC, mock targets).
- For code changes: updating parser behavior usually requires updating both src/parser/<lang>-parser.js and possibly mapping in src/graph/builder.js.
- Avoid touching DB migration logic without updating src/db/schema.sql.

---

If this file needs additions (more commands, CI details, or examples for MCP client configuration), update it in .github/copilot-instructions.md so future Copilot sessions pick up the exact guidance.
