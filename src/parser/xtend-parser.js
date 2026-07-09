// src/parser/xtend-parser.js
// Xtend source parser
// Strategy: Xtend is syntactically very close to Java with extensions.
// We use a line-by-line structural parser (accurate pattern matching)
// covering: package, import, class/interface/enum, methods (def), fields,
// annotations, Javadoc, dispatch methods, extension methods, create functions.
//
// For CFG/MC/DC, we re-use the same BodyAnalyzer from java-parser after
// normalizing Xtend expressions to an analyzable form.

import { createDecision } from './java-parser.js';

// ── Public API ────────────────────────────────────────────────────────────────

export function parseXtend(source, filePath) {
  const result = {
    packageName: null,
    imports: [],
    classes: [],
    errors: [],
  };

  try {
    const parser = new XtendParser(source, filePath);
    parser.parse();
    result.packageName = parser.packageName;
    result.imports = parser.imports;
    result.classes = parser.classes;
    result.errors = parser.errors;
  } catch (e) {
    result.errors.push({ message: e.message, line: null });
  }

  return result;
}

// ── Parser ────────────────────────────────────────────────────────────────────

class XtendParser {
  constructor(source, filePath) {
    this.source = source;
    this.filePath = filePath;
    this.lines = source.split('\n');
    this.packageName = null;
    this.imports = [];
    this.classes = [];
    this.errors = [];
    this._pos = 0;
  }

  // ── Entry ─────────────────────────────────────────────────────────────────

  parse() {
    this._parseTopLevel();
  }

  _parseTopLevel() {
    let inMultilineComment = false;
    let pendingJavadoc = null;
    let pendingAnnotations = [];

    for (let i = 0; i < this.lines.length; i++) {
      const raw = this.lines[i];
      const line = raw.trim();

      // Multi-line comment tracking
      if (inMultilineComment) {
        if (line.includes('*/')) inMultilineComment = false;
        if (line.startsWith('*') || line.startsWith('/**') || line.endsWith('*/')) {
          // collect javadoc
          if (pendingJavadoc !== null) pendingJavadoc += '\n' + raw;
        }
        continue;
      }
      if (line.startsWith('/**')) {
        inMultilineComment = !line.includes('*/');
        pendingJavadoc = raw;
        if (!inMultilineComment && line.includes('*/')) {
          // single-line javadoc
        }
        continue;
      }
      if (line.startsWith('/*')) {
        inMultilineComment = !line.includes('*/');
        continue;
      }
      if (line.startsWith('//')) continue;
      if (line === '') { if (!pendingAnnotations.length) pendingJavadoc = null; continue; }

      // Package
      const pkgMatch = line.match(/^package\s+([\w.]+)/);
      if (pkgMatch) { this.packageName = pkgMatch[1]; continue; }

      // Import
      const importMatch = line.match(/^import\s+(static\s+)?([\w.*]+)/);
      if (importMatch) {
        this.imports.push({
          name: importMatch[2],
          isStatic: !!importMatch[1],
          isWildcard: importMatch[2].endsWith('*'),
        });
        continue;
      }

      // Annotation line
      const annMatch = line.match(/^@([\w.]+)/);
      if (annMatch) {
        pendingAnnotations.push(annMatch[1]);
        continue;
      }

      // Class / interface / enum / annotation declaration
      const classMatch = line.match(
        /^((?:(?:public|protected|private|abstract|final|static)\s+)*)(@\w+\s+)?(class|interface|enum|annotation)\s+(\w+)/
      );
      if (classMatch) {
        const cls = this._parseClass(i, classMatch, pendingAnnotations, pendingJavadoc);
        if (cls) {
          this.classes.push(cls);
          // Skip to end of class
          i = cls._endLine ?? i;
        }
        pendingAnnotations = [];
        pendingJavadoc = null;
        continue;
      }

      pendingAnnotations = [];
    }
  }

  // ── Class ─────────────────────────────────────────────────────────────────

