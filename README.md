# codeparse-mcp

**Java/Xtend Code Parser → IR → Graph DB → MCP Server**
Knowledge base for AI-driven ISO 26262 ASIL-D unit test generation with 100% MC/DC + C0 + C1 coverage.

---

## Architecture (v3)

```
Java/Xtend Sources
       │
       ├── JavaParser AST Extractor (Java CLI, production)
       │     └── Decision IR (JSON, camelCase)
       │                              │
       ├── Xtend AST Extractor (line-based POC)
       │     └── Decision IR (JSON, camelCase)
       │                              │
       ├── Fallback JS Java Parser (java-parser npm CST)
       │     └── Decision IR (JSON, camelCase)
       │                              │
       └── Fallback JS Xtend Parser (pattern-based)
             └── Decision IR (JSON, camelCase)
                                      │
                                      ▼
                            ┌─────────────────────┐
                            │  ir-ingest.js        │
                            │  Validate IR schema  │
                            │  Compute MC/DC       │
                            │  (centralized, not   │
                            │   duplicated per     │
                            │   parser)            │
                            └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │    SQLite Graph DB   │
                            │   (better-sqlite3)   │
                            └──────────┬──────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │     MCP Server       │
                            │  20 tools via stdio  │
                            │  Compatible with:    │
                            │  • GitHub Copilot    │
                            │  • Claude Desktop    │
                            │  • Any MCP client    │
                            └─────────────────────┘
```

**Key design:** AI reads MCP only — never reads raw IR or source files directly. IR is an internal transport format.

---

## Quick Start

### Local

```bash
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

### Docker

```bash
docker build -t codeparse-mcp:latest .

# Init DB
docker run --rm \
  -v /your/project:/project:ro \
  -v codeparse-data:/data \
  codeparse-mcp:latest init

# Sync
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
| `codeparse import-results --junit <path> [--jacoco <path>]` | Import JUnit/JaCoCo results |
| `codeparse evidence --asil <level> --class <qname> --output <dir>` | Generate ISO 26262 evidence package |

### Sync Options

```bash
codeparse sync \
  --force                          # Re-parse all files
  --include "**/*.java,**/*.xtend" # Custom patterns
  --exclude "**/generated/**"      # Extra exclusions
  --verbose                        # Per-file progress
```

### Import Test Results

```bash
# Import JUnit XML + JaCoCo coverage
codeparse import-results \
  --junit build/test-results/test  # JUnit Surefire XML dir
  --jacoco build/reports/jacoco/test/jacoco.xml
```

### Generate Evidence Package

```bash
codeparse evidence \
  --asil D \
  --class com.example.SafetyController \
  --output evidence/
```

Generates 10-file ISO 26262 evidence package:
- Decision list, MC/DC matrix, test mapping, traceability matrix
- Coverage gap analysis, audit summary, test specification
- Requirements cross-reference, review checklist, compliance report

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

### Claude Desktop (`claude_desktop_config.json`)

See `config/claude-desktop-mcp.json` for full example.

---

## MCP Tools (20 total)

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
| `get_method_context` | Full source context: code, fields, calls, decisions, parse quality |

### Control Flow Graph
| Tool | Description |
|------|-------------|
| `get_cfg` | CFG nodes + edges for a method (C0/C1 coverage) |
| `get_decisions` | All decisions with decomposed atomic conditions (decision-UID scoped) |

### MC/DC (ISO 26262 ASIL-D)
| Tool | Description |
|------|-------------|
| `get_mcdc` | MC/DC conditions, truth tables, independence pairs per method |
| `get_mcdc_for_class` | All MC/DC data for entire class |

### Call Graph
| Tool | Description |
|------|-------------|
| `get_callees` | Methods called by a method (mock targets) |
| `get_callers` | Methods that call a method (impact analysis) |

### UT Generation (primary AI workflow)
| Tool | Description |
|------|-------------|
| `get_ut_context` | **Primary tool** — full context: class + methods + CFG + MC/DC + field accesses + boundary hints + mock targets in one call |
| `get_dependencies` | Import dependencies for a file |

### Evidence & Coverage (v2.5)
| Tool | Description |
|------|-------------|
| `import_test_results` | Import JUnit XML + JaCoCo XML coverage data |
| `get_coverage_summary` | Query line/branch/instruction coverage per class/method |
| `export_evidence_plan` | Generate 10-file ISO 26262 evidence package |

---

## What Gets Parsed

### Java
- Package and import declarations
- Class/interface/enum/annotation declarations (nested included)
- All modifiers, annotations, Javadoc
- Method signatures, parameters, return types, throws
- Field declarations with types and visibility
- CFG: if/for/while/do/switch/try/catch/return/throw/break/continue nodes and edges
- MC/DC: boolean condition decomposition via AST tree parser, truth tables, independence pairs
- `else if` kind detection (not plain `if`)
- Call graph: method invocations with line numbers
- Field access tracking (reads and writes via `this.` / `obj.`)
- ASIL level detection from `@ASIL_D` annotations or `/** @ASIL D */` Javadoc
- Exception types on CATCH/THROW CFG nodes
- Ternary expressions (`cond ? a : b`) as decisions

