// src/graph/builder.js
// Orchestrates parsing and writing graph data to SQLite

import { readFileSync, existsSync } from 'fs';
import { relative, extname, resolve } from 'path';
import { globSync } from 'glob';
import { GraphDatabase, sha256 } from '../db/database.js';
import { parseJava } from '../parser/java-parser.js';
import { parseXtend } from '../parser/xtend-parser.js';

export class GraphBuilder {
  /**
   * @param {GraphDatabase} db
   * @param {string} projectRoot - absolute path to project root
   */
  constructor(db, projectRoot) {
    this.db = db;
    this.projectRoot = resolve(projectRoot);
  }

  // ── Full sync ─────────────────────────────────────────────────────────────

  /**
   * Scan all Java/Xtend files, parse changed files, persist to DB.
   * Returns a report object.
   */
  async syncProject(options = {}) {
    const {
      include = ['**/*.java', '**/*.xtend'],
      exclude = ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**'],
      force = false,
      onProgress = null,
    } = options;

    const report = {
      scanned: 0,
      skipped: 0,
      parsed: 0,
      errors: 0,
      classes: 0,
      methods: 0,
      start: Date.now(),
    };

    // Collect source files
    const files = [];
    for (const pattern of include) {
      const matches = globSync(pattern, {
        cwd: this.projectRoot,
        ignore: exclude,
        absolute: true,
      });
      files.push(...matches);
    }

    report.scanned = files.length;

    // Parse each file in a single transaction per file
    for (let i = 0; i < files.length; i++) {
      const absPath = files[i];
      const relPath = relative(this.projectRoot, absPath);

      if (onProgress) onProgress({ i, total: files.length, path: relPath });

      try {
        const content = readFileSync(absPath, 'utf8');
        const hash = sha256(content);

        // Check if unchanged
        const existing = this.db.getFile(relPath);
        if (!force && existing?.sha256 === hash) {
          report.skipped++;
          continue;
        }

        const lang = extname(absPath).slice(1); // 'java' or 'xtend'
        const lineCount = content.split('\n').length;

        // Parse
        let parsed;
        if (lang === 'java') {
          parsed = parseJava(content, relPath);
        } else if (lang === 'xtend') {
          parsed = parseXtend(content, relPath);
        } else {
          report.skipped++;
          continue;
        }

        // Persist in a transaction
        this.db.transaction(() => {
          const { id: fileId } = this.db.upsertFile({
            path: relPath,
            absPath,
            lang,
            sha256: hash,
            lineCount,
          });

          // Record any parse errors
          for (const err of parsed.errors) {
            this.db.markFileError(relPath, err.message);
            report.errors++;
          }

          // Persist imports as dependencies
          for (const imp of parsed.imports) {
            this.db.insertDependency({
              fromFileId: fileId,
              toQualified: imp.name,
              toFileId: null,
              depType: 'import',
            });
          }

          // Persist classes
          for (const cls of parsed.classes) {
            const classId = this.db.insertClass({
              ...cls,
              fileId,
              packageName: parsed.packageName,
            });
            report.classes++;

            // Fields
            for (const field of cls.fields ?? []) {
              this.db.insertField({ ...field, classId });
            }

            // Methods
            for (const method of cls.methods ?? []) {
              const methodId = this.db.insertMethod({
                ...method,
                classId,
                fileId,
              });
              report.methods++;

              // CFG nodes
              const nodeIdMap = new Map(); // local id → DB id
              for (const node of method.cfgNodes ?? []) {
                const dbId = this.db.insertCfgNode({ ...node, methodId });
                nodeIdMap.set(node.id, dbId);
              }

              // CFG edges (remap node ids)
              for (const edge of method.cfgEdges ?? []) {
                const fromId = nodeIdMap.get(edge.fromNode);
                const toId = nodeIdMap.get(edge.toNode);
                if (fromId && toId) {
                  this.db.insertCfgEdge({
                    methodId,
                    fromNode: fromId,
                    toNode: toId,
                    edgeType: edge.edgeType,
                    condition: edge.condition,
                  });
                }
              }

              // Call sites
              for (const call of method.callSites ?? []) {
                this.db.insertCallEdge({
                  callerId: methodId,
                  calleeName: call.calleeName,
                  calleeId: null,
                  callType: 'method',
                  line: call.line,
                });
              }

              // Decisions and atomic conditions
              for (const dec of method.decisions ?? []) {
                const seq = method.decisions.indexOf(dec) + 1;
                const decisionUid = `D-${String(methodId).padStart(4, '0')}-${String(seq).padStart(3, '0')}`;
                const decisionId = this.db.insertDecision({
                  methodId,
                  decisionUid,
                  kind: dec.kind,
                  expression: dec.expression,
                  normalized: dec.normalized,
                  operator: dec.operator,
                  lineStart: dec.line_start,
                  branchCount: dec.branch_count,
                  mcdcRequired: dec.mcdc_required ? 1 : 0,
                  parseStatus: dec.parse_status ?? 'ok',
                });

                for (const cond of dec.conditions ?? []) {
                  const condUid = `C-${String(decisionId)}-${String(cond.position)}`;
                  this.db.insertCondition({
                    decisionId,
                    conditionUid: condUid,
                    text: cond.text ?? '',
                    normalizedText: cond.normalized ?? null,
                    position: cond.position ?? 1,
                    conditionType: cond.condition_type ?? 'atomic',
                    parseStatus: cond.parse_status ?? 'ok',
                  });
                }
              }

              // MC/DC conditions
              for (const cond of method.mcdcConditions ?? []) {
                this.db.insertMcdcCondition({
                  methodId,
                  expression: cond.expression,
                  subConditions: cond.subConditions,
                  truthTable: cond.truthTable,
                  mcdcPairs: cond.mcdcPairs,
                });
              }
            }
          }
        });

        report.parsed++;

      } catch (err) {
        report.errors++;
        try {
          this.db.db?.prepare(
            "INSERT OR IGNORE INTO parse_errors (path, error, logged_at) VALUES (?, ?, datetime('now'))"
          ).run(relative(this.projectRoot, absPath), err.message);
        } catch (_) {}
      }
    }

    // Second pass: resolve call graph
    const resolved = this.db.resolveCalleeIds();

    report.duration = Date.now() - report.start;
    report.callEdgesResolved = resolved;

    return report;
  }