  _parseClass(startLine, classMatch, parentAnnotations, javadoc) {
    const modifierStr = (classMatch[1] || '').trim();
    const modifiers = modifierStr.split(/\s+/).filter(Boolean);
    const kind = classMatch[3]; // class|interface|enum|annotation
    const name = classMatch[4];
    const packagePrefix = this.packageName ? `${this.packageName}.` : '';

    const lineText = this.lines[startLine];

    // Parse superclass / interfaces from declaration line
    const superclassMatch = lineText.match(/extends\s+([\w.<>, ]+?)(?=implements|{|$)/);
    const implementsMatch = lineText.match(/implements\s+([\w.<>, ]+?)(?={|$)/);

    const cls = {
      name,
      qualifiedName: `${packagePrefix}${name}`,
      packageName: this.packageName,
      kind: kind === 'class' ? 'xtend_class' : kind,
      isAbstract: modifiers.includes('abstract'),
      visibility: this._visibilityFrom(modifiers),
      annotations: [...parentAnnotations, ...this._extractInlineAnnotations(lineText)],
      javadoc: javadoc ?? null,
      lineStart: startLine + 1,
      lineEnd: null,
      superclass: superclassMatch ? superclassMatch[1].trim().split(/[<,]/)[0].trim() : null,
      interfaces: implementsMatch
        ? implementsMatch[1].split(',').map(s => s.trim().split('<')[0].trim()).filter(Boolean)
        : [],
      asilLevel: null,
      methods: [],
      fields: [],
      nestedClasses: [],
      _endLine: startLine,
    };
    cls.asilLevel = this._detectAsilLevel(cls.annotations, cls.javadoc);

    // Find class body — track brace depth
    let depth = 0;
    let bodyStarted = false;
    let pendingJavadoc = null;
    let pendingAnnotations = [];
    let inMultiComment = false;
    let inString = false;

    for (let i = startLine; i < this.lines.length; i++) {
      const raw = this.lines[i];
      let line = raw.trim();

      if (inMultiComment) {
        if (line.includes('*/')) { inMultiComment = false; }
        if (line.startsWith('*') || line.startsWith('/**')) {
          if (pendingJavadoc !== null) pendingJavadoc += '\n' + raw;
        }
        continue;
      }
      if (line.startsWith('/**')) {
        inMultiComment = !line.includes('*/');
        pendingJavadoc = raw;
        continue;
      }
      if (line.startsWith('/*')) { inMultiComment = !line.includes('*/'); continue; }
      if (line.startsWith('//')) continue;

      // Count braces — capture depth BEFORE this line
      const depthBefore = depth;
      for (const ch of raw) {
        if (ch === '{') { depth++; bodyStarted = true; }
        if (ch === '}') { depth--; }
      }

      if (!bodyStarted) { pendingAnnotations = []; continue; }

      if (depth <= 0 && bodyStarted) {
        cls._endLine = i;
        cls.lineEnd = i + 1;
        break;
      }

      // Parse direct members when depth was 1 at line start
      // (handles 'def foo() {' where { bumps depth to 2 mid-line)
      if (depthBefore !== 1) continue;

      // Annotation inside class
      const annMatch = line.match(/^@([\w.]+)/);
      if (annMatch) { pendingAnnotations.push(annMatch[1]); continue; }

      // Empty lines reset pending (if no annotations accumulating)
      if (line === '') {
        if (!pendingAnnotations.length) pendingJavadoc = null;
        continue;
      }

      // Method: def keyword or Java-style return-type + name(
      const methodResult = this._tryParseMethod(i, raw, line, pendingAnnotations, pendingJavadoc, cls.qualifiedName);
      if (methodResult) {
        cls.methods.push(methodResult.method);
        // Re-sync outer depth for lines skipped over
        for (let skip = i + 1; skip <= methodResult.endLine; skip++) {
          for (const ch of (this.lines[skip] ?? '')) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
          }
        }
        i = methodResult.endLine;
        pendingAnnotations = [];
        pendingJavadoc = null;
        continue;
      }

      // Field: val / var / type pattern
      const fieldResult = this._tryParseField(i, line, pendingAnnotations, cls);
      if (fieldResult) {
        cls.fields.push(fieldResult);
        pendingAnnotations = [];
        pendingJavadoc = null;
        continue;
      }

      pendingAnnotations = [];
    }

    return cls;
  }

  // ── Method parsing ────────────────────────────────────────────────────────

  _tryParseMethod(lineIdx, raw, line, annotations, javadoc, classQName) {
    // Xtend: def [override] [dispatch] [static] [returnType] methodName(...)
    // Java-style: [modifiers] returnType methodName([params]) [throws ...]
    const xtendDef = line.match(
      /^((?:(?:override|dispatch|static|public|protected|private|final|abstract)\s+)*)def\s+((?:[\w<>\[\],? ]+?)\s+)?(\w+)\s*\(([^)]*)\)/
    );
    const javaStyle = line.match(
      /^((?:(?:public|protected|private|static|final|abstract|synchronized|native)\s+)+)([\w<>\[\],? .]+?)\s+(\w+)\s*\(([^)]*)\)/
    );
    const ctorStyle = line.match(
      /^(?:public|protected|private)?\s*(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,. ]+)?\s*\{/
    );

