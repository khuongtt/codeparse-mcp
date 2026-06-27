# codeparse-mcp

**Java/Xtend Code Parser → Graph DB → MCP Server**  
Knowledge base for AI-driven ISO 26262 ASIL-D unit test generation with 100% MC/DC + C0 + C1 coverage.

---

## Architecture

```
Java/Xtend Sources
       │
       ▼
  ┌─────────────┐     ┌──────────────────┐
  │ Java Parser │     │  Xtend Parser    │
  │ (java-parser│     │ (pattern-based   │
  │   npm, CST) │     │  + CFG analyzer) │
  └──────┬──────┘     └────────┬─────────┘
         │                     │
         ▼                     ▼
  ┌──────────────────────────────────┐
  │          Graph Builder           │
  │  AST → Classes, Methods,         │
  │  Fields, CFG Nodes/Edges,        │
  │  Call Graph, MC/DC Conditions    │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │       SQLite Graph DB            │
  │  files / classes / methods /     │
  │  cfg_nodes / cfg_edges /         │
  │  call_edges / mcdc_conditions    │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │         MCP Server               │
  │   14 tools exposed via stdio     │
  │   Compatible with:               │
  │   • GitHub Copilot               │
  │   • Claude Desktop               │
  │   • Any MCP client               │
  └──────────────────────────────────┘
```

---

## Quick Start

### Option A: Node.js (local)

```bash
# Install
git clone <repo>
cd codeparse-mcp
npm install

# Initialize DB for your project
node src/cli/index.js init --root /path/to/your/project

# Parse all Java/Xtend files
node src/cli/index.js sync --root /path/to/your/project

# Check status
node src/cli/index.js status
```

### Option B: Docker

```bash
# Build image
docker build -t codeparse-mcp:latest .

# Init DB
docker run --rm \
  -v /your/project:/project:ro \
  -v codeparse-data:/data \
  codeparse-mcp:latest init

# Sync (parse all files)
docker run --rm \
  -v /your/project:/project:ro \
  -v codeparse-data:/data \
  codeparse-mcp:latest sync

# Status
docker run --rm \
  -v /your/project:/project:ro \
  -v codeparse-data:/data \
  codeparse-mcp:latest status

# Or with docker compose
PROJECT_ROOT=/your/project docker compose run --rm codeparse sync
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `codeparse init [--force]` | Initialize/reset graph database |
| `codeparse sync [--force]` | Parse all files, sync changes only |
| `codeparse status [--errors]` | Show graph stats and health |
| `codeparse sync-file <path>` | Sync a single file (incremental) |
| `codeparse serve` | Start MCP server on stdio |

### Sync Options

```bash
codeparse sync \
  --force \                          # Re-parse all files
  --include "**/*.java,**/*.xtend" \ # Custom patterns
  --exclude "**/generated/**" \      # Extra exclusions
  --verbose                          # Per-file progress
