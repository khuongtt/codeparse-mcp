// src/parser/java-parser.js
// Accurate Java CST → Graph parser using the 'java-parser' npm package.
// Node names verified against actual CST output.

import { parse as javaParse } from 'java-parser';

// ── Public API ────────────────────────────────────────────────────────────────

export function parseJava(source, filePath) {
  const result = { packageName: null, imports: [], classes: [], errors: [] };
  let cst;
  try {
    cst = javaParse(source);
  } catch (e) {
    result.errors.push({ message: e.message, line: e.token?.startLine });
    return result;
  }

  // Pre-scan source lines for Javadoc (java-parser drops comments from CST)
  const javadocMap = buildJavadocMap(source);

  const visitor = new JavaVisitor(source, filePath, javadocMap);
  visitor.visit(cst);
  result.packageName = visitor.packageName;
  result.imports = visitor.imports;
  result.classes = visitor.classes;
  result.errors = visitor.errors;
  return result;
}

// ── Javadoc pre-scan ──────────────────────────────────────────────────────────
// Maps: lineNumber → javadoc comment that ends just before that line

function buildJavadocMap(source) {
  const map = new Map();
  const re = /\/\*\*([\s\S]*?)\*\//g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const comment = m[0];
    const afterIdx = m.index + comment.length;
    // Count the line number of the character right after the comment
    const linesBefore = source.slice(0, afterIdx).split('\n').length;
    map.set(linesBefore, comment);
    map.set(linesBefore + 1, comment); // also map next line (blank line between javadoc and decl)
  }
  return map;
}

// ── CST helpers ───────────────────────────────────────────────────────────────

function findAll(node, name, results = []) {
  if (!node || typeof node !== 'object') return results;
  if (node.name === name) { results.push(node); return results; }
  if (node.children) for (const arr of Object.values(node.children)) for (const c of arr) findAll(c, name, results);
  return results;
}

function findFirst(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (node.name === name) return node;
  if (node.children) for (const arr of Object.values(node.children)) {
    for (const c of arr) { const r = findFirst(c, name); if (r) return r; }
  }
  return null;
}

function firstToken(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.image !== undefined) return node;
  if (node.children) for (const arr of Object.values(node.children)) {
    for (const c of arr) { const t = firstToken(c); if (t) return t; }
  }
  return null;
}

function lineOf(node) { return firstToken(node)?.startLine ?? null; }

function allTokenImages(node) {
  // Collect all leaf tokens sorted by startOffset for correct left-to-right order
  const toks = [];
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.image !== undefined) { toks.push(n); return; }
    if (n.children) for (const arr of Object.values(n.children)) for (const c of arr) collect(c);
  };
  collect(node);
  toks.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));
  return toks.map(t => t.image);
}

// ── JavaVisitor ───────────────────────────────────────────────────────────────

class JavaVisitor {
  constructor(source, filePath, javadocMap) {
    this.source = source;
    this.filePath = filePath;
    this.javadocMap = javadocMap;
    this.packageName = null;
    this.imports = [];
    this.classes = [];
    this.errors = [];
    this._classStack = [];
  }

  visit(node) {
    if (!node || typeof node !== 'object') return;
    const handler = node.name ? `_visit_${node.name}` : null;
    if (handler && typeof this[handler] === 'function') {
      this[handler](node);
    } else {
      this._children(node);
    }
  }

  _children(node) {
    if (!node?.children) return;
    for (const arr of Object.values(node.children)) for (const c of arr) this.visit(c);
  }

  // ── Package ───────────────────────────────────────────────────────────────

  _visit_packageDeclaration(node) {
    // children: Package, Identifier..., Dot..., Semicolon
    const ids = (node.children?.Identifier ?? []).map(t => t.image);
    this.packageName = ids.join('.');
  }

  // ── Imports ───────────────────────────────────────────────────────────────

  _visit_importDeclaration(node) {
    const isStatic = !!(node.children?.Static);
    const ids = (node.children?.Identifier ?? []).map(t => t.image);
    const isWildcard = !!(node.children?.Star);
    const name = ids.join('.') + (isWildcard ? '.*' : '');
    if (name) this.imports.push({ name, isStatic, isWildcard });
  }

  // ── Class declarations ────────────────────────────────────────────────────