    let name, returnType, paramStr, modifiers, isXtend = false;

    if (xtendDef) {
      isXtend = true;
      const modStr = (xtendDef[1] || '').trim();
      modifiers = modStr.split(/\s+/).filter(Boolean);
      returnType = (xtendDef[2] || 'void').trim() || 'void';
      name = xtendDef[3];
      paramStr = xtendDef[4];
    } else if (javaStyle) {
      const modStr = (javaStyle[1] || '').trim();
      modifiers = modStr.split(/\s+/).filter(Boolean);
      returnType = javaStyle[2].trim();
      name = javaStyle[3];
      paramStr = javaStyle[4];
    } else {
      return null;
    }

    const params = this._parseParams(paramStr);
    const signature = `${name}(${params.map(p => p.type).join(',')})`;
    const throws_ = (raw.match(/throws\s+([\w,. ]+?)(?:\{|$)/) || [])[1];
    const throwsList = throws_ ? throws_.split(',').map(s => s.trim()).filter(Boolean) : [];

    // Find method body end
    const { body, endLine, cfgData } = this._extractMethodBody(lineIdx);

    const asilLevel = this._detectAsilLevel(annotations, javadoc);

    return {
      method: {
        name,
        signature: `${signature}:${returnType}`,
        returnType,
        visibility: this._visibilityFrom(modifiers),
        isStatic: modifiers.includes('static'),
        isAbstract: modifiers.includes('abstract'),
        isOverride: modifiers.includes('override') || annotations.includes('Override'),
        annotations,
        parameters: params,
        throwsList,
        javadoc: javadoc ?? null,
        lineStart: lineIdx + 1,
        lineEnd: endLine + 1,
        asilLevel,
        ...cfgData,
      },
      endLine,
    };
  }

