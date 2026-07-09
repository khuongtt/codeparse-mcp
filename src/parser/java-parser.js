// src/parser/java-parser.js
// Accurate Java CST → Graph parser using the 'java-parser' npm package.
// Node names verified against actual CST output.

import { parse as javaParse } from 'java-parser';
import { createDecision } from './decision-utils.js';

// Re-export for Xtend parser which imports createDecision from here
export { createDecision };

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

// ── HTML entity decoder (inline to avoid cross-dependency during parsing) ──

function decodeHtmlEntities(text) {
  if (typeof text !== 'string') return text;
  const map = {
    '&amp;lt;': '&lt;', '&amp;gt;': '&gt;', '&amp;amp;': '&amp;', '&amp;quot;': '"',
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'",
  };
  let prev, result = text;
  do {
    prev = result;
    for (const [pat, val] of Object.entries(map)) {
      result = result.replaceAll(pat, val);
    }
  } while (result !== prev);
  return result;
}

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
  return toks.map(t => decodeHtmlEntities(t.image));
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
    const clsFields = this._currentClass()?.fields ?? [];
    const cfgData = body ? analyzeBody(body, clsFields) : emptyCfg();

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
    cyclomaticComplexity: 1, decisions: [], mcdcConditions: [],
  };
}

function analyzeBody(bodyNode, classFields = []) {
  const a = new BodyAnalyzer(classFields);
  a.analyze(bodyNode);
  return a.result();
}

class BodyAnalyzer {
  constructor(classFields = []) {
    this._nodes = []; this._edges = []; this._calls = [];
    this._conds = []; this._mcdc = []; this._decisions = [];
    this._branches = 0; this._condCount = 0; this._cc = 1;
    this._idx = 0;
    this._cur = this._addNode('ENTRY', 'entry', null, null);
    this._fieldAccesses = [];
    this._classFields = classFields; // [{name, type}] for field name matching
    this._localVars = new Set(); // track local variable declarations
  }