### Xtend
- Package, import, class declarations
- `def`, `override`, `dispatch` methods
- `val`/`var` fields + Java-style fields
- All visibility modifiers
- CFG: if/for/while/do/switch/try/catch/return/throw (pattern-based) with loop body edges
- MC/DC analysis on boolean expressions
- Balanced-parenthesis condition extraction (handles nested parens)
- Extension method detection
- `«IF»`/`«ELSEIF»` template condition parsing
- Ternary expressions with nested ternary support
- ASIL annotation detection

---

## Graph DB Schema

The SQLite database stores:

```
files               → source file registry + SHA-256 for change detection
packages            → Java package index
classes             → class/interface/enum with full metadata + ASIL level
methods             → method signatures + CFG stats + MC/DC summary + ASIL level
fields              → class fields
cfg_nodes           → CFG nodes per method (ENTRY, STATEMENT, BRANCH, LOOP, CATCH, THROW, ...)
cfg_edges           → CFG edges (sequential, true_branch, false_branch, exception, loop_back)
call_edges          → caller → callee relationships
field_accesses      → per-method field read/write tracking (mock/state setup)
dependencies        → file-level import and type dependencies
decisions           → each branch point (if/while/for/ternary/etc.) with expression
conditions          → atomic conditions decomposed from decisions (condition-UID scoped)
mcdc_conditions     → expanded MC/DC with truth tables and independence pairs
mcdc_pairs          → normalized per-condition independence pairs with test vectors
test_cases          → test-to-target method traceability
test_results        → JUnit execution results (from Surefire XML)
coverage_records    → JaCoCo line/branch/instruction coverage
evidence_log        → evidence package generation tracking
parse_errors        → per-file error log
```

---

## Evidence Export Package (v2.5)

The `export_evidence_plan` MCP tool (or `codeparse evidence` CLI) generates 10 ISO 26262 evidence files:

| File | Content |
|------|---------|
| `01_decision_list.xlsx` | All decisions with UIDs, kind, expression, conditions |
| `02_mcdc_matrix.xlsx` | MC/DC independence pairs per condition |
| `03_test_mapping.xlsx` | Test cases mapped to decisions/conditions |
| `04_traceability_matrix.xlsx` | Requirements → decisions → tests |
| `05_coverage_gap_analysis.xlsx` | Uncovered branches/pairs analysis |
| `06_audit_summary.md` | Audit trail with timestamps |
| `07_test_specification.md` | Generated test specification |
| `08_requirements_cross_ref.md` | ISO 26262 requirement cross-reference |
| `09_review_checklist.md` | Peer review checklist |
| `10_compliance_report.md` | ASIL-D compliance summary |

---

## Incremental Sync

Files tracked by SHA-256 hash. On each `sync`:
- New files → parsed and inserted
- Changed files → deleted from DB (cascade) and re-parsed
- Unchanged files → skipped (fast)
- Call graph → second-pass resolution of caller→callee IDs
- Content hash prevents re-parsing identical files on repeated runs

Safe to run on every save or in CI without performance penalty.

---

## Extractor Chain (Auto-Fallback)

When parsing a file, the system tries in order:
1. **Java AST Extractor** (`extractors/java/`) — Java CLI tool using JavaParser library, produces full IR
2. **Xtend AST Extractor** (`extractors/xtend/`) — line-based POC, template_if/elseif/ternary support
3. **Fallback JS parser** — `java-parser.js` (CST via npm) or `xtend-parser.js` (pattern-based)

Extractors produce camelCase IR JSON. Fallback runs if Java is not available.
MC/DC pair computation is centralized in `ir-ingest.js` — not duplicated per parser.

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

Environment variable override (for Docker): `CODEPARSE_PROJECT_ROOT`, `CODEPARSE_DB_PATH`.

---

## Extending: Add More Languages

1. Add parser in `src/parser/<lang>-parser.js` exporting `parse<Lang>(source, path)` → `{ packageName, imports, classes }`
2. Add AST extractor in `extractors/<lang>/` producing camelCase IR JSON
3. Add extension to `include` globs in config
4. Register parsing branch in `src/graph/builder.js` `syncProject` switch
5. IR ingest in `src/graph/ir-ingest.js` handles MC/DC automatically

---

## Known Gaps (P3)

- No lambda/stream support — `.filter().map()` logic invisible to CFG
- No switch expressions (Java 17+ `->` arrow cases)
- No `dispatch` method support in Xtend parser
- No Xtend extension method resolution
- No JML/pre-post condition parsing
- No requirement/safety-goal traceability table in schema

---

## Requirements

- Node.js ≥ 20
- Or Docker (no Node required on host)
- SQLite (bundled via better-sqlite3)