  _parseParams(paramStr) {
    if (!paramStr?.trim()) return [];
    const params = [];
    // Split by comma (naive, handles simple cases)
    const parts = paramStr.split(',');
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      // Xtend: Type name or extension Type name or (Type)=>ReturnType name
      // Java: @Ann Type name or Type... name
      const m = p.match(/(?:@\w+\s+)?([\w<>\[\].,? $]+?)\s+(\w+)\s*$/);
      if (m) {
        params.push({ name: m[2], type: m[1].trim(), annotations: [] });
      } else {
        params.push({ name: p, type: 'Object', annotations: [] });
      }
    }
    return params;
  }

  _extractMethodBody(startLine) {
    let depth = 0;
    let bodyLines = [];
    let bodyStarted = false;

    for (let i = startLine; i < this.lines.length; i++) {
      const raw = this.lines[i];
      for (const ch of raw) {
        if (ch === '{') { depth++; bodyStarted = true; }
        if (ch === '}') depth--;
      }
      bodyLines.push(raw);
      if (bodyStarted && depth <= 0) {
        const cfgData = analyzeXtendBody(bodyLines.join('\n'));
        return { body: bodyLines.join('\n'), endLine: i, cfgData };
      }
    }
    const cfgData = analyzeXtendBody(bodyLines.join('\n'));
    return { body: bodyLines.join('\n'), endLine: this.lines.length - 1, cfgData };
  }

  // ── Field parsing ─────────────────────────────────────────────────────────

  _tryParseField(lineIdx, line, annotations, cls) {
    // Xtend: val/var [Type] name [= value]
    // Java: [modifiers] Type name [= value];
    const xtendField = line.match(
      /^(val|var)\s+(?:([\w<>\[\],? .]+?)\s+)?(\w+)\s*(?:=|$)/
    );
    const javaField = line.match(
      /^((?:(?:public|protected|private|static|final|transient|volatile)\s+)+)([\w<>\[\],? .]+?)\s+(\w+)\s*(?:=|;)/
    );

    if (!xtendField && !javaField) return null;

    let type, name, isStatic, isFinal, visibility, modifiers;
    if (xtendField) {
      type = xtendField[2] || 'Object';
      name = xtendField[3];
      isFinal = xtendField[1] === 'val';
      isStatic = false;
      visibility = 'package';
      modifiers = [];
    } else {
      const modStr = (javaField[1] || '').trim();
      modifiers = modStr.split(/\s+/).filter(Boolean);
      type = javaField[2].trim();
      name = javaField[3];
      isFinal = modifiers.includes('final');
      isStatic = modifiers.includes('static');
      visibility = this._visibilityFrom(modifiers);
    }

    const initialValueMatch = line.match(/=\s*(.+?)(?:$|;)/);
    const initialValue = initialValueMatch ? initialValueMatch[1].trim().slice(0, 80) : null;

    return { name, type, visibility, isStatic, isFinal, annotations, initialValue, line: lineIdx + 1 };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _visibilityFrom(modifiers) {
    if (modifiers.includes('public')) return 'public';
    if (modifiers.includes('protected')) return 'protected';
    if (modifiers.includes('private')) return 'private';
    return 'package';
  }

  _extractInlineAnnotations(line) {
    const anns = [];
    const re = /@(\w+)/g;
    let m;
    while ((m = re.exec(line)) !== null) anns.push(m[1]);
    return anns;
  }

  _detectAsilLevel(annotations, javadoc) {
    const text = [...(annotations ?? []), javadoc ?? ''].join(' ');
    const match = text.match(/ASIL[_\s-]?([A-D]|QM)/i);
    return match ? `ASIL-${match[1].toUpperCase()}` : null;
  }
}

// ── Xtend Body CFG Analyzer ───────────────────────────────────────────────────
// Since we don't have a full Xtend AST, we do pattern-based CFG for UT coverage