  _visit_classDeclaration(node) {
    const modifiers = this._extractModifiers(node.children?.classModifier ?? []);
    const annotations = this._extractAnnotations(node.children?.classModifier ?? []);
    const ncd = findFirst(node, 'normalClassDeclaration');
    if (!ncd) return;

    const name = (findFirst(ncd, 'typeIdentifier')?.children?.Identifier?.[0]?.image) ?? 'Unknown';
    const line = lineOf(ncd);
    const qualifiedName = this._qualifyName(name);
    const javadoc = this._findJavadoc(line);

    const superclassNode = ncd.children?.classExtends?.[0];
    const superclass = superclassNode ? this._extractTypeName(findFirst(superclassNode, 'classType')) : null;

    const implNode = ncd.children?.classImplements?.[0];
    const interfaces = implNode ? findAll(implNode, 'classType').map(ct => this._extractTypeName(ct)) : [];

    const cls = {
      name, qualifiedName, packageName: this.packageName,
      kind: 'class',
      isAbstract: modifiers.includes('abstract'),
      visibility: this._visibility(modifiers),
      annotations, javadoc, superclass, interfaces,
      lineStart: line, lineEnd: null,
      asilLevel: this._detectAsil(annotations, javadoc),
      methods: [], fields: [], nestedClasses: [],
    };

    this._classStack.push(cls);
    this._children(ncd);
    this._classStack.pop();
    this.classes.push(cls);
  }

  _visit_interfaceDeclaration(node) { this._visitTypeDecl(node, 'interface'); }
  _visit_enumDeclaration(node) { this._visitTypeDecl(node, 'enum'); }
  _visit_annotationTypeDeclaration(node) { this._visitTypeDecl(node, 'annotation'); }

  _visitTypeDecl(node, kind) {
    const modifiers = this._extractModifiers(node.children?.classModifier
      ?? node.children?.interfaceModifier ?? []);
    const annotations = this._extractAnnotations(node.children?.classModifier
      ?? node.children?.interfaceModifier ?? []);
    const idNode = findFirst(node, 'typeIdentifier') ?? findFirst(node, 'Identifier');
    const name = idNode?.children?.Identifier?.[0]?.image ?? idNode?.image ?? 'Unknown';
    const line = lineOf(node);
    const qualifiedName = this._qualifyName(name);
    const javadoc = this._findJavadoc(line);

    const cls = {
      name, qualifiedName, packageName: this.packageName,
      kind, isAbstract: false, visibility: this._visibility(modifiers),
      annotations, javadoc, superclass: null, interfaces: [],
      lineStart: line, lineEnd: null,
      asilLevel: this._detectAsil(annotations, javadoc),
      methods: [], fields: [], nestedClasses: [],
    };
    this._classStack.push(cls);
    this._children(node);
    this._classStack.pop();
    this.classes.push(cls);
  }

  // ── Method declarations ───────────────────────────────────────────────────

  _visit_methodDeclaration(node) {
    if (!this._currentClass()) return;
    const modNodes = node.children?.methodModifier ?? [];
    const modifiers = this._extractModifiers(modNodes);
    const annotations = this._extractAnnotations(modNodes);

    const header = findFirst(node, 'methodHeader');
    const declarator = findFirst(header, 'methodDeclarator');
    const name = declarator?.children?.Identifier?.[0]?.image ?? 'unknown';
    const line = lineOf(node);
    const returnType = this._extractReturnTypeFromResult(header?.children?.result?.[0]);
    const params = this._extractParams(findFirst(declarator, 'formalParameterList'));
    const throwsList = this._extractThrows(findFirst(header, 'throws'));
    const javadoc = this._findJavadoc(line);
    const body = findFirst(node, 'methodBody');
    const cfgData = body ? analyzeBody(body) : emptyCfg();

    const method = {
      name,
      signature: `${name}(${params.map(p => p.type).join(',')})`,
      returnType,
      visibility: this._visibility(modifiers),
      isStatic: modifiers.includes('static'),
      isAbstract: modifiers.includes('abstract'),
      isOverride: annotations.includes('Override'),
      annotations, params: params, parameters: params,
      throwsList, javadoc,
      lineStart: line, lineEnd: null,
      asilLevel: this._detectAsil(annotations, javadoc),
      ...cfgData,
    };
    method.signature = `${name}(${params.map(p => p.type).join(',')})`;
    this._currentClass().methods.push(method);
  }

