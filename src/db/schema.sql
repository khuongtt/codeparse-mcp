-- ============================================================
-- codeparse-mcp Graph Database Schema
-- ISO 26262 ASIL-D Knowledge Base for UT Generation
-- ============================================================

-- ---- META ----
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta VALUES ('schema_version', '2');
INSERT OR IGNORE INTO meta VALUES ('created_at', datetime('now'));

-- ---- FILES ----
-- Tracks every parsed source file
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,          -- relative to project root
  abs_path    TEXT    NOT NULL,
  lang        TEXT    NOT NULL CHECK(lang IN ('java','xtend')),
  sha256      TEXT    NOT NULL,                 -- content hash for change detection
  parsed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  line_count  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'ok'     -- ok | error | skipped
);

-- ---- PACKAGES ----
CREATE TABLE IF NOT EXISTS packages (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

-- ---- CLASSES ----
CREATE TABLE IF NOT EXISTS classes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  package_id    INTEGER REFERENCES packages(id),
  name          TEXT    NOT NULL,
  qualified_name TEXT   NOT NULL UNIQUE,
  kind          TEXT    NOT NULL CHECK(kind IN ('class','interface','enum','annotation','xtend_class')),
  is_abstract   INTEGER NOT NULL DEFAULT 0,
  superclass    TEXT,                           -- qualified name
  interfaces    TEXT,                           -- JSON array of qualified names
  annotations   TEXT,                           -- JSON array
  javadoc       TEXT,
  line_start    INTEGER,
  line_end      INTEGER,
  asil_level    TEXT    DEFAULT NULL            -- detected from @ASIL annotation or comment
);

-- ---- METHODS ----
CREATE TABLE IF NOT EXISTS methods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id        INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  signature       TEXT    NOT NULL,             -- name(ParamType,...):ReturnType
  return_type     TEXT,
  visibility      TEXT    NOT NULL DEFAULT 'package', -- public|protected|private|package
  is_static       INTEGER NOT NULL DEFAULT 0,
  is_abstract     INTEGER NOT NULL DEFAULT 0,
  is_override     INTEGER NOT NULL DEFAULT 0,
  annotations     TEXT,                         -- JSON array
  parameters      TEXT,                         -- JSON array [{name,type,annotations}]
  throws_list     TEXT,                         -- JSON array of exception types
  javadoc         TEXT,
  line_start      INTEGER,
  line_end        INTEGER,
  cyclomatic_complexity INTEGER DEFAULT 1,
  -- MC/DC fields
  boolean_conditions TEXT,                      -- JSON array of conditions found
  branch_count    INTEGER DEFAULT 0,
  condition_count INTEGER DEFAULT 0
);

-- ---- CFG NODES ----
-- Control Flow Graph nodes per method
CREATE TABLE IF NOT EXISTS cfg_nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id   INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
  node_type   TEXT    NOT NULL,                 -- ENTRY|EXIT|STATEMENT|BRANCH|LOOP|SWITCH|TRY|CATCH|THROW|RETURN
  label       TEXT,                             -- short description / expression text
  line        INTEGER,
  condition   TEXT,                             -- boolean expression for BRANCH/LOOP nodes
  order_idx   INTEGER NOT NULL DEFAULT 0       -- ordering within method
);

-- ---- CFG EDGES ----
CREATE TABLE IF NOT EXISTS cfg_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id   INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
  from_node   INTEGER NOT NULL REFERENCES cfg_nodes(id) ON DELETE CASCADE,
  to_node     INTEGER NOT NULL REFERENCES cfg_nodes(id) ON DELETE CASCADE,
  edge_type   TEXT    NOT NULL DEFAULT 'sequential', -- sequential|true_branch|false_branch|exception|loop_back
  condition   TEXT
);

-- ---- CALL GRAPH ----
CREATE TABLE IF NOT EXISTS call_edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id     INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
  callee_name   TEXT    NOT NULL,               -- qualified name if resolvable
  callee_id     INTEGER REFERENCES methods(id), -- NULL if external / unresolved
  call_type     TEXT    NOT NULL DEFAULT 'method', -- method|constructor|super|static
  line          INTEGER
);

