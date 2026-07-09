// src/graph/ir-ingest.js
// Centralized Decision IR ingest module.
// Consumes IR-shaped output from parsers or AST extractors, validates it,
// computes MC/DC pairs centrally, and writes all data to the Graph DB.
//
// This module replaces the inline insert logic previously duplicated
// between syncProject() and syncFile() in builder.js.

import { validateIr } from '../ir/validate-ir.js';
import { buildTruthTable, computeMcdcPairs, evalTree } from '../parser/decision-utils.js';

export class IrIngest {
  /**
   * @param {import('../db/database.js').GraphDatabase} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Ingest an IR object (from a parser or extractor) into the graph DB.
   * @param {object} ir — IR JSON object with classes, methods, decisions, cfg, calls
   * @param {string} filePath — relative file path
   * @param {string} absPath — absolute file path
   * @param {string} lang — 'java' or 'xtend'
   * @param {string} sha256 — content hash
   * @param {number} lineCount — file line count
   * @returns {{ fileId: number, classCount: number, methodCount: number, errors: string[] }}
   */
  ingest(ir, { filePath, absPath, lang, sha256, lineCount }) {
    // Validate IR if it has schema-level fields (fallback parsers may lack irVersion etc.)
    if (ir.irVersion) {
      const validation = validateIr(ir);
      if (!validation.valid) {
        process.stderr.write(`[ir-ingest] ${filePath}: IR validation: ${validation.errors.join('; ')}\n`);
      }
    }

    const fileInfo = { fileId: null, classCount: 0, methodCount: 0, errors: [...(ir.errors ?? [])] };

    this.db.transaction(() => {
      // 1. Upsert file
      const { id: fileId } = this.db.upsertFile({ path: filePath, absPath, lang, sha256, lineCount });
      fileInfo.fileId = fileId;

      // 2. Persist imports as dependencies
      if (ir.imports && Array.isArray(ir.imports)) {
        for (const imp of ir.imports) {
          this.db.insertDependency({
            fromFileId: fileId,
            toQualified: imp.name ?? imp,
            toFileId: null,
            depType: 'import',
          });
        }
      }

      // 3. Persist classes
      for (const cls of ir.classes ?? []) {
        const classId = this.db.insertClass({
          fileId,
          ...cls,
          packageName: ir.packageName ?? cls.packageName,
        });
        fileInfo.classCount++;

        // Fields
        for (const field of cls.fields ?? []) {
          this.db.insertField({ classId, ...field });
        }

        // Methods
        for (const method of cls.methods ?? []) {
          const methodId = this._ingestMethod(fileId, classId, method);
          fileInfo.methodCount++;
        }
      }
    });

    return fileInfo;
  }