  _visit_constructorDeclaration(node) {
    if (!this._currentClass()) return;
    const modNodes = node.children?.constructorModifier ?? [];
    const modifiers = this._extractModifiers(modNodes);
    const annotations = this._extractAnnotations(modNodes);
    const declarator = findFirst(node, 'constructorDeclarator');
    const name = findFirst(declarator, 'typeIdentifier')?.children?.Identifier?.[0]?.image
               ?? this._currentClass().name;
    const line = lineOf(node);
    const params = this._extractParams(findFirst(declarator, 'formalParameterList'));
    const throwsList = this._extractThrows(findFirst(node, 'throws'));
    const javadoc = this._findJavadoc(line);
    const body = node.children?.constructorBody?.[0];
    const cfgData = body ? analyzeBody(body) : emptyCfg();

    this._currentClass().methods.push({
      name,
      signature: `${name}(${params.map(p => p.type).join(',')})`,
      returnType: this._currentClass().qualifiedName,
      visibility: this._visibility(modifiers),
      isStatic: false, isAbstract: false,
      isOverride: false,
      annotations, parameters: params, throwsList, javadoc,
      lineStart: line, lineEnd: null,
      asilLevel: this._detectAsil(annotations, javadoc),
      ...cfgData,
    });
  }

  // ── Field declarations ────────────────────────────────────────────────────

  _visit_fieldDeclaration(node) {
    if (!this._currentClass()) return;
    const modNodes = node.children?.fieldModifier ?? [];
    const modifiers = this._extractModifiers(modNodes);
    const annotations = this._extractAnnotations(modNodes);
    const type = this._extractTypeName(findFirst(node, 'unannType'));
    const line = lineOf(node);

    for (const decl of findAll(node, 'variableDeclarator')) {
      const nameId = decl.children?.variableDeclaratorId?.[0];
      const name = nameId?.children?.Identifier?.[0]?.image ?? 'unknown';
      const initNode = decl.children?.variableInitializer?.[0];
      const initialValue = initNode ? allTokenImages(initNode).slice(0, 15).join(' ') : null;
      this._currentClass().fields.push({
        name, type,
        visibility: this._visibility(modifiers),
        isStatic: modifiers.includes('static'),
        isFinal: modifiers.includes('final'),
        annotations, initialValue, line,
      });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _currentClass() { return this._classStack[this._classStack.length - 1] ?? null; }

  _qualifyName(name) {
    if (this._classStack.length) return `${this._classStack[this._classStack.length - 1].qualifiedName}.${name}`;
    return this.packageName ? `${this.packageName}.${name}` : name;
  }

  _extractModifiers(modNodes) {
    const mods = [];
    const keys = ['Public','Protected','Private','Static','Final','Abstract','Synchronized','Native','Transient','Volatile','Strictfp'];
    for (const m of modNodes) {
      for (const k of keys) {
        if (m.children?.[k]) mods.push(k.toLowerCase());
      }
    }
    return mods;
  }

  _extractAnnotations(modNodes) {
    const anns = [];
    for (const m of modNodes) {
      const annNode = m.children?.annotation?.[0];
      if (annNode) {
        const tn = findFirst(annNode, 'typeName');
        const name = (tn?.children?.Identifier ?? []).map(t => t.image).join('.');
        if (name) anns.push(name);
      }
    }
    return anns;
  }

  _extractTypeName(node) {
    if (!node) return 'Object';
    // Collect all Identifier tokens from the type node
    const ids = [];
    const collect = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.name === 'Identifier' || (n.image !== undefined && n.tokenType?.name === 'Identifier')) {
        ids.push(n.image); return;
      }
      if (n.image !== undefined) {
        // Check token type name
        if (/^(Int|Long|Double|Float|Boolean|Byte|Char|Short|Void)$/.test(n.tokenType?.name ?? '')) {
          ids.push(n.image);
        }
        return;
      }
      if (n.children) for (const arr of Object.values(n.children)) for (const c of arr) collect(c);
    };
    collect(node);
    if (ids.length) return ids.join('.');
    // Primitive fallback
    const tokens = allTokenImages(node);
    const prim = tokens.find(t => /^(int|long|double|float|boolean|byte|char|short|void)$/.test(t));
    return prim ?? 'Object';
  }

  _extractReturnTypeFromResult(node) {
    if (!node) return 'void';
    if (node.children?.Void) return 'void';
    const typeNode = node.children?.unannType?.[0];
    return typeNode ? this._extractTypeName(typeNode) : 'void';
  }

