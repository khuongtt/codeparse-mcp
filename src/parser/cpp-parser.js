// src/parser/cpp-parser.js
// Tree-sitter based C and C++ parser that emits Decision IR shape.
// Reuses decision-utils.js for boolean decomposition and MC/DC.

import Parser from 'tree-sitter';
import CLang from 'tree-sitter-c';
import CppLang from 'tree-sitter-cpp';
import { createDecision } from './decision-utils.js';

// Re-export for consistency
export { createDecision };

// ── Public API ────────────────────────────────────────────────────────────────

export function parseC(source, filePath) {
  return _parse(source, filePath, 'c');
}

export function parseCpp(source, filePath) {
  return _parse(source, filePath, 'cpp');
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _parse(source, filePath, lang) {
  const result = { packageName: null, imports: [], classes: [], errors: [] };

  let tree;
  try {
    const parser = new Parser();
    parser.setLanguage(lang === 'c' ? CLang : CppLang);
    tree = parser.parse(source);
  } catch (e) {
    result.errors.push({ message: e.message, line: 1 });
    return result;
  }

  try {
    const visitor = new CVisitor(source, filePath, lang);
    visitor.visit(tree.rootNode);
    result.classes = visitor.classes;
    result.errors = visitor.errors;
  } catch (e) {
    result.errors.push({ message: e.message, line: 1 });
  }

  return result;
}

// ── Visitor ───────────────────────────────────────────────────────────────────

class CVisitor {
  constructor(source, filePath, lang) {
    this.source = source;
    this.filePath = filePath;
    this.lang = lang;
    this.classes = [];
    this.errors = [];
    this._currentClass = null;    // when inside struct/union/class
    this._currentMethod = null;
    this._cfgNodes = [];
    this._cfgEdges = [];
    this._nodeCounter = 0;
    this._decisions = [];
    this._calls = [];
    this._loopStack = [];         // for break/continue target tracking
    this._fieldAccesses = [];
    this._cc = 1;                 // cyclomatic complexity
  }

  _src(start, end) {
    return this.source.slice(start, end);
  }

  _lineOf(node) {
    return node ? node.startPosition.row + 1 : null;
  }

  _newNodeId() {
    return ++this._nodeCounter;
  }

  // ── Top-level dispatch ──────────────────────────────────────────────────

  visit(node) {
    if (!node) return;
    switch (node.type) {
      case 'function_definition':      this._visitFunction(node); break;
      case 'struct_specifier':         this._visitStruct(node, 'c_struct'); break;
      case 'union_specifier':          this._visitStruct(node, 'c_union'); break;
      case 'class_specifier':          this._visitStruct(node, 'c_class'); break;
      case 'declaration':              this._visitTopDecl(node); break;
      case 'type_definition':          break; // skip typedef
      case 'namespace_definition':
        // Treat namespace as package — wrap children
        this._visitNamespace(node);
        break;
      default:
        // Recurse into children for unknown top-level nodes
        for (let i = 0; i < node.childCount; i++) this.visit(node.child(i));
    }
  }

  // ── Namespace ────────────────────────────────────────────────────────────

  _visitNamespace(node) {
    const nsName = this._childText(node, 'namespace_identifier')
      || this._childText(node, 'identifier')
      || 'unknown';
    const savedPkg = this._namespace;
    this._namespace = this._namespace ? `${this._namespace}.${nsName}` : nsName;
    const body = this._findChild(node, 'declaration_list');
    if (body) {
      for (let i = 0; i < body.childCount; i++) this.visit(body.child(i));
    }
    this._namespace = savedPkg;
  }

  // ── Struct/Union/Class ───────────────────────────────────────────────────

  _visitStruct(node, kind) {
    const name = this._childText(node, 'type_identifier') || 'Anonymous';
    const line = this._lineOf(node);

    const cls = {
      name,
      qualifiedName: this._qualify(name),
      packageName: this._namespace || null,
      kind,
      visibility: 'public',
      isAbstract: false,
      superclass: null,
      interfaces: [],
      annotations: [],
      javadoc: null,
      asilLevel: null,
      fields: [],
      methods: [],
    };

    this._currentClass = cls;

    // Walk body
    const body = this._findChild(node, 'field_declaration_list');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (child.type === 'function_definition') {
          this._visitFunction(child);
        } else if (child.type === 'field_declaration') {
          cls.fields.push(this._extractField(child));
        }
      }
    }

    this.classes.push(cls);
    this._currentClass = null;
  }

  _extractField(node) {
    const type = this._childText(node, 'primitive_type')
      || this._childText(node, 'type_identifier')
      || this._childText(node, 'sized_type_specifier')
      || 'int';
    const name = this._childText(node, 'field_identifier')
      || this._childText(node, 'identifier')
      || 'unknown';
    return { name, type, visibility: 'public', isStatic: false, isFinal: false, line: this._lineOf(node) };
  }

  // ── Functions (top-level and class members) ──────────────────────────────

  _visitFunction(node) {
    const decl = this._findChild(node, 'function_declarator');
    if (!decl) return;

    const name = this._childText(decl, 'identifier')
      || this._childText(decl, 'field_identifier')
      || 'unknown';
    const returnType = this._childText(node, 'primitive_type')
      || this._childText(node, 'type_identifier')
      || this._childText(node, 'sized_type_specifier')
      || 'void';

    this._cfgNodes = [];
    this._cfgEdges = [];
    this._decisions = [];
    this._calls = [];
    this._loopStack = [];
    this._fieldAccesses = [];
    this._cc = 1;
    this._nodeCounter = 0;

    // ENTRY node
    const entryId = this._newNodeId();
    this._cfgNodes.push({ id: entryId, nodeType: 'ENTRY', label: `${name}()`, line: this._lineOf(node), orderIdx: 0 });

    // Parameters
    const params = [];
    const paramList = this._findChild(decl, 'parameter_list');
    if (paramList) {
      for (let i = 0; i < paramList.childCount; i++) {
        const p = paramList.child(i);
        if (p.type === 'parameter_declaration' || (this.lang === 'cpp' && p.type === 'parameter_declaration')) {
          const pType = this._childText(p, 'primitive_type') || this._childText(p, 'type_identifier') || '';
          const pName = this._childText(p, 'identifier') || '';
          if (pType) params.push({ name: pName, type: pType, annotations: [] });
        }
      }
    }

    const sig = `${name}(${params.map(p => p.type).join(',')}):${returnType}`;

    // Walk body — _walkBlock links entry → stmts
    let blockLast = entryId;
    const body = this._findChild(node, 'compound_statement');
    if (body) {
      blockLast = this._walkBlock(body, entryId);
    }

    // EXIT node + link from last block node
    const exitNodeId = this._newNodeId();
    this._cfgNodes.push({ id: exitNodeId, nodeType: 'EXIT', label: `${name}() end`, line: this._lineOf(node), orderIdx: this._cfgNodes.length });
    this._addEdge(blockLast, exitNodeId, 'sequential');

    this._cc += this._decisions.length;

    const method = {
      name,
      signature: sig,
      returnType,
      visibility: this._currentClass ? 'public' : 'package',
      lineStart: this._lineOf(node),
      cyclomaticComplexity: this._cc,
      branchCount: this._decisions.length,
      conditionCount: this._decisions.reduce((s, d) => s + (d.conditions?.length ?? 0), 0),
      isStatic: 0,
      isAbstract: 0,
      isOverride: 0,
      annotations: [],
      parameters: params,
      javadoc: null,
      asilLevel: null,
      decisions: this._decisions,
      cfg: { nodes: this._cfgNodes, edges: this._cfgEdges },
      calls: this._calls,
      callSites: this._calls,
      fieldAccesses: this._fieldAccesses,
    };

    if (this._currentClass) {
      this._currentClass.methods.push(method);
    } else {
      // Top-level function — create synthetic class per function
      const pkg = this._namespace || '';
      const clsName = `__file__${name ? `_${name}` : ''}`;
      const cls = {
        name: clsName,
        qualifiedName: pkg ? `${pkg}.${clsName}` : clsName,
        packageName: pkg || null,
        kind: 'c_struct',
        visibility: 'public',
        isAbstract: false,
        superclass: null,
        interfaces: [],
        annotations: [],
        javadoc: null,
        asilLevel: null,
        fields: [],
        methods: [method],
      };
      this.classes.push(cls);
    }
  }

  // ── Top-level declarations ──────────────────────────────────────────────

  _visitTopDecl(node) {
    // Handle variable declarations, etc — minimal for now
  }

  // ── Statement walking (CFG builder) ─────────────────────────────────────

  /**
   * Walk a compound_statement or block. parentId is the node that feeds into this block.
   * Returns the last node id in the block, or null if empty.
   * Each _walkStmt returns either a simple node id or {entry, exit} for control structures.
   */
  _walkBlock(blockNode, parentId) {
    let lastId = parentId;
    for (let i = 0; i < blockNode.childCount; i++) {
      const child = blockNode.child(i);
      const result = this._walkStmt(child);
      if (result === null) continue;
      if (typeof result === 'number') {
        // Simple statement node
        if (lastId !== null && lastId !== result) {
          this._addEdge(lastId, result, 'sequential');
        }
        lastId = result;
      } else {
        // Structured control flow: {entry, exit}
        if (lastId !== null) {
          this._addEdge(lastId, result.entry, 'sequential');
        }
        lastId = result.exit;
      }
    }
    return lastId;
  }

  _walkStmt(node) {
    if (!node) return null;
    switch (node.type) {
      case 'expression_statement':         return this._walkExprStmt(node);
      case 'return_statement':             return this._walkReturnStmt(node);
      case 'if_statement':                 return this._walkIfStmt(node);
      case 'for_statement':                return this._walkForStmt(node);
      case 'while_statement':              return this._walkWhileStmt(node);
      case 'do_statement':                 return this._walkDoStmt(node);
      case 'switch_statement':             return this._walkSwitchStmt(node);
      case 'break_statement':             return this._walkBreak();
      case 'continue_statement':          return this._walkContinue();
      case 'compound_statement':           return this._walkBlock(node, null);
      case 'case_statement':
      case 'labeled_statement':           // C++ switch case fallback
        // Handled by switch walking
        return null;
      case 'declaration':                  return this._walkDeclStmt(node);
      default:
        // Skip braces, semicolons, and unknown — recurse into children
        if (node.childCount > 0 && !node.type.match(/^{|}$|;|,/)) {
          // Might be an expression in C++
          return null;
        }
        return null;
    }
  }

  _walkExprStmt(node) {
    const expr = this._findChild(node, 'assignment_expression')
      || this._findChild(node, 'call_expression')
      || this._findChild(node, 'binary_expression')
      || this._findChild(node, 'update_expression')
      || this._findChild(node, 'unary_expression');

    if (!expr) {
      // Check for call_expression directly inside expression_statement
      const call = this._findChild(node, 'call_expression');
      if (call) {
        this._recordCall(call);
        const id = this._newNodeId();
        this._cfgNodes.push({
          id, nodeType: 'STATEMENT', label: `call ${this._src(call.startIndex, call.endIndex)}`,
          line: this._lineOf(call), orderIdx: this._cfgNodes.length,
        });
        return id;
      }
      return null;
    }

    // Check for nested call expression
    const call = this._findChild(expr, 'call_expression')
      || (expr.type === 'call_expression' ? expr : null);
    if (call) this._recordCall(call);

    if (expr.type === 'call_expression') {
      this._recordCall(expr);
    }

    const id = this._newNodeId();
    this._cfgNodes.push({
      id, nodeType: 'STATEMENT',
      label: this._src(expr.startIndex, expr.endIndex),
      line: this._lineOf(expr), orderIdx: this._cfgNodes.length,
    });
    return id;
  }

  _walkReturnStmt(node) {
    const call = this._findChild(node, 'call_expression');
    if (call) this._recordCall(call);

    const id = this._newNodeId();
    const label = this._src(node.startIndex, node.endIndex);
    this._cfgNodes.push({
      id, nodeType: 'RETURN', label, line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });
    return id;
  }

  _walkIfStmt(node) {
    const condExpr = this.logic_expression(node);
    const condText = condExpr ? this._src(condExpr.startIndex, condExpr.endIndex) : '';

    const branchId = this._newNodeId();
    this._cfgNodes.push({
      id: branchId, nodeType: 'BRANCH', label: `if (${condText})`,
      condition: condText, line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });

    // Create decision
    if (condText) {
      const dec = createDecision('if', condText, this._lineOf(node));
      if (dec && dec.conditions && dec.conditions.length > 0) {
        this._decisions.push(dec);
      }
    }

    // Then branch
    const thenBlock = this._findChild(node, 'compound_statement');
    let thenLast = thenBlock ? this._walkBlock(thenBlock, null) : null;

    // Else branch (3rd child beyond condition)
    // tree-sitter: if (condition) then_body else_body
    let elseBlock = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === 'compound_statement' && (!thenBlock || c !== thenBlock)) {
        elseBlock = c;
      }
      if (c.type === 'if_statement') {
        elseBlock = c;
      }
    }
    // Fallback: last child is else
    if (!elseBlock && node.childCount > 3) {
      const last = node.child(node.childCount - 1);
      if (last.type === 'compound_statement' || last.type === 'if_statement') {
        elseBlock = last;
      }
    }

    // True edge
    if (thenLast !== null) {
      this._addEdge(branchId, typeof thenLast === 'number' ? thenLast : thenLast.entry, 'true_branch');
    } else {
      const nopId = this._newNodeId();
      this._cfgNodes.push({ id: nopId, nodeType: 'STATEMENT', label: 'empty then', line: this._lineOf(node), orderIdx: this._cfgNodes.length });
      this._addEdge(branchId, nopId, 'true_branch');
      thenLast = nopId;
    }

    // False edge + merge
    let mergePoint = null;
    if (elseBlock) {
      let elseLast;
      if (elseBlock.type === 'if_statement') {
        elseLast = this._walkIfStmt(elseBlock);
      } else {
        elseLast = this._walkBlock(elseBlock, null);
      }
      const elseEdgeTarget = (elseLast !== null && typeof elseLast !== 'number') ? elseLast.entry : elseLast;
      if (elseEdgeTarget !== null) {
        this._addEdge(branchId, elseEdgeTarget, 'false_branch');
      }
      // Merge after else
      mergePoint = this._newNodeId();
      this._cfgNodes.push({ id: mergePoint, nodeType: 'STATEMENT', label: 'if merge', line: this._lineOf(node), orderIdx: this._cfgNodes.length });
      if (thenLast !== null && typeof thenLast !== 'number') {
        this._addEdge(thenLast.exit, mergePoint, 'sequential');
      } else if (thenLast !== null) {
        this._addEdge(thenLast, mergePoint, 'sequential');
      }
      if (elseLast !== null && typeof elseLast !== 'number') {
        this._addEdge(elseLast.exit, mergePoint, 'sequential');
      } else if (elseLast !== null) {
        this._addEdge(elseLast, mergePoint, 'sequential');
      }
    } else {
      mergePoint = this._newNodeId();
      this._cfgNodes.push({ id: mergePoint, nodeType: 'STATEMENT', label: 'if merge', line: this._lineOf(node), orderIdx: this._cfgNodes.length });
      this._addEdge(branchId, mergePoint, 'false_branch');
      if (thenLast !== null && typeof thenLast !== 'number') {
        this._addEdge(thenLast.exit, mergePoint, 'sequential');
      } else if (thenLast !== null) {
        this._addEdge(thenLast, mergePoint, 'sequential');
      }
    }

    return { entry: branchId, exit: mergePoint };
  }

  _walkForStmt(node) {
    // Extract condition from the 2nd child of for_statement
    // tree-sitter for_statement: 'for', '(', init_decl or expr, ';', condition_expr?, ';', update_expr?, ')', body
    let condText = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      // condition is typically after first ';' — the expression before second ';'
      if (c.type === 'binary_expression' || c.type === 'identifier') {
        const prev = i > 0 ? node.child(i - 1) : null;
        const next = i < node.childCount - 1 ? node.child(i + 1) : null;
        // Only the condition between the two semicolons
        if (prev && prev.type === ';' && next && next.type === ';') {
          condText = this._src(c.startIndex, c.endIndex);
        }
      }
    }

    const loopHead = this._newNodeId();
    this._cfgNodes.push({
      id: loopHead, nodeType: 'LOOP', label: `for (${condText || '...'})`,
      condition: condText || null, line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });

    this._loopStack.push({ head: loopHead, exit: null });

    const body = this._findChild(node, 'compound_statement');
    let bodyLast = null;
    if (body) {
      bodyLast = this._walkBlock(body, null);
    }

    // True edge: loopHead → body
    if (bodyLast) {
      this._addEdge(loopHead, bodyLast, 'true_branch');
      // Loop back: body → loopHead
      this._addEdge(bodyLast, loopHead, 'loop_back');
    }

    this._loopStack.pop();

    // Exit node after loop (false_branch for when condition fails)
    const exitId = this._newNodeId();
    this._cfgNodes.push({ id: exitId, nodeType: 'STATEMENT', label: 'for exit', line: this._lineOf(node), orderIdx: this._cfgNodes.length });
    this._addEdge(loopHead, exitId, 'false_branch');

    return { entry: loopHead, exit: exitId };
  }

  _walkWhileStmt(node) {
    // Extract condition — while (condition) body
    let condText = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === 'parenthesized_expression') {
        condText = this._src(c.startIndex, c.endIndex).replace(/^\(|\)$/g, '');
      }
    }
    const loopHead = this._newNodeId();
    this._cfgNodes.push({
      id: loopHead, nodeType: 'LOOP', label: `while (${condText || '...'})`,
      condition: condText || null, line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });

    // Create decision for condition
    if (condText) {
      const dec = createDecision('while', condText, this._lineOf(node));
      if (dec && dec.conditions && dec.conditions.length > 0) this._decisions.push(dec);
    }

    this._loopStack.push({ head: loopHead, exit: null });

    const body = this._findChild(node, 'compound_statement');
    let bodyLast = null;
    if (body) {
      bodyLast = this._walkBlock(body, null);
    }

    if (bodyLast) {
      this._addEdge(loopHead, bodyLast, 'true_branch');
      this._addEdge(bodyLast, loopHead, 'loop_back');
    }

    this._loopStack.pop();

    // Exit
    const exitId = this._newNodeId();
    this._cfgNodes.push({ id: exitId, nodeType: 'STATEMENT', label: 'while exit', line: this._lineOf(node), orderIdx: this._cfgNodes.length });
    this._addEdge(loopHead, exitId, 'false_branch');

    return { entry: loopHead, exit: exitId };
  }

  _walkDoStmt(node) {
    const loopHead = this._newNodeId();
    this._cfgNodes.push({
      id: loopHead, nodeType: 'LOOP', label: 'do-while (...)',
      line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });

    this._loopStack.push({ head: loopHead, exit: null });

    const body = this._findChild(node, 'compound_statement');
    let bodyLast = loopHead;
    if (body) {
      bodyLast = this._walkBlock(body, loopHead);
    }

    this._loopStack.pop();

    // Loop back from last body → loopHead, then loopHead → exit
    if (bodyLast !== loopHead) {
      this._addEdge(loopHead, bodyLast, 'true_branch');
      this._addEdge(bodyLast, loopHead, 'loop_back');
    }

    const exitId = this._newNodeId();
    this._cfgNodes.push({ id: exitId, nodeType: 'STATEMENT', label: 'do-while exit', line: this._lineOf(node), orderIdx: this._cfgNodes.length });
    this._addEdge(loopHead, exitId, 'false_branch');

    return { entry: loopHead, exit: exitId };
  }

  _walkSwitchStmt(node) {
    const switchId = this._newNodeId();
    this._cfgNodes.push({
      id: switchId, nodeType: 'SWITCH', label: 'switch',
      line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });

    const body = this._findChild(node, 'compound_statement');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (child.type === 'case_statement' || child.type === 'labeled_statement') {
          const caseId = this._newNodeId();
          const label = this._childText(child, 'case') || 'default';
          this._cfgNodes.push({
            id: caseId, nodeType: 'STATEMENT', label: `case ${label}`,
            line: this._lineOf(child), orderIdx: this._cfgNodes.length,
          });
          this._addEdge(switchId, caseId, 'true_branch');
        }
      }
    }

    const exitId = this._newNodeId();
    this._cfgNodes.push({ id: exitId, nodeType: 'STATEMENT', label: 'switch exit', line: this._lineOf(node), orderIdx: this._cfgNodes.length });

    return { entry: switchId, exit: exitId };
  }

  _walkBreak() {
    return null;
  }

  _walkContinue() {
    return null;
  }

  _walkDeclStmt(node) {
    // Variable declaration — create a STATEMENT node
    const id = this._newNodeId();
    this._cfgNodes.push({
      id, nodeType: 'STATEMENT',
      label: this._src(node.startIndex, node.endIndex),
      line: this._lineOf(node), orderIdx: this._cfgNodes.length,
    });
    return id;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _addEdge(from, to, type) {
    this._cfgEdges.push({ fromNode: from, toNode: to, edgeType: type });
  }

  _recordCall(node) {
    const fn = this._findChild(node, 'identifier')
      || this._findChild(node, 'field_expression')?._firstNamedChild
      || this._findChild(node, 'qualified_identifier');
    // Nested calls: function_declarator inside call_expression has the identifier
    const decl = this._findChild(node, 'function_declarator');
    const name = decl
      ? (this._childText(decl, 'identifier') || this._childText(decl, 'field_identifier'))
      : this._childText(node, 'identifier')
        || fn?.type === 'identifier' ? this._src(fn.startIndex, fn.endIndex)
        : this._src(node.startIndex, node.endIndex).replace(/\(.*$/, '') || 'unknown';

    this._calls.push({ calleeName: name, line: this._lineOf(node) });
  }

  _findChild(node, type) {
    if (!node) return null;
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i).type === type) return node.child(i);
    }
    return null;
  }

  _childText(node, type) {
    const child = this._findChild(node, type);
    return child ? this._src(child.startIndex, child.endIndex) : null;
  }

  _qualify(name) {
    return this._namespace ? `${this._namespace}.${name}` : name;
  }

  logic_expression(node) {
    let condExpr = this._findChild(node, 'parenthesized_expression');
    if (condExpr) {
      // Inside parens, find the actual expression
      const inner = this._findChild(condExpr, 'binary_expression')
        || this._findChild(condExpr, 'identifier');
      return inner || condExpr;
    }
    // C++: condition_clause
    const condClause = this._findChild(node, 'condition_clause');
    if (condClause) {
      const inner = this._findChild(condClause, 'binary_expression')
        || this._findChild(condClause, 'identifier')
        || this._findChild(condClause, 'call_expression');
      return inner || condClause;
    }
    // Generic: find binary_expression at any depth
    return this._findChild(node, 'binary_expression') || this._findChild(node, 'identifier');
  }
}