  /**
   * Ingest a single method from an IR method object.
   */
  _ingestMethod(fileId, classId, method) {
    // Insert method row
    const methodId = this.db.insertMethod({
      classId,
      fileId,
      name: method.name,
      signature: method.signature,
      returnType: method.returnType ?? 'void',
      visibility: method.visibility ?? 'package',
      isStatic: method.isStatic ? 1 : 0,
      isAbstract: method.isAbstract ? 1 : 0,
      isOverride: method.isOverride ? 1 : 0,
      annotations: method.annotations ?? [],
      parameters: method.parameters ?? [],
      throwsList: method.throwsList ?? [],
      javadoc: method.javadoc ?? null,
      lineStart: method.lineStart ?? null,
      lineEnd: method.lineEnd ?? null,
      cyclomaticComplexity: method.cyclomaticComplexity ?? 1,
      booleanConditions: method.booleanConditions ?? [],
      branchCount: method.branchCount ?? 0,
      conditionCount: method.conditionCount ?? 0,
      asilLevel: method.asilLevel ?? method.asil_level ?? null,
    });

    // CFG nodes
    const nodeIdMap = new Map();
    for (const node of method.cfg?.nodes ?? method.cfgNodes ?? []) {
      const dbId = this.db.insertCfgNode({
        methodId,
        nodeType: node.nodeType,
        label: node.label ?? null,
        line: node.line ?? null,
        condition: node.condition ?? null,
        exceptionType: node.exceptionType ?? null,
        orderIdx: node.orderIdx ?? 0,
      });
      nodeIdMap.set(node.id, dbId);
    }
    // Also accept flat cfgNodes/cfgEdges from fallback parsers
    for (const node of method.cfgNodes ?? []) {
      if (!nodeIdMap.has(node.id)) {
        const dbId = this.db.insertCfgNode({
          methodId,
          nodeType: node.nodeType,
          label: node.label ?? null,
          line: node.line ?? null,
          condition: node.condition ?? null,
          exceptionType: node.exceptionType ?? null,
          orderIdx: node.orderIdx ?? 0,
        });
        nodeIdMap.set(node.id, dbId);
      }
    }

    // CFG edges
    const edges = method.cfg?.edges ?? method.cfgEdges ?? [];
    for (const edge of edges) {
      const fromId = nodeIdMap.get(edge.fromNode);
      const toId = nodeIdMap.get(edge.toNode);
      if (fromId && toId) {
        this.db.insertCfgEdge({ methodId, fromNode: fromId, toNode: toId, edgeType: edge.edgeType, condition: edge.condition });
      }
    }

    // Call sites
    for (const call of method.calls ?? method.callSites ?? []) {
      this.db.insertCallEdge({
        callerId: methodId,
        calleeName: call.calleeName,
        calleeId: null,
        callType: 'method',
        line: call.line,
      });
    }

    // Field accesses
    for (const fa of method.fieldAccesses ?? []) {
      this.db.insertFieldAccess({
        methodId,
        fieldName: fa.fieldName,
        accessType: fa.accessType,
        line: fa.line ?? null,
      });
    }

    // Decisions and conditions + centralized MC/DC
    for (const dec of method.decisions ?? []) {
      const seq = Array.isArray(method.decisions) ? method.decisions.indexOf(dec) + 1 : 1;
      const decisionUid = `D-${String(methodId).padStart(4, '0')}-${String(seq).padStart(3, '0')}`;
      const decisionId = this.db.insertDecision({
        methodId,
        decisionUid,
        kind: dec.kind,
        expression: dec.expression,
        normalized: dec.normalized,
        operator: dec.operator ?? null,
        lineStart: dec.lineStart ?? null,
        branchCount: dec.branchCount ?? 2,
        mcdcRequired: dec.mcdcRequired ? 1 : 0,
        parseStatus: dec.parseStatus ?? 'ok',
      });

      // Insert conditions
      const conditionIdMap = new Map();
      for (const cond of dec.conditions ?? []) {
        const condUid = `C-${String(decisionId)}-${String(cond.position)}`;
        const condId = this.db.insertCondition({
          decisionId,
          conditionUid: condUid,
          text: cond.text ?? '',
          normalizedText: cond.normalizedText ?? null,
          position: cond.position ?? 1,
          conditionType: cond.conditionType ?? 'atomic',
          parseStatus: cond.parseStatus ?? 'ok',
        });
        conditionIdMap.set(cond.position, condId);
      }

      // Centralized MC/DC computation for compound conditions
      if (dec.conditions && dec.conditions.length >= 2) {
        const subConds = dec.conditions.map(c => c.normalizedText || c.text);
        const tt = buildTruthTable(subConds);
        // Pass operator so computeMcdcPairs only returns pairs with opposite outcomes
        const pairs = computeMcdcPairs(subConds, tt, dec.operator ?? null, dec.tree ?? null);

        // Store in mcdc_conditions (backward compat)
        this.db.insertMcdcCondition({
          methodId,
          decisionId,
          expression: dec.expression,
          subConditions: subConds,
          truthTable: tt,
          mcdcPairs: pairs,
        });

        // Populate normalized mcdc_pairs table
        if (tt && pairs) {
          for (let pi = 0; pi < pairs.length; pi++) {
            const pair = pairs[pi];
            const condIdx = subConds.indexOf(pair.condition);
            if (condIdx === -1) continue;
            const condPos = condIdx + 1;
            const conditionId = conditionIdMap.get(condPos);
            if (!conditionId) continue;

            const rowA = tt[pair.rowA];
            const rowB = tt[pair.rowB];
            const outcomeA = this._evaluateOutcome(rowA, dec.operator, dec.tree);
            const outcomeB = this._evaluateOutcome(rowB, dec.operator, dec.tree);

            const pairUid = `P-${String(decisionId).padStart(4, '0')}-${condPos}-${pi + 1}`;
            this.db.insertMcdcPair({
              decisionId,
              conditionId,
              pairUid,
              testVectorA: rowA,
              testVectorB: rowB,
              outcomeA,
              outcomeB,
            });
          }
        }
      }
    }

    // Also ingest any pre-computed mcdcConditions (from fallback parsers, backward compat)
    for (const cond of method.mcdcConditions ?? []) {
      this.db.insertMcdcCondition({
        methodId,
        expression: cond.expression,
        subConditions: cond.subConditions,
        truthTable: cond.truthTable,
        mcdcPairs: cond.mcdcPairs,
      });
    }

    return methodId;
  }

  /**
   * Evaluate a truth table row outcome for a compound decision.
   * Uses operator heuristic: AND = all true, OR = any true, MIXED/null = first true.
   */
  _evaluateOutcome(row, operator, tree = null) {
    if (operator === 'MIXED' && tree) {
      // Use AST-based evaluation for MIXED expressions
      return evalTree(tree, row) ? 1 : 0;
    }
    const vals = Object.values(row);
    if (operator === 'AND') return vals.every(Boolean) ? 1 : 0;
    if (operator === 'OR') return vals.some(Boolean) ? 1 : 0;
    // MIXED without tree, or null: first condition decides
    return vals[0] ? 1 : 0;
  }
}