  // ── Single file sync ──────────────────────────────────────────────────────

  async syncFile(absPath) {
    const relPath = relative(this.projectRoot, absPath);
    const lang = extname(absPath).slice(1);
    const content = readFileSync(absPath, 'utf8');
    const hash = sha256(content);
    const lineCount = content.split('\n').length;

    let parsed;
    if (lang === 'java') parsed = parseJava(content, relPath);
    else if (lang === 'xtend') parsed = parseXtend(content, relPath);
    else return { skipped: true };

    let classCount = 0, methodCount = 0, errorCount = parsed.errors.length;

    this.db.transaction(() => {
      const { id: fileId } = this.db.upsertFile({ path: relPath, absPath, lang, sha256: hash, lineCount });

      for (const imp of parsed.imports) {
        this.db.insertDependency({ fromFileId: fileId, toQualified: imp.name, toFileId: null, depType: 'import' });
      }

      for (const cls of parsed.classes) {
        const classId = this.db.insertClass({ ...cls, fileId, packageName: parsed.packageName });
        classCount++;

        for (const field of cls.fields ?? []) this.db.insertField({ ...field, classId });

        for (const method of cls.methods ?? []) {
          const methodId = this.db.insertMethod({ ...method, classId, fileId });
          methodCount++;

          const nodeIdMap = new Map();
          for (const node of method.cfgNodes ?? []) {
            nodeIdMap.set(node.id, this.db.insertCfgNode({ ...node, methodId }));
          }
          for (const edge of method.cfgEdges ?? []) {
            const f = nodeIdMap.get(edge.fromNode), t = nodeIdMap.get(edge.toNode);
            if (f && t) this.db.insertCfgEdge({ methodId, fromNode: f, toNode: t, edgeType: edge.edgeType, condition: edge.condition });
          }
          for (const call of method.callSites ?? []) {
            this.db.insertCallEdge({ callerId: methodId, calleeName: call.calleeName, calleeId: null, callType: 'method', line: call.line });
          }

          // Decisions and atomic conditions
          for (const dec of method.decisions ?? []) {
            const seq = method.decisions.indexOf(dec) + 1;
            const decisionUid = `D-${String(methodId).padStart(4, '0')}-${String(seq).padStart(3, '0')}`;
            const decisionId = this.db.insertDecision({
              methodId,
              decisionUid,
              kind: dec.kind,
              expression: dec.expression,
              normalized: dec.normalized,
              operator: dec.operator,
              lineStart: dec.line_start,
              branchCount: dec.branch_count,
              mcdcRequired: dec.mcdc_required ? 1 : 0,
              parseStatus: dec.parse_status ?? 'ok',
            });

            for (const cond of dec.conditions ?? []) {
              const condUid = `C-${String(decisionId)}-${String(cond.position)}`;
              this.db.insertCondition({
                decisionId,
                conditionUid: condUid,
                text: cond.text ?? '',
                normalizedText: cond.normalized ?? null,
                position: cond.position ?? 1,
                conditionType: cond.condition_type ?? 'atomic',
                parseStatus: cond.parse_status ?? 'ok',
              });
            }
          }

          for (const cond of method.mcdcConditions ?? []) {
            this.db.insertMcdcCondition({ methodId, expression: cond.expression, subConditions: cond.subConditions, truthTable: cond.truthTable, mcdcPairs: cond.mcdcPairs });
          }
        }
      }
    });

    return { relPath, classCount, methodCount, errorCount };
  }
}