  _extractParams(listNode) {
    if (!listNode) return [];
    const params = [];
    for (const fp of findAll(listNode, 'variableParaRegularParameter')) {
      const typeNode = findFirst(fp, 'unannType');
      const idNode = findFirst(fp, 'variableDeclaratorId');
      const type = this._extractTypeName(typeNode);
      const name = idNode?.children?.Identifier?.[0]?.image ?? 'param';
      const isVararg = !!(findAll(fp, 'Ellipsis').length || fp.children?.Ellipsis);
      params.push({ name, type: isVararg ? `${type}...` : type, annotations: [] });
    }
    return params;
  }

  _extractThrows(node) {
    if (!node) return [];
    return findAll(node, 'classType').map(ct => this._extractTypeName(ct));
  }

  _findJavadoc(line) {
    if (!line) return null;
    return this.javadocMap.get(line) ?? this.javadocMap.get(line - 1) ?? null;
  }

  _visibility(mods) {
    if (mods.includes('public')) return 'public';
    if (mods.includes('protected')) return 'protected';
    if (mods.includes('private')) return 'private';
    return 'package';
  }

  _detectAsil(annotations, javadoc) {
    const text = [...(annotations ?? []), javadoc ?? ''].join(' ');
    const m = text.match(/ASIL[_\s-]?([A-D]|QM)/i);
    return m ? `ASIL-${m[1].toUpperCase()}` : null;
  }
}

// ── CFG / MC/DC Body Analyzer ─────────────────────────────────────────────────

function emptyCfg() {
  return {
    cfgNodes: [], cfgEdges: [], callSites: [],
    booleanConditions: [], branchCount: 0, conditionCount: 0,
    cyclomaticComplexity: 1, mcdcConditions: [],
  };
}

function analyzeBody(bodyNode) {
  const a = new BodyAnalyzer();
  a.analyze(bodyNode);
  return a.result();
}

class BodyAnalyzer {
  constructor() {
    this._nodes = []; this._edges = []; this._calls = [];
    this._conds = []; this._mcdc = [];
    this._branches = 0; this._condCount = 0; this._cc = 1;
    this._idx = 0;
    this._cur = this._addNode('ENTRY', 'entry', null, null);
  }

  _addNode(type, label, line, cond) {
    const id = ++this._idx;
    this._nodes.push({ id, nodeType: type, label, line, condition: cond, orderIdx: id });
    return id;
  }

  _addEdge(f, t, type = 'sequential', cond = null) {
    if (f && t) this._edges.push({ fromNode: f, toNode: t, edgeType: type, condition: cond });
  }

  analyze(node) {
    this._visitNode(node);
    const exit = this._addNode('EXIT', 'exit', null, null);
    this._addEdge(this._cur, exit);
  }

  _visitNode(node) {
    if (!node || typeof node !== 'object') return;
    switch (node.name) {
      case 'ifStatement': this._visitIf(node); return;
      case 'basicForStatement': case 'forStatement': this._visitFor(node); return;
      case 'enhancedForStatement': this._visitEnhancedFor(node); return;
      case 'whileStatement': this._visitWhile(node); return;
      case 'doStatement': this._visitDo(node); return;
      case 'switchStatement': this._visitSwitch(node); return;
      case 'tryStatement': this._visitTry(node); return;
      case 'returnStatement': this._visitReturn(node); return;
      case 'throwStatement': this._visitThrow(node); return;
      case 'statementExpression': this._visitStatementExpr(node); return;
    }
    if (node.children) for (const arr of Object.values(node.children)) for (const c of arr) this._visitNode(c);
  }

  _visitIf(node) {
    // children: If, LBrace, expression, RBrace, statement (then), [Else, statement (else)]
    const exprNode = node.children?.expression?.[0];
    const cond = exprNode ? allTokenImages(exprNode).join(' ').slice(0, 200) : '';
    const stmts = node.children?.statement ?? [];

    this._branches += 2; this._condCount++; this._cc++;
    this._registerCond(cond);

    const branchId = this._addNode('BRANCH', `if (${cond})`, lineOf(node), cond);
    this._addEdge(this._cur, branchId);

    const mergeId = this._addNode('STATEMENT', 'merge', null, null);

    // true branch
    this._cur = branchId;
    if (stmts[0]) this._visitNode(stmts[0]);
    this._addEdge(this._cur, mergeId, 'true_branch', 'true');

    // false branch
    if (stmts[1]) { // else exists
      this._cur = branchId;
      this._visitNode(stmts[1]);
      this._addEdge(this._cur, mergeId, 'false_branch', 'false');
    } else {
      this._addEdge(branchId, mergeId, 'false_branch', 'false');
    }

    this._cur = mergeId;
  }