  _addNode(type, label, line, cond, exceptionType) {
    const id = ++this._idx;
    this._nodes.push({ id, nodeType: type, label, line, condition: cond, exceptionType: exceptionType ?? null, orderIdx: id });
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
      case 'conditionalExpression': this._visitConditionalExpr(node); return;
      case 'localVariableDeclarationStatement': this._visitLocalVarDecl(node); return;
    }
    if (node.children) for (const arr of Object.values(node.children)) for (const c of arr) this._visitNode(c);
  }

  _visitLocalVarDecl(node) {
    const decl = findFirst(node, 'localVariableDeclaration');
    if (!decl) return;
    for (const vd of findAll(decl, 'variableDeclarator')) {
      const name = vd.children?.variableDeclaratorId?.[0]?.children?.Identifier?.[0]?.image;
      if (name) this._localVars.add(name);
    }
    // Still recurse into variable initializer for nested expressions
    if (node.children) for (const arr of Object.values(node.children)) for (const c of arr) this._visitNode(c);
  }

  _visitIf(node, parentIsElseIf = false) {
    // children: If, LBrace, expression, RBrace, statement (then), [Else, statement (else)]
    const exprNode = node.children?.expression?.[0];
    const cond = exprNode ? allTokenImages(exprNode).join(' ').slice(0, 200) : '';
    const stmts = node.children?.statement ?? [];

    this._cc++;
    const kind = parentIsElseIf ? 'else_if' : 'if';
    this._registerDecision(kind, cond, lineOf(node));

    const branchId = this._addNode('BRANCH', `${kind} (${cond})`, lineOf(node), cond);
    this._addEdge(this._cur, branchId);

    const mergeId = this._addNode('STATEMENT', 'merge', null, null);

    // true branch
    this._cur = branchId;
    if (stmts[0]) this._visitNode(stmts[0]);
    this._addEdge(this._cur, mergeId, 'true_branch', 'true');

    // false branch
    if (stmts[1]) { // else exists
      // Check if else clause is just another ifStatement (else if)
      const elseStmt = stmts[1];
      const stmtChildren = elseStmt?.children?.statement ?? [];
      const isElseIfChild = !!(stmtChildren[0] && stmtChildren[0].name === 'ifStatement');

      this._cur = branchId;
      if (isElseIfChild) {
        this._visitIf(stmtChildren[0], true);
      } else {
        this._visitNode(stmts[1]);
      }
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
    this._cc++;
    if (cond) {
      this._registerDecision('for', cond, lineOf(node));
    }

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
    this._cc++;
    this._registerDecision('while', cond, lineOf(node));

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
    this._cc++;
    this._registerDecision('do', cond, lineOf(node));

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

    const clauses = node.children?.catches?.[0]?.children?.catchClause ?? node.children?.catchClause ?? [];
    for (const c of clauses) {
      this._cc++;
      // Extract exception type from catch clause
      const catchType = findFirst(c, 'catchType');
      let exceptionType = null;
      if (catchType) {
        const ct = findFirst(catchType, 'unannClassType');
        if (ct) exceptionType = allTokenImages(ct).filter(t => !/^[.\s]+$/.test(t)).join('.');
      }
      const catchId = this._addNode('CATCH', 'catch', lineOf(c), null, exceptionType);
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
    // Recurse into expression children to detect decisions (ternary, etc.)
    const exprChildren = node.children?.expression ?? [];
    for (const expr of exprChildren) this._visitNode(expr);
    const retId = this._addNode('RETURN', 'return', lineOf(node), null);
    this._addEdge(this._cur, retId);
    this._cur = retId;
  }

  _visitThrow(node) {
    // Extract exception type from throw expression
    const exprNode = node.children?.expression?.[0];
    let exceptionType = null;
    if (exprNode) {
      const toks = allTokenImages(exprNode);
      // Find class name after 'new' keyword
      const newIdx = toks.indexOf('new');
      if (newIdx >= 0 && newIdx + 1 < toks.length) {
        exceptionType = toks.slice(newIdx + 1).find(t => /^\w/.test(t) && !/^[a-z]/.test(t));
      }
    }
    const throwId = this._addNode('THROW', 'throw', lineOf(node), null, exceptionType);
    this._addEdge(this._cur, throwId, 'exception');
    this._cur = throwId;
  }

  _visitStatementExpr(node) {
    const allToks = allTokenImages(node);
    const line = lineOf(node);

    // Detect field write: varName = expr (not a local decl)
    // Find assignment operator '='
    const assignIdx = allToks.indexOf('=');
    if (assignIdx > 0) {
      const target = allToks[assignIdx - 1];
      // Check if target is a known field (not local variable)
      if (target && !this._localVars.has(target) && this._isLikelyField(target)) {
        const isThisPrefix = allToks.slice(0, assignIdx).filter(t => t !== '.').join('.');
        const fieldName = isThisPrefix.startsWith('this.') ? isThisPrefix.replace(/^this\./, '') : target;
        this._fieldAccesses.push({ fieldName, accessType: 'write', line });
      }
    }

    // Detect field read via this.field (skip assignment target — already registered as write)
    const assignField = assignIdx > 0 ? allToks.slice(0, assignIdx).filter(t => t !== '.').join('.').replace(/^this\./, '') : null;
    for (let i = 0; i < allToks.length - 1; i++) {
      if (allToks[i] === 'this' && allToks[i + 1] === '.') {
        let idx = i + 2;
        while (idx < allToks.length && allToks[idx] === '.') idx++;
        if (idx < allToks.length && idx > i + 2) continue; // compound this.foo.bar
        if (idx < allToks.length && /^\w+$/.test(allToks[idx]) && !/^[A-Z]/.test(allToks[idx])) {
          const fname = allToks[idx];
          if (fname === assignField) continue; // skip assignment target
          this._fieldAccesses.push({ fieldName: fname, accessType: 'read', line });
        }
      }
    }

    // Detect method calls (existing logic)
    const primaries = findAll(node, 'primary');
    for (const p of primaries) {
      const miSuffix = findFirst(p, 'methodInvocationSuffix');
      if (miSuffix) {
        const prefix = findFirst(p, 'fqnOrRefType');
        const suffixes = p.children?.primarySuffix ?? [];
        const identifiers = [];
        if (prefix) {
          for (const id of findAll(prefix, 'Identifier')) identifiers.push(id.image);
        }
        for (const s of suffixes) {
          const id = s.children?.Identifier?.[0];
          if (id) identifiers.push(id.image);
        }
        const callee = identifiers.join('.');
        if (callee) {
          this._calls.push({ calleeName: callee, line });
          // Detect field read via prefix: obj.field.method()
          if (identifiers.length >= 2 && !identifiers.includes('this')) {
            const candidateField = identifiers[0];
            if (this._isLikelyField(candidateField) && !this._localVars.has(candidateField)) {
              this._fieldAccesses.push({ fieldName: candidateField, accessType: 'read', line });
            }
          }
          const callId = this._addNode('STATEMENT', `call: ${callee}`, line, null);
          this._addEdge(this._cur, callId);
          this._cur = callId;
          return;
        }
      }
    }

    // Generic statement node
    const stmtId = this._addNode('STATEMENT', 'stmt', line, null);
    this._addEdge(this._cur, stmtId);
    this._cur = stmtId;
  }

  _isLikelyField(name) {
    if (!name || /^[A-Z]/.test(name) || /^['"]/.test(name)) return false;
    return this._classFields.some(f => f.name === name);
  }

  /**
   * Register a decision with its boolean expression.
   * Creates a IR-shaped decision object (camelCase). MC/DC pair computation
   * is centralized in ir-ingest.js (M6) — only condition decomposition here.
   */
  _registerDecision(kind, expression, line) {
    if (!expression) return;
    this._conds.push(expression);
    this._branches += 2;

    const decision = createDecision(kind, expression, line);
    if (decision) {
      this._decisions.push(decision);
      this._condCount += decision.conditions.length;
    }
  }

  /**
   * Handle ternary expressions (ConditionalExpr): condition ? trueVal : falseVal
   * CST: binaryExpression ? expression : expression
   * Recurses into true/false branches to support nested ternary.
   */
  _visitConditionalExpr(node) {
    const children = node.children ?? {};
    const condNode = children.binaryExpression?.[0];

    if (!condNode || !children.Colon) {
      for (const arr of Object.values(children)) {
        for (const c of arr) this._visitNode(c);
      }
      return;
    }

    // Extract condition text
    const condText = allTokenImages(condNode).join(' ').slice(0, 200);
    if (condText) {
      this._registerDecision('ternary', condText, lineOf(node));
    }
    this._cc++;

    const branchId = this._addNode('BRANCH', `ternary: ${condText}`, lineOf(node), condText || null);
    this._addEdge(this._cur, branchId);

    // True branch — recuse into true expression (index 1 in children)
    const trueExpr = children.expression?.[1];
    if (trueExpr) {
      this._cur = branchId;
      this._visitNode(trueExpr);
    }
    const mergeId = this._addNode('STATEMENT', 'ternary_merge', null, null);
    this._addEdge(this._cur, mergeId, 'true_branch', 'true');

    // False branch — recuse into false expression (index 2 in children)
    const falseExpr = children.expression?.[2];
    if (falseExpr) {
      this._cur = branchId;
      this._visitNode(falseExpr);
    }
    this._addEdge(this._cur, mergeId, 'false_branch', 'false');

    this._cur = mergeId;
  }

  result() {
    return {
      cfgNodes: this._nodes, cfgEdges: this._edges, callSites: this._calls,
      booleanConditions: this._conds,
      decisions: this._decisions,
      branchCount: this._branches, conditionCount: this._condCount,
      cyclomaticComplexity: this._cc, mcdcConditions: this._mcdc,
      fieldAccesses: this._fieldAccesses,
    };
  }
}

// ── MC/DC ─────────────────────────────────────────────────────────────────────
// decomposeBoolean, buildTruthTable, computeMcdcPairs moved to decision-utils.js.
// Re-exported above for xtend-parser.js compatibility.
