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

  // ── MC/DC conditions ─────────────────────────────────────

  insertMcdcCondition(cond) {
    return this.db.prepare(`
      INSERT INTO mcdc_conditions
        (method_id, cfg_node_id, expression, sub_conditions, truth_table, mcdc_pairs, line)
      VALUES
        (@methodId, @cfgNodeId, @expression, @subConditions, @truthTable, @mcdcPairs, @line)
    `).run({
      methodId: cond.methodId,
      cfgNodeId: cond.cfgNodeId ?? null,
      expression: cond.expression,
      subConditions: JSON.stringify(cond.subConditions ?? []),
      truthTable: cond.truthTable ? JSON.stringify(cond.truthTable) : null,
      mcdcPairs: cond.mcdcPairs ? JSON.stringify(cond.mcdcPairs) : null,
      line: cond.line ?? null,
    }).lastInsertRowid;
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
    return this.db.prepare('SELECT * FROM methods WHERE class_id = ?').all(classId)
      .map(m => ({
        ...m,
        annotations: JSON.parse(m.annotations ?? '[]'),
        parameters: JSON.parse(m.parameters ?? '[]'),
        throwsList: JSON.parse(m.throws_list ?? '[]'),
        booleanConditions: JSON.parse(m.boolean_conditions ?? '[]'),
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
    return this.db.prepare(
      "SELECT m.*, c.qualified_name as class_qname FROM methods m JOIN classes c ON c.id = m.class_id WHERE m.name LIKE ? OR m.signature LIKE ? LIMIT 50"
    ).all(`%${pattern}%`, `%${pattern}%`);
  }

  // ── Statistics ───────────────────────────────────────────

  getStats() {
    const s = (sql) => this.db.prepare(sql).get();
    return {
      files: s('SELECT COUNT(*) as n, SUM(line_count) as lines FROM files WHERE status="ok"'),
      classes: s('SELECT COUNT(*) as n FROM classes'),
      methods: s('SELECT COUNT(*) as n, AVG(cyclomatic_complexity) as avg_cc, SUM(branch_count) as total_branches FROM methods'),
      cfg_nodes: s('SELECT COUNT(*) as n FROM cfg_nodes'),
      cfg_edges: s('SELECT COUNT(*) as n FROM cfg_edges'),
      mcdc: s('SELECT COUNT(*) as n FROM mcdc_conditions'),
      errors: s('SELECT COUNT(*) as n FROM parse_errors'),
      call_edges: s('SELECT COUNT(*) as n FROM call_edges'),
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