  _visitFor(node) {
    // basicForStatement: For, LBrace, forInit, Semicolon, expression, forUpdate, RBrace, statement
    const inner = findFirst(node, 'basicForStatement') ?? node;
    const exprNode = inner.children?.expression?.[0];
    const cond = exprNode ? allTokenImages(exprNode).join(' ').slice(0, 200) : '';
    this._branches += 2; this._cc++;
    if (cond) { this._condCount++; this._registerCond(cond); }

    const loopId = this._addNode('LOOP', `for (${cond || '...'})`, lineOf(node), cond || null);
    this._addEdge(this._cur, loopId);

    const exitId = this._addNode('STATEMENT', 'for_exit', null, null);
    this._addEdge(loopId, exitId, 'false_branch', 'false');

    const body = inner.children?.statement?.[0];
    if (body) {
      this._cur = loopId;
      this._visitNode(body);
      this._addEdge(this._cur, loopId, 'loop_back');
    }

    this._cur = exitId;
  }

  _visitEnhancedFor(node) {
    this._cc++;
    const loopId = this._addNode('LOOP', 'for-each', lineOf(node), null);
    this._addEdge(this._cur, loopId);
    const exitId = this._addNode('STATEMENT', 'foreach_exit', null, null);
    this._addEdge(loopId, exitId, 'false_branch', 'false');
    const body = node.children?.statement?.[0];
    if (body) { this._cur = loopId; this._visitNode(body); this._addEdge(this._cur, loopId, 'loop_back'); }
    this._cur = exitId;
  }

  _visitWhile(node) {
    // children: While, LBrace, expression, RBrace, statement
    const exprNode = node.children?.expression?.[0];
    const cond = exprNode ? allTokenImages(exprNode).join(' ').slice(0, 200) : '';
    this._branches += 2; this._condCount++; this._cc++;
    this._registerCond(cond);

    const loopId = this._addNode('LOOP', `while (${cond})`, lineOf(node), cond);
    this._addEdge(this._cur, loopId);

    const exitId = this._addNode('STATEMENT', 'while_exit', null, null);
    this._addEdge(loopId, exitId, 'false_branch', 'false');

    const body = node.children?.statement?.[0];
    if (body) { this._cur = loopId; this._visitNode(body); this._addEdge(this._cur, loopId, 'loop_back'); }

    this._cur = exitId;
  }

  _visitDo(node) {
    const exprNode = node.children?.expression?.[0];
    const cond = exprNode ? allTokenImages(exprNode).join(' ').slice(0, 200) : '';
    this._branches += 2; this._condCount++; this._cc++;

    const bodyId = this._addNode('STATEMENT', 'do_body', lineOf(node), null);
    this._addEdge(this._cur, bodyId);
    this._cur = bodyId;
    if (node.children?.statement?.[0]) this._visitNode(node.children.statement[0]);

    const checkId = this._addNode('BRANCH', `while (${cond})`, null, cond);
    this._addEdge(this._cur, checkId);
    this._addEdge(checkId, bodyId, 'loop_back', 'true');

    const exitId = this._addNode('STATEMENT', 'do_exit', null, null);
    this._addEdge(checkId, exitId, 'false_branch', 'false');
    this._cur = exitId;
  }

  _visitSwitch(node) {
    const exprNode = node.children?.expression?.[0];
    const expr = exprNode ? allTokenImages(exprNode).join(' ').slice(0, 100) : '';
    const switchId = this._addNode('SWITCH', `switch (${expr})`, lineOf(node), null);
    this._addEdge(this._cur, switchId);

    const mergeId = this._addNode('STATEMENT', 'switch_merge', null, null);
    const groups = findAll(node, 'switchBlockStatementGroup');
    this._cc += Math.max(1, groups.length);

    for (const g of groups) {
      this._cur = switchId;
      this._visitNode(g);
      this._addEdge(this._cur, mergeId);
    }
    this._cur = mergeId;
  }

