// src/db/database.js
// SQLite database manager for codeparse-mcp graph store

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class GraphDatabase {
  /** @type {Database.Database} */
  db = null;

  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  // ── Lifecycle ────────────────────────────────────────────

  open() {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this._applySchema();
    return this;
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }

  _applySchema() {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(sql);

    // Schema migration: check current version
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      const version = parseInt(row?.value ?? '1', 10);
      if (version < 2) {
        this.transaction(() => {
          // v1 → v2: add decision_id column to mcdc_conditions (if not exists)
          try {
            this.db.exec("ALTER TABLE mcdc_conditions ADD COLUMN decision_id INTEGER REFERENCES decisions(id)");
          } catch (_) { /* column may already exist */ }

          this.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
        });
        process.stderr.write('[codeparse-mcp] Schema migrated v1 → v2 (decisions/conditions)\n');
      }
      // v2 → v3: add evidence tables
      if (version < 3) {
        this.transaction(() => {
          // Re-apply full schema to pick up new tables (CREATE IF NOT EXISTS is idempotent)
          this.db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
          this.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
        });
        process.stderr.write('[codeparse-mcp] Schema migrated v2 → v3 (evidence tables)\n');
      }
    } catch (_) {
      // Meta table may not exist yet on fresh schema — no migration needed
    }
  }

  // ── Transactions ─────────────────────────────────────────

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  // ── File tracking ────────────────────────────────────────

  upsertFile({ path, absPath, lang, sha256, lineCount }) {
    const existing = this.db.prepare(
      'SELECT id, sha256 FROM files WHERE path = ?'
    ).get(path);

    if (existing) {
      if (existing.sha256 === sha256) return { id: existing.id, changed: false };
      // File changed — cascade delete children via FK
      this.db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
    }

    const result = this.db.prepare(`
      INSERT INTO files (path, abs_path, lang, sha256, line_count, parsed_at)
      VALUES (@path, @absPath, @lang, @sha256, @lineCount, datetime('now'))
    `).run({ path, absPath: absPath, lang, sha256, lineCount });

    return { id: result.lastInsertRowid, changed: true };
  }

  getFile(path) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path);
  }

  getAllFiles() {
    return this.db.prepare('SELECT * FROM files ORDER BY path').all();
  }

  markFileError(path, error) {
    this.db.prepare(`
      INSERT OR REPLACE INTO parse_errors (path, error, logged_at)
      VALUES (?, ?, datetime('now'))
    `).run(path, error);
    this.db.prepare(
      "UPDATE files SET status = 'error' WHERE path = ?"
    ).run(path);
  }

  // ── Package ──────────────────────────────────────────────

  upsertPackage(name) {
    const existing = this.db.prepare('SELECT id FROM packages WHERE name = ?').get(name);
    if (existing) return existing.id;
    return this.db.prepare('INSERT INTO packages (name) VALUES (?)').run(name).lastInsertRowid;
  }

  // ── Class ────────────────────────────────────────────────

  insertClass(cls) {
    const packageId = cls.packageName ? this.upsertPackage(cls.packageName) : null;
    return this.db.prepare(`
      INSERT INTO classes
        (file_id, package_id, name, qualified_name, kind, is_abstract,
         superclass, interfaces, annotations, javadoc, line_start, line_end, asil_level)
      VALUES
        (@fileId, @packageId, @name, @qualifiedName, @kind, @isAbstract,
         @superclass, @interfaces, @annotations, @javadoc, @lineStart, @lineEnd, @asilLevel)
    `).run({
      fileId: cls.fileId,
      packageId,
      name: cls.name,
      qualifiedName: cls.qualifiedName,
      kind: cls.kind ?? 'class',
      isAbstract: cls.isAbstract ? 1 : 0,
      superclass: cls.superclass ?? null,
      interfaces: JSON.stringify(cls.interfaces ?? []),
      annotations: JSON.stringify(cls.annotations ?? []),
      javadoc: cls.javadoc ?? null,
      lineStart: cls.lineStart ?? null,
      lineEnd: cls.lineEnd ?? null,
      asilLevel: cls.asilLevel ?? null,
    }).lastInsertRowid;
  }

  // ── Method ───────────────────────────────────────────────

  insertMethod(method) {
    return this.db.prepare(`
      INSERT INTO methods
        (class_id, file_id, name, signature, return_type, visibility,
         is_static, is_abstract, is_override, annotations, parameters,
         throws_list, javadoc, line_start, line_end, cyclomatic_complexity,
         boolean_conditions, branch_count, condition_count)
      VALUES
        (@classId, @fileId, @name, @signature, @returnType, @visibility,
         @isStatic, @isAbstract, @isOverride, @annotations, @parameters,
         @throwsList, @javadoc, @lineStart, @lineEnd, @cyclomaticComplexity,
         @booleanConditions, @branchCount, @conditionCount)
    `).run({
      classId: method.classId,
      fileId: method.fileId,
      name: method.name,
      signature: method.signature,
      returnType: method.returnType ?? 'void',
      visibility: method.visibility ?? 'package',
      isStatic: method.isStatic ? 1 : 0,
      isAbstract: method.isAbstract ? 1 : 0,
      isOverride: method.isOverride ? 1 : 0,
      annotations: JSON.stringify(method.annotations ?? []),
      parameters: JSON.stringify(method.parameters ?? []),
      throwsList: JSON.stringify(method.throwsList ?? []),
      javadoc: method.javadoc ?? null,
      lineStart: method.lineStart ?? null,
      lineEnd: method.lineEnd ?? null,
      cyclomaticComplexity: method.cyclomaticComplexity ?? 1,
      booleanConditions: JSON.stringify(method.booleanConditions ?? []),
      branchCount: method.branchCount ?? 0,
      conditionCount: method.conditionCount ?? 0,
    }).lastInsertRowid;
  }

  // ── CFG ──────────────────────────────────────────────────

  insertCfgNode(node) {
    return this.db.prepare(`
      INSERT INTO cfg_nodes (method_id, node_type, label, line, condition, order_idx)
      VALUES (@methodId, @nodeType, @label, @line, @condition, @orderIdx)
    `).run({
      methodId: node.methodId,
      nodeType: node.nodeType,
      label: node.label ?? null,
      line: node.line ?? null,
      condition: node.condition ?? null,
      orderIdx: node.orderIdx ?? 0,
    }).lastInsertRowid;
  }

  insertCfgEdge(edge) {
    return this.db.prepare(`
      INSERT INTO cfg_edges (method_id, from_node, to_node, edge_type, condition)
      VALUES (@methodId, @fromNode, @toNode, @edgeType, @condition)
    `).run({
      methodId: edge.methodId,
      fromNode: edge.fromNode,
      toNode: edge.toNode,
      edgeType: edge.edgeType ?? 'sequential',
      condition: edge.condition ?? null,
    }).lastInsertRowid;
  }

  // ── Call graph ───────────────────────────────────────────

  insertCallEdge(edge) {
    return this.db.prepare(`
      INSERT INTO call_edges (caller_id, callee_name, callee_id, call_type, line)
      VALUES (@callerId, @calleeName, @calleeId, @callType, @line)
    `).run({
      callerId: edge.callerId,
      calleeName: edge.calleeName,
      calleeId: edge.calleeId ?? null,
      callType: edge.callType ?? 'method',
      line: edge.line ?? null,
    }).lastInsertRowid;
  }

  // ── Fields ───────────────────────────────────────────────

  insertField(field) {
    return this.db.prepare(`
      INSERT INTO fields
        (class_id, name, type, visibility, is_static, is_final, annotations, initial_value, line)
      VALUES
        (@classId, @name, @type, @visibility, @isStatic, @isFinal, @annotations, @initialValue, @line)
    `).run({
      classId: field.classId,
      name: field.name,
      type: field.type,
      visibility: field.visibility ?? 'private',
      isStatic: field.isStatic ? 1 : 0,
      isFinal: field.isFinal ? 1 : 0,
      annotations: JSON.stringify(field.annotations ?? []),
      initialValue: field.initialValue ?? null,
      line: field.line ?? null,
    }).lastInsertRowid;
  }

  // ── Decisions / Conditions ──────────────────────────────

  insertDecision(dec) {
    return this.db.prepare(`
      INSERT INTO decisions
        (method_id, decision_uid, kind, expression, normalized, operator,
         line_start, branch_count, mcdc_required, parse_status)
      VALUES
        (@methodId, @decisionUid, @kind, @expression, @normalized, @operator,
         @lineStart, @branchCount, @mcdcRequired, @parseStatus)
    `).run({
      methodId: dec.methodId,
      decisionUid: dec.decisionUid,
      kind: dec.kind,
      expression: dec.expression ?? null,
      normalized: dec.normalized ?? null,
      operator: dec.operator ?? null,
      lineStart: dec.lineStart ?? null,
      branchCount: dec.branchCount ?? 2,
      mcdcRequired: dec.mcdcRequired ? 1 : 0,
      parseStatus: dec.parseStatus ?? 'ok',
    }).lastInsertRowid;
  }

  insertCondition(cond) {
    return this.db.prepare(`
      INSERT INTO conditions
        (decision_id, condition_uid, text, normalized_text, position, condition_type, parse_status)
      VALUES
        (@decisionId, @conditionUid, @text, @normalizedText, @position, @conditionType, @parseStatus)
    `).run({
      decisionId: cond.decisionId,
      conditionUid: cond.conditionUid,
      text: cond.text ?? '',
      normalizedText: cond.normalizedText ?? null,
      position: cond.position ?? 1,
      conditionType: cond.conditionType ?? 'atomic',
      parseStatus: cond.parseStatus ?? 'ok',
    }).lastInsertRowid;
  }

  getDecisionsForMethod(methodId) {
    const decisions = this.db.prepare(
      'SELECT * FROM decisions WHERE method_id = ? ORDER BY id'
    ).all(methodId);

    for (const d of decisions) {
      d.conditions = this.db.prepare(
        'SELECT * FROM conditions WHERE decision_id = ? ORDER BY position'
      ).all(d.id);
    }
    return decisions;
  }

  getDecisionCountForMethod(methodId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM decisions WHERE method_id = ?'
    ).get(methodId);
    return row?.n ?? 0;
  }

  // ── MC/DC conditions ─────────────────────────────────────

  // ── MC/DC Pairs (normalized) ──────────────────────────────

  insertMcdcPair(pair) {
    return this.db.prepare(`
      INSERT INTO mcdc_pairs
        (decision_id, condition_id, pair_uid, test_vector_a_json, test_vector_b_json,
         outcome_a, outcome_b, independence_status, review_status, reviewer, reviewed_at, notes)
      VALUES
        (@decisionId, @conditionId, @pairUid, @testVectorAJson, @testVectorBJson,
         @outcomeA, @outcomeB, @independenceStatus, @reviewStatus, @reviewer, @reviewedAt, @notes)
    `).run({
      decisionId: pair.decisionId,
      conditionId: pair.conditionId,
      pairUid: pair.pairUid,
      testVectorAJson: JSON.stringify(pair.testVectorA),
      testVectorBJson: JSON.stringify(pair.testVectorB),
      outcomeA: pair.outcomeA,
      outcomeB: pair.outcomeB,
      independenceStatus: pair.independenceStatus ?? "draft",
      reviewStatus: pair.reviewStatus ?? "draft",
      reviewer: pair.reviewer ?? null,
      reviewedAt: pair.reviewedAt ?? null,
      notes: pair.notes ?? null,
    }).lastInsertRowid;
  }

  insertMcdcCondition(cond) {
    return this.db.prepare(`
      INSERT INTO mcdc_conditions
        (method_id, decision_id, cfg_node_id, expression, sub_conditions, truth_table, mcdc_pairs, line)
      VALUES
        (@methodId, @decisionId, @cfgNodeId, @expression, @subConditions, @truthTable, @mcdcPairs, @line)
    `).run({
      methodId: cond.methodId,
      decisionId: cond.decisionId ?? null,
      cfgNodeId: cond.cfgNodeId ?? null,
      expression: cond.expression,
      subConditions: JSON.stringify(cond.subConditions ?? []),
      truthTable: cond.truthTable ? JSON.stringify(cond.truthTable) : null,
      mcdcPairs: cond.mcdcPairs ? JSON.stringify(cond.mcdcPairs) : null,
      line: cond.line ?? null,
    }).lastInsertRowid;
  }

  getMcdcPairsForDecision(decisionId) {
    const rows = this.db.prepare(
      'SELECT * FROM mcdc_pairs WHERE decision_id = ? ORDER BY id'
    ).all(decisionId);
    return rows.map(r => ({
      ...r,
      testVectorA: JSON.parse(r.test_vector_a_json),
      testVectorB: JSON.parse(r.test_vector_b_json),
    }));
  }

  getMcdcPairsForMethod(methodId) {
    return this.db.prepare(`
      SELECT p.*
      FROM mcdc_pairs p
      JOIN decisions d ON d.id = p.decision_id
      WHERE d.method_id = ?
      ORDER BY p.decision_id, p.id
    `).all(methodId).map(r => ({
      ...r,
      testVectorA: JSON.parse(r.test_vector_a_json),
      testVectorB: JSON.parse(r.test_vector_b_json),
    }));
  }

  // ── Test Cases / Results ─────────────────────────────────

  upsertTestCase(testCase) {
    const existing = this.db.prepare(
      "SELECT id FROM test_cases WHERE test_class = ? AND test_method = ?"
    ).get(testCase.testClass, testCase.testMethod);
    if (existing) {
      this.db.prepare(`
        UPDATE test_cases SET target_class_id=?, target_method_id=?, objective=?, status=?
        WHERE id=?
      `).run(
        testCase.targetClassId ?? null,
        testCase.targetMethodId ?? null,
        testCase.objective ?? null,
        testCase.status ?? 'draft',
        existing.id
      );
      return existing.id;
    }
    return this.db.prepare(`
      INSERT INTO test_cases (test_class, test_method, target_class_id, target_method_id, objective, status)
      VALUES (@testClass, @testMethod, @targetClassId, @targetMethodId, @objective, @status)
    `).run({
      testClass: testCase.testClass,
      testMethod: testCase.testMethod,
      targetClassId: testCase.targetClassId ?? null,
      targetMethodId: testCase.targetMethodId ?? null,
      objective: testCase.objective ?? null,
      status: testCase.status ?? 'draft',
    }).lastInsertRowid;
  }

  insertTestResult(result) {
    return this.db.prepare(`
      INSERT INTO test_results (test_case_id, test_class, test_method, result, duration_ms, report_file, failure_message, stack_trace)
      VALUES (@testCaseId, @testClass, @testMethod, @result, @durationMs, @reportFile, @failureMessage, @stackTrace)
    `).run({
      testCaseId: result.testCaseId ?? null,
      testClass: result.testClass,
      testMethod: result.testMethod,
      result: result.result,
      durationMs: result.durationMs ?? null,
      reportFile: result.reportFile ?? null,
      failureMessage: result.failureMessage ?? null,
      stackTrace: result.stackTrace ?? null,
    }).lastInsertRowid;
  }

  getTestResultsForMethod(methodId) {
    return this.db.prepare(`
      SELECT tr.* FROM test_results tr
      JOIN test_cases tc ON tc.id = tr.test_case_id
      WHERE tc.target_method_id = ?
      ORDER BY tr.executed_at DESC
    `).all(methodId);
  }

  getTestResultsForClass(classId) {
    return this.db.prepare(`
      SELECT tr.* FROM test_results tr
      JOIN test_cases tc ON tc.id = tr.test_case_id
      WHERE tc.target_class_id = ?
      ORDER BY tr.executed_at DESC
    `).all(classId);
  }

  // ── Coverage Records ─────────────────────────────────────

  upsertCoverageRecord(record) {
    const existing = this.db.prepare(
      "SELECT id FROM coverage_records WHERE method_id = ? AND source = ?"
    ).get(record.methodId, record.source ?? 'jacoco');
    if (existing) {
      this.db.prepare(`
        UPDATE coverage_records SET
          line_coverage=?, branch_coverage=?, instruction_coverage=?,
          complexity_coverage=?, missed_lines=?, covered_lines=?,
          missed_branches=?, covered_branches=?, imported_at=datetime('now')
        WHERE id=?
      `).run(
        record.lineCoverage, record.branchCoverage, record.instructionCoverage,
        record.complexityCoverage, record.missedLines, record.coveredLines,
        record.missedBranches, record.coveredBranches, existing.id
      );
      return existing.id;
    }
    return this.db.prepare(`
      INSERT INTO coverage_records
        (file_id, method_id, class_name, method_name,
         line_coverage, branch_coverage, instruction_coverage, complexity_coverage,
         missed_lines, covered_lines, missed_branches, covered_branches, source)
      VALUES
        (@fileId, @methodId, @className, @methodName,
         @lineCoverage, @branchCoverage, @instructionCoverage, @complexityCoverage,
         @missedLines, @coveredLines, @missedBranches, @coveredBranches, @source)
    `).run({
      fileId: record.fileId ?? null,
      methodId: record.methodId ?? null,
      className: record.className,
      methodName: record.methodName ?? null,
      lineCoverage: record.lineCoverage ?? 0,
      branchCoverage: record.branchCoverage ?? 0,
      instructionCoverage: record.instructionCoverage ?? 0,
      complexityCoverage: record.complexityCoverage ?? 0,
      missedLines: record.missedLines ?? 0,
      coveredLines: record.coveredLines ?? 0,
      missedBranches: record.missedBranches ?? 0,
      coveredBranches: record.coveredBranches ?? 0,
      source: record.source ?? 'jacoco',
    }).lastInsertRowid;
  }

  getCoverageForMethod(methodId) {
    return this.db.prepare(
      'SELECT * FROM coverage_records WHERE method_id = ? ORDER BY imported_at DESC LIMIT 1'
    ).get(methodId);
  }

  getCoverageForClass(classId) {
    return this.db.prepare(`
      SELECT cr.*
      FROM coverage_records cr
      JOIN methods m ON m.id = cr.method_id
      WHERE m.class_id = ?
      ORDER BY cr.class_name, cr.method_name
    `).all(classId);
  }

  // ── Evidence Log ─────────────────────────────────────────

  insertEvidenceLog(entry) {
    return this.db.prepare(`
      INSERT INTO evidence_log (target_class, asil_level, output_path, files_generated, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      entry.targetClass, entry.asilLevel, entry.outputPath,
      entry.filesGenerated ?? 0, entry.status ?? 'generated'
    ).lastInsertRowid;
  }

  // ── Dependencies ─────────────────────────────────────────

  insertDependency({ fromFileId, toQualified, toFileId, depType }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO dependencies (from_file_id, to_qualified, to_file_id, dep_type)
      VALUES (?, ?, ?, ?)
    `).run(fromFileId, toQualified, toFileId ?? null, depType ?? 'import');
  }

  // ── Queries for MCP tools ────────────────────────────────

  getClassByQualifiedName(qname) {
    const cls = this.db.prepare('SELECT * FROM classes WHERE qualified_name = ?').get(qname);
    if (!cls) return null;
    cls.interfaces = JSON.parse(cls.interfaces ?? '[]');
    cls.annotations = JSON.parse(cls.annotations ?? '[]');
    return cls;
  }

  getMethodsForClass(classId) {
    const rows = this.db.prepare(`
      SELECT m.*,
             f.path AS _file_path,
             f.lang AS _file_lang
      FROM methods m
      JOIN files f ON f.id = m.file_id
      WHERE m.class_id = ?
    `).all(classId);

    return rows.map(m => ({
      id: m.id,
      class_id: m.class_id,
      file_id: m.file_id,
      name: m.name,
      signature: m.signature,
      return_type: m.return_type,
      visibility: m.visibility,
      is_static: !!m.is_static,
      is_abstract: !!m.is_abstract,
      is_override: !!m.is_override,
      annotations: JSON.parse(m.annotations ?? '[]'),
      parameters: JSON.parse(m.parameters ?? '[]'),
      throws_list: JSON.parse(m.throws_list ?? '[]'),
      javadoc: m.javadoc,
      line_start: m.line_start,
      line_end: m.line_end,
      asil_level: m.asil_level,
      cyclomatic_complexity: m.cyclomatic_complexity,
      boolean_conditions: JSON.parse(m.boolean_conditions ?? '[]'),
      branch_count: m.branch_count,
      condition_count: m.condition_count,
      decision_count: this.getDecisionCountForMethod(m.id),
      file: {
        id: m.file_id,
        path: m._file_path,
        language: m._file_lang,
      },
    }));
  }

  getCfgForMethod(methodId) {
    const nodes = this.db.prepare('SELECT * FROM cfg_nodes WHERE method_id = ? ORDER BY order_idx').all(methodId);
    const edges = this.db.prepare('SELECT * FROM cfg_edges WHERE method_id = ?').all(methodId);
    return { nodes, edges };
  }

  getMcdcForMethod(methodId) {
    return this.db.prepare('SELECT * FROM mcdc_conditions WHERE method_id = ?').all(methodId)
      .map(c => ({
        ...c,
        subConditions: JSON.parse(c.sub_conditions ?? '[]'),
        truthTable: c.truth_table ? JSON.parse(c.truth_table) : null,
        mcdcPairs: c.mcdc_pairs ? JSON.parse(c.mcdc_pairs) : null,
      }));
  }

  getCallees(methodId) {
    return this.db.prepare(`
      SELECT ce.*, m.signature, c.qualified_name
      FROM call_edges ce
      LEFT JOIN methods m ON m.id = ce.callee_id
      LEFT JOIN classes c ON c.id = m.class_id
      WHERE ce.caller_id = ?
    `).all(methodId);
  }

  searchClasses(pattern) {
    return this.db.prepare(
      "SELECT * FROM classes WHERE qualified_name LIKE ? OR name LIKE ? LIMIT 50"
    ).all(`%${pattern}%`, `%${pattern}%`);
  }

  searchMethods(pattern) {
    const rows = this.db.prepare(`
      SELECT m.*,
             c.qualified_name AS class_qname,
             f.path AS _file_path,
             f.lang AS _file_lang
      FROM methods m
      JOIN classes c ON c.id = m.class_id
      JOIN files f ON f.id = m.file_id
      WHERE m.name LIKE ? OR m.signature LIKE ?
      LIMIT 50
    `).all(`%${pattern}%`, `%${pattern}%`);

    return rows.map(m => ({
      id: m.id,
      class_id: m.class_id,
      file_id: m.file_id,
      name: m.name,
      signature: m.signature,
      return_type: m.return_type,
      visibility: m.visibility,
      is_static: !!m.is_static,
      is_abstract: !!m.is_abstract,
      is_override: !!m.is_override,
      annotations: JSON.parse(m.annotations ?? '[]'),
      parameters: JSON.parse(m.parameters ?? '[]'),
      throws_list: JSON.parse(m.throws_list ?? '[]'),
      javadoc: m.javadoc,
      line_start: m.line_start,
      line_end: m.line_end,
      cyclomatic_complexity: m.cyclomatic_complexity,
      boolean_conditions: JSON.parse(m.boolean_conditions ?? '[]'),
      branch_count: m.branch_count,
      condition_count: m.condition_count,
      class_qualified_name: m.class_qname,
      decision_count: this.getDecisionCountForMethod(m.id),
      file: {
        id: m.file_id,
        path: m._file_path,
        language: m._file_lang,
      },
    }));
  }

  // ── Statistics ───────────────────────────────────────────

  getStats() {
    const s = (sql) => this.db.prepare(sql).get();
    return {
      files: s("SELECT COUNT(*) as n, SUM(line_count) as lines FROM files WHERE status = 'ok'"),
      classes: s('SELECT COUNT(*) as n FROM classes'),
      methods: s('SELECT COUNT(*) as n, AVG(cyclomatic_complexity) as avg_cc, SUM(branch_count) as total_branches FROM methods'),
      cfg_nodes: s('SELECT COUNT(*) as n FROM cfg_nodes'),
      cfg_edges: s('SELECT COUNT(*) as n FROM cfg_edges'),
      mcdc: s('SELECT COUNT(*) as n FROM mcdc_conditions'),
      errors: s('SELECT COUNT(*) as n FROM parse_errors'),
      call_edges: s('SELECT COUNT(*) as n FROM call_edges'),
      mcdc_pairs: s('SELECT COUNT(*) as n FROM mcdc_pairs'),
      test_cases: s('SELECT COUNT(*) as n FROM test_cases'),
      test_results: s('SELECT COUNT(*) as n FROM test_results'),
      coverage_records: s('SELECT COUNT(*) as n FROM coverage_records'),
      evidence_log: s('SELECT COUNT(*) as n FROM evidence_log'),
    };
  }

  resolveCalleeIds() {
    // Second-pass: link callee_name → callee_id where resolvable
    const unresolved = this.db.prepare(
      'SELECT id, callee_name FROM call_edges WHERE callee_id IS NULL'
    ).all();
    const findMethod = this.db.prepare(
      "SELECT m.id FROM methods m JOIN classes c ON c.id = m.class_id WHERE c.qualified_name || '.' || m.name = ?"
    );
    const update = this.db.prepare('UPDATE call_edges SET callee_id = ? WHERE id = ?');
    let resolved = 0;
    for (const row of unresolved) {
      const m = findMethod.get(row.callee_name);
      if (m) { update.run(m.id, row.id); resolved++; }
    }
    return resolved;
  }
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