function analyzeXtendBody(bodyText) {
  const lines = bodyText.split('\n');
  const cfgNodes = [];
  const cfgEdges = [];
  const callSites = [];
  const booleanConditions = [];
  const decisions = [];
  const mcdcConditions = [];
  let branchCount = 0;
  let conditionCount = 0;
  let cc = 1;
  let nodeIdx = 0;

  const addNode = (type, label, line, cond) => {
    const id = ++nodeIdx;
    cfgNodes.push({ id, nodeType: type, label, line, condition: cond, orderIdx: id });
    return id;
  };
  const addEdge = (f, t, type = 'sequential', cond = null) => {
    cfgEdges.push({ fromNode: f, toNode: t, edgeType: type, condition: cond });
  };

  // Helper to register a decision (v3 IR camelCase, MC/DC centralized in M6)
  const registerDecision = (kind, expr, line) => {
    if (!expr) return;
    booleanConditions.push(expr);
    branchCount += 2;
    const dec = createDecision(kind, expr, line);
    if (dec) {
      decisions.push(dec);
      conditionCount += dec.conditions.length;
    }
  };

  let prev = addNode('ENTRY', 'entry', null, null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // template IF («IF ...»)
    const tmplIfMatch = line.match(/^«IF\s+(.+?)»/);
    if (tmplIfMatch) {
      cc++;
      registerDecision('template_if', tmplIfMatch[1], i + 1);
      const n = addNode('BRANCH', `«IF ${tmplIfMatch[1]}»`, i + 1, tmplIfMatch[1]);
      addEdge(prev, n);
      const merge = addNode('STATEMENT', 'tmpl_if_merge', null, null);
      addEdge(n, merge, 'true_branch', 'true');
      addEdge(n, merge, 'false_branch', 'false');
      prev = merge;
      continue;
    }

    // template ELSEIF («ELSEIF ...»)
    const tmplElseIfMatch = line.match(/^«ELSEIF\s+(.+?)»/);
    if (tmplElseIfMatch) {
      cc++;
      registerDecision('template_elseif', tmplElseIfMatch[1], i + 1);
      const n = addNode('BRANCH', `«ELSEIF ${tmplElseIfMatch[1]}»`, i + 1, tmplElseIfMatch[1]);
      addEdge(prev, n);
      const merge = addNode('STATEMENT', 'tmpl_elseif_merge', null, null);
      addEdge(n, merge, 'true_branch', 'true');
      addEdge(n, merge, 'false_branch', 'false');
      prev = merge;
      continue;
    }

    // template ELSE («ELSE»)
    if (line.startsWith('«ELSE»')) {
      // else in template — no new decision, just a CFG branch indicator
      const n = addNode('STATEMENT', '«ELSE»', i + 1, null);
      addEdge(prev, n);
      prev = n;
      continue;
    }

    // template ENDIF («ENDIF»)
    if (line.startsWith('«ENDIF»')) {
      const n = addNode('STATEMENT', '«ENDIF»', i + 1, null);
      addEdge(prev, n);
      prev = n;
      continue;
    }

    // else-if expression
    const elseIfMatch = line.match(/^else\s+if\s*\((.+?)\)/);
    if (elseIfMatch) {
      cc++;
      registerDecision('else_if', elseIfMatch[1], i + 1);
      const n = addNode('BRANCH', `else if (${elseIfMatch[1]})`, i + 1, elseIfMatch[1]);
      addEdge(prev, n);
      const merge = addNode('STATEMENT', 'else_if_merge', null, null);
      addEdge(n, merge, 'true_branch', 'true');
      addEdge(n, merge, 'false_branch', 'false');
      prev = merge;
      continue;
    }

    // if expression
    const ifMatch = line.match(/^if\s*\((.+?)\)/);
    if (ifMatch) {
      const cond = ifMatch[1];
      cc++;
      registerDecision('if', cond, i + 1);
      const n = addNode('BRANCH', `if (${cond})`, i + 1, cond);
      addEdge(prev, n);
      const merge = addNode('STATEMENT', 'if_merge', null, null);
      addEdge(n, merge, 'true_branch', 'true');
      addEdge(n, merge, 'false_branch', 'false');
      prev = merge;
      continue;
    }

    // for/forEach iteration
    const forMatch = line.match(/^(?:for|forEach)\s*[\(\[]/);
    if (forMatch) {
      cc++;
      // Extract loop variable name as 'condition' text
      const varMatch = line.match(/^for\s*\((\w+)/);
      const loopVar = varMatch ? `iterate:${varMatch[1]}` : 'for-each';
      registerDecision('foreach', loopVar, i + 1);
      const n = addNode('LOOP', line.slice(0, 60), i + 1, loopVar);
      addEdge(prev, n);
      const exit = addNode('STATEMENT', 'loop_exit', null, null);
      addEdge(n, exit, 'false_branch', 'false');
      prev = exit;
      continue;
    }

    // while
    const whileMatch = line.match(/^while\s*\((.+?)\)/);
    if (whileMatch) {
      const cond = whileMatch[1];
      cc++;
      registerDecision('while', cond, i + 1);
      const n = addNode('LOOP', `while (${cond})`, i + 1, cond);
      addEdge(prev, n);
      const exit = addNode('STATEMENT', 'while_exit', null, null);
      addEdge(n, exit, 'false_branch', 'false');
      prev = exit;
      continue;
    }

    // ternary (balanced-scanner): return/val/var/assignment condition ? a : b
    const ternaryMatch = line.match(/(?:return|val|var|\w+\s*=)\s*(.*?)\s*\?\s/);
    if (ternaryMatch) {
      // Extract condition text before '?'
      const condCandidate = ternaryMatch[1];
      // Pick the rightmost top-level expression before '?'
      let depth = 0, condEnd = -1;
      for (let c = condCandidate.length - 1; c >= 0; c--) {
        if (condCandidate[c] === ')') depth++;
        if (condCandidate[c] === '(') depth--;
        if (depth === 0 && (condCandidate[c] === '(' || /\w/.test(condCandidate[c]))) {
          condEnd = c;
          break;
        }
      }
      const cond = condEnd >= 0
        ? condCandidate.slice(condEnd).trim()
        : condCandidate.trim();
      if (cond) {
        registerDecision('ternary', cond, i + 1);
        const n = addNode('BRANCH', `ternary: ${cond}`, i + 1, cond);
        addEdge(prev, n);
        const merge = addNode('STATEMENT', 'ternary_merge', null, null);
        addEdge(n, merge, 'true_branch', 'true');
        addEdge(n, merge, 'false_branch', 'false');
        prev = merge;
        continue;
      }
    }

    // switch
    const switchMatch = line.match(/^switch\s*\(/);
    if (switchMatch) {
      cc++;
      const n = addNode('SWITCH', line.slice(0, 60), i + 1, null);
      addEdge(prev, n);
      const merge = addNode('STATEMENT', 'switch_merge', null, null);
      addEdge(n, merge);
      prev = merge;
      continue;
    }

    // try
    if (line.startsWith('try')) {
      const n = addNode('TRY', 'try', i + 1, null);
      addEdge(prev, n);
      prev = n;
      continue;
    }

    // catch
    if (line.startsWith('catch')) {
      cc++;
      const n = addNode('CATCH', line.slice(0, 60), i + 1, null);
      addEdge(prev, n, 'exception');
      prev = n;
      continue;
    }

    // return
    if (line.startsWith('return')) {
      const n = addNode('RETURN', line.slice(0, 60), i + 1, null);
      addEdge(prev, n);
      prev = n;
      continue;
    }

    // throw
    if (line.startsWith('throw')) {
      const n = addNode('THROW', line.slice(0, 60), i + 1, null);
      addEdge(prev, n, 'exception');
      prev = n;
      continue;
    }

    // method call — avoid false positives on keywords and method decl signatures
    const XTEND_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'throw', 'try', 'catch']);
    if (!line.startsWith('//') && line.includes('(')) {
      const callMatch = line.match(/(\w+(?:\.\w+)*)\s*\(/);
      if (callMatch && !XTEND_KEYWORDS.has(callMatch[1])) {
        const callee = callMatch[1];
        callSites.push({ calleeName: callee, line: i + 1 });
        const n = addNode('STATEMENT', `call: ${callee}`, i + 1, null);
        addEdge(prev, n);
        prev = n;
      }
    }
  }

  const exit = addNode('EXIT', 'exit', null, null);
  addEdge(prev, exit);

  return {
    cfgNodes, cfgEdges, callSites,
    booleanConditions, decisions,
    branchCount, conditionCount,
    cyclomaticComplexity: cc, mcdcConditions,
  };
}