  _visitTry(node) {
    const tryId = this._addNode('TRY', 'try', lineOf(node), null);
    this._addEdge(this._cur, tryId);
    this._cur = tryId;

    const block = node.children?.block?.[0];
    if (block) this._visitNode(block);

    const mergeId = this._addNode('STATEMENT', 'try_merge', null, null);
    this._addEdge(this._cur, mergeId);

    for (const c of node.children?.catchClause ?? []) {
      this._cc++;
      const catchId = this._addNode('CATCH', 'catch', lineOf(c), null);
      this._addEdge(tryId, catchId, 'exception');
      this._cur = catchId;
      const cb = findFirst(c, 'block');
      if (cb) this._visitNode(cb);
      this._addEdge(this._cur, mergeId);
    }

    const fin = node.children?.['finally']?.[0] ?? node.children?.['finally_']?.[0];
    if (fin) { this._cur = mergeId; this._visitNode(fin); }
    this._cur = mergeId;
  }

  _visitReturn(node) {
    const retId = this._addNode('RETURN', 'return', lineOf(node), null);
    this._addEdge(this._cur, retId);
    this._cur = retId;
  }

  _visitThrow(node) {
    const throwId = this._addNode('THROW', 'throw', lineOf(node), null);
    this._addEdge(this._cur, throwId, 'exception');
    this._cur = throwId;
  }

  _visitStatementExpr(node) {
    // Detect method calls
    const primaries = findAll(node, 'primary');
    for (const p of primaries) {
      // Look for methodInvocationSuffix which indicates a call
      const miSuffix = findFirst(p, 'methodInvocationSuffix');
      if (miSuffix) {
        const prefix = findFirst(p, 'fqnOrRefType');
        const suffixes = p.children?.primarySuffix ?? [];
        const identifiers = [];
        if (prefix) {
          // collect identifiers from fqnOrRefType
          for (const id of findAll(prefix, 'Identifier')) identifiers.push(id.image);
        }
        // last primarySuffix with Identifier before methodInvocationSuffix
        for (const s of suffixes) {
          const id = s.children?.Identifier?.[0];
          if (id) identifiers.push(id.image);
        }
        const callee = identifiers.join('.');
        if (callee) {
          this._calls.push({ calleeName: callee, line: lineOf(node) });
          const callId = this._addNode('STATEMENT', `call: ${callee}`, lineOf(node), null);
          this._addEdge(this._cur, callId);
          this._cur = callId;
          return;
        }
      }
    }
    // Generic statement node
    const stmtId = this._addNode('STATEMENT', 'stmt', lineOf(node), null);
    this._addEdge(this._cur, stmtId);
    this._cur = stmtId;
  }

  _registerCond(expr) {
    if (!expr) return;
    this._conds.push(expr);
    const subConds = decomposeBoolean(expr);
    if (subConds.length >= 2) {
      const tt = buildTruthTable(subConds);
      this._mcdc.push({
        expression: expr,
        subConditions: subConds,
        truthTable: tt,
        mcdcPairs: computeMcdcPairs(subConds, tt),
      });
    }
  }

  result() {
    return {
      cfgNodes: this._nodes, cfgEdges: this._edges, callSites: this._calls,
      booleanConditions: this._conds,
      branchCount: this._branches, conditionCount: this._condCount,
      cyclomaticComplexity: this._cc, mcdcConditions: this._mcdc,
    };
  }
}

// ── MC/DC ─────────────────────────────────────────────────────────────────────

export function decomposeBoolean(expr) {
  if (!expr) return [];
  const stripped = expr.replace(/\(|\)/g, ' ');
  const parts = stripped.split(/&&|\|\|/);
  return [...new Set(
    parts.map(p => p.replace(/^[!\s]+/, '').trim())
         .filter(p => p.length > 1 && !/^\d+$/.test(p))
  )];
}

export function buildTruthTable(subConds) {
  const n = subConds.length;
  if (n > 8) return null;
  const rows = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const row = {};
    for (let i = 0; i < n; i++) row[subConds[i]] = !!(mask & (1 << i));
    rows.push(row);
  }
  return rows;
}

export function computeMcdcPairs(subConds, truthTable) {
  if (!truthTable) return null;
  const pairs = [];
  for (let i = 0; i < subConds.length; i++) {
    const cond = subConds[i];
    let found = false;
    for (let a = 0; a < truthTable.length && !found; a++) {
      for (let b = a + 1; b < truthTable.length && !found; b++) {
        const onlyI = subConds.every((c, j) => j === i || truthTable[a][c] === truthTable[b][c])
                   && truthTable[a][cond] !== truthTable[b][cond];
        if (onlyI) { pairs.push({ condition: cond, rowA: a, rowB: b }); found = true; }
      }
    }
  }
  return pairs;
}