-- ---- FIELDS ----
CREATE TABLE IF NOT EXISTS fields (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  visibility  TEXT    NOT NULL DEFAULT 'private',
  is_static   INTEGER NOT NULL DEFAULT 0,
  is_final    INTEGER NOT NULL DEFAULT 0,
  annotations TEXT,
  initial_value TEXT,
  line        INTEGER
);

-- ---- DEPENDENCIES ----
-- import-level and type-level dependencies between files
CREATE TABLE IF NOT EXISTS dependencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  to_qualified  TEXT    NOT NULL,               -- imported type
  to_file_id    INTEGER REFERENCES files(id),  -- NULL if external (JDK, lib)
  dep_type      TEXT    NOT NULL DEFAULT 'import' -- import|extends|implements|uses
);

-- ---- DECISIONS ----
-- Each branch point (if, while, for, do, switch, ternary) is a decision
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id     INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
  decision_uid  TEXT    NOT NULL,               -- D-{methodId}-{seq}
  kind          TEXT    NOT NULL,               -- if|while|for|do|switch|ternary|return|assignment
  expression    TEXT,                           -- full boolean expression
  normalized    TEXT,                           -- normalized form (C1 && C2, etc.)
  operator      TEXT,                           -- AND|OR|MIXED|null
  line_start    INTEGER,
  line_end      INTEGER,
  branch_count  INTEGER DEFAULT 2,
  mcdc_required INTEGER DEFAULT 0,              -- true if >=2 atomic conditions
  parse_status  TEXT    DEFAULT 'ok'
);

-- ---- CONDITIONS ----
-- Atomic boolean conditions decomposed from decisions
CREATE TABLE IF NOT EXISTS conditions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id     INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  condition_uid   TEXT    NOT NULL,              -- C-{decisionId}-{position}
  text            TEXT    NOT NULL,              -- atomic condition as in source
  normalized_text TEXT,                          -- normalized form (trimmed, ! stripped)
  position        INTEGER,                       -- ordinal position in decision
  condition_type  TEXT    DEFAULT 'atomic',      -- atomic|negated|compound
  parse_status    TEXT    DEFAULT 'ok'
);

-- ---- MCDC CONDITIONS ----
-- Expanded MC/DC condition table for ASIL-D analysis
CREATE TABLE IF NOT EXISTS mcdc_conditions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id     INTEGER NOT NULL REFERENCES methods(id) ON DELETE CASCADE,
  decision_id   INTEGER REFERENCES decisions(id),
  cfg_node_id   INTEGER REFERENCES cfg_nodes(id),
  expression    TEXT    NOT NULL,               -- full boolean expression
  sub_conditions TEXT   NOT NULL,               -- JSON array of atomic sub-conditions
  truth_table   TEXT,                           -- JSON: all combinations
  mcdc_pairs    TEXT,                           -- JSON: pairs that independently affect outcome
  line          INTEGER
);

-- ---- PARSE ERRORS ----
CREATE TABLE IF NOT EXISTS parse_errors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id   INTEGER REFERENCES files(id) ON DELETE CASCADE,
  path      TEXT    NOT NULL,
  error     TEXT    NOT NULL,
  at_line   INTEGER,
  logged_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---- INDEXES ----
CREATE INDEX IF NOT EXISTS idx_methods_class   ON methods(class_id);
CREATE INDEX IF NOT EXISTS idx_methods_file    ON methods(file_id);
CREATE INDEX IF NOT EXISTS idx_cfg_method      ON cfg_nodes(method_id);
CREATE INDEX IF NOT EXISTS idx_edges_method    ON cfg_edges(method_id);
CREATE INDEX IF NOT EXISTS idx_call_caller     ON call_edges(caller_id);
CREATE INDEX IF NOT EXISTS idx_call_callee     ON call_edges(callee_id);
CREATE INDEX IF NOT EXISTS idx_files_sha       ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_class_qualified ON classes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_fields_class    ON fields(class_id);