```

---

## MCP Integration

### GitHub Copilot (`.vscode/mcp.json`)

```json
{
  "servers": {
    "codeparse": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/src/mcp/server.js"]
    }
  }
}
```

Or via Docker:

```json
{
  "servers": {
    "codeparse": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "${workspaceFolder}:/project:ro",
        "-v", "codeparse-data:/data",
        "codeparse-mcp:latest", "serve"
      ]
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

See `config/claude-desktop-mcp.json` for the full example.

---

## MCP Tools

### Lifecycle
| Tool | Description |
|------|-------------|
| `codeparse_init` | Initialize/reset DB |
| `codeparse_sync` | Parse and sync all files |
| `codeparse_status` | DB health and statistics |
| `sync_file` | Sync a single file |

### Class Queries
| Tool | Description |
|------|-------------|
| `get_class` | Full class info (fields, hierarchy, annotations, ASIL) |
| `search_classes` | Find classes by name pattern |

### Method Queries
| Tool | Description |
|------|-------------|
| `get_methods` | All methods for a class |
| `search_methods` | Find methods by name/signature |

### Control Flow Graph
| Tool | Description |
|------|-------------|
| `get_cfg` | CFG nodes + edges for a method (C0/C1 coverage) |

### MC/DC (ISO 26262 ASIL-D)
| Tool | Description |
|------|-------------|
| `get_mcdc` | MC/DC conditions, truth tables, independence pairs for a method |
| `get_mcdc_for_class` | All MC/DC data for entire class |

### Call Graph
| Tool | Description |
|------|-------------|
| `get_callees` | Methods called by a method (mock targets) |
| `get_callers` | Methods that call a method (impact) |

### UT Generation
| Tool | Description |
|------|-------------|
| `get_ut_context` | **Primary tool** — full context for AI UT generation: class + methods + CFG + MC/DC + mock targets |
| `get_dependencies` | Import dependencies for a file |

---

## What Gets Parsed

### Java
- Package and import declarations
- Class/interface/enum/annotation declarations (nested included)
- All modifiers, annotations, Javadoc
- Method signatures, parameters, return types, throws
- Field declarations with types and visibility
- CFG: if/for/while/do/switch/try/catch/return/throw nodes and edges
- MC/DC: boolean condition decomposition, truth tables, independence pairs
- Call graph: method invocations with line numbers
- ASIL level detection from `@ASIL_D` annotations or `/** @ASIL D */` Javadoc

### Xtend
- Package, import, class declarations
- `def`, `override`, `dispatch` methods
- `val`/`var` fields + Java-style fields
- All visibility modifiers
- CFG: if/for/while/do/switch/try/catch/return/throw (pattern-based)
- MC/DC analysis on boolean expressions
- Extension method detection
- ASIL annotation detection

---

## Graph DB Schema

The SQLite database stores:

```
files           → source file registry + SHA-256 for change detection
packages        → Java package index
classes         → class/interface/enum with full metadata
methods         → method signatures + CFG stats + MC/DC summary
fields          → class fields
cfg_nodes       → CFG nodes per method (ENTRY, STATEMENT, BRANCH, LOOP, RETURN, ...)
cfg_edges       → CFG edges (sequential, true_branch, false_branch, exception, loop_back)
call_edges      → caller → callee relationships
dependencies    → file-level import and type dependencies
mcdc_conditions → expanded MC/DC conditions with truth tables and independence pairs
parse_errors    → per-file error log
```

---

## Example: AI UT Generation Workflow

```
1. User asks Copilot/Claude: "Generate unit tests for com.safety.BrakeController"

2. AI calls: get_ut_context { qualifiedName: "com.safety.BrakeController" }

3. Response includes:
   - Class metadata + ASIL-D level
   - All 12 methods with parameters and signatures
   - CFG for each method (C0/C1 coverage map)
   - MC/DC conditions with independence pairs (ASIL-D 100% target)
   - Mock targets (callees to stub)
   - Estimated minimum 47 test cases needed

4. AI generates JUnit 5 test class covering:
   - All statement paths (C0)
   - All branch pairs (C1)
   - All MC/DC independence pairs
   - ASIL-D annotation on each test
```

---

## Configuration (`.codeparse.json`)

```json
{
  "projectRoot": "/path/to/project",
  "dbPath": "/path/to/.codeparse/graph.db",
  "include": ["**/*.java", "**/*.xtend"],
  "exclude": [
    "**/node_modules/**",
    "**/build/**",
    "**/target/**",
    "**/.gradle/**",
    "**/generated/**"
  ]
}
```

---

## Incremental Sync

Files are tracked by SHA-256 hash. On each `sync`:
- New files → parsed and inserted
- Changed files → deleted from DB (cascade) and re-parsed
- Unchanged files → skipped (fast)
- Call graph → second-pass resolution of caller→callee IDs

This means `sync` is safe to run on every save or in CI without performance penalty.

---

## Extending: Add More Languages

1. Add a parser in `src/parser/<lang>-parser.js` implementing `parse<Lang>(source, path)`
2. Return `{ packageName, imports, classes }` matching the existing schema
3. Add the extension to `include` globs in config
4. Register in `src/graph/builder.js` `syncProject` switch

---

## Requirements

- Node.js ≥ 20
- Or Docker (no Node required on host)
- SQLite (bundled via better-sqlite3)
