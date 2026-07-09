// src/parser/decision-utils.js
// Shared logic for creating decision/condition objects from boolean expressions.
// Used by both Java and Xtend parsers.

// ── Boolean AST (recursive descent, preserves structure) ─────────────────────
// Operator precedence: || < && < unary ! < atom
// This replaces the old strip-all-parens-then-split approach for MIXED expressions.

/**
 * Tokenize a boolean expression into atoms, operators, parens, and negation.
 * Splits ONLY on boolean operators (&&, ||, parens). '!' is only a token
 * when NOT followed by '=' (to avoid breaking != into ! and =).
 * Everything between them is one atom (e.g. "a >= min", "i % 2 == 0").
 */
function tokenize(expr) {
  const tokens = [];
  const re = /(\&\&|\|\||[()])|(!(?!=))/g;
  let last = 0;
  let m;
  while ((m = re.exec(expr)) !== null) {
    // Text before the operator/paren
    const before = expr.slice(last, m.index).trim();
    if (before) tokens.push(before);
    tokens.push(m[0]);
    last = m.index + m[0].length;
  }
  const after = expr.slice(last).trim();
  if (after) tokens.push(after);
  return tokens.filter(t => t !== '');
}

/**
 * Parse a boolean expression string into an AST.
 *
 * Returns: { op: '||'|'&&', left, right }
 *      or: { op: '!', child }
 *      or: { atom: string }          (leaf)
 */
export function parseBooleanExpr(expr) {
  if (!expr) return null;
  const tokens = tokenize(expr);
  if (!tokens.length) return null;
  let pos = 0;

  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function consume() { return tokens[pos++]; }

  function parseOr() {
    let left = parseAnd();
    while (peek() === '||') { consume(); left = { op: '||', left, right: parseAnd() }; }
    return left;
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek() === '&&') { consume(); left = { op: '&&', left, right: parseUnary() }; }
    return left;
  }

  function parseUnary() {
    if (peek() === '!') { consume(); return { op: '!', child: parseUnary() }; }
    return parseAtom();
  }

  function parseAtom() {
    if (peek() === '(') { consume(); const node = parseOr(); if (peek() === ')') consume(); return node; }
    const tok = consume();
    return { atom: tok };
  }

  return tokens.length ? parseOr() : null;
}

/**
 * Collect all operators present in an AST.
 */
function collectOps(tree) {
  if (!tree || tree.atom !== undefined) return new Set();
  if (tree.op === '!') return collectOps(tree.child);
  const ops = new Set([tree.op]);
  for (const op of collectOps(tree.left)) ops.add(op);
  for (const op of collectOps(tree.right)) ops.add(op);
  return ops;
}

/**
 * Check if an AST contains mixed operators (both && and ||).
 */
function isMixed(tree) {
  if (!tree || tree.atom !== undefined || tree.op === '!') return false;
  return collectOps(tree).size > 1;
}

/**
 * Evaluate an AST against a condition-value map.
 * @param {object} tree — AST node from parseBooleanExpr
 * @param {object} vals — { conditionName: boolean }
 * @returns {boolean}
 */
export function evalTree(tree, vals) {
  if (!tree) return false;
  if (tree.atom !== undefined) return !!vals[tree.atom];
  if (tree.op === '!') return !evalTree(tree.child, vals);
  if (tree.op === '&&') return evalTree(tree.left, vals) && evalTree(tree.right, vals);
  if (tree.op === '||') return evalTree(tree.left, vals) || evalTree(tree.right, vals);
  return false;
}

/**
 * Extract all atomic condition texts from an AST in order.
 * Handles single-letter names, parens, negation — all tree forms.
 */
function extractAtoms(tree) {
  if (!tree) return [];
  if (tree.atom !== undefined) return [tree.atom.trim()];
  if (tree.op === '!') return extractAtoms(tree.child);
  return [...extractAtoms(tree.left), ...extractAtoms(tree.right)];
}

/**
 * Detect the top-level operator(s) from an AST.
 * Returns: 'AND' | 'OR' | 'MIXED' | null
 */
function detectOperatorFromTree(tree) {
  if (!tree || tree.atom !== undefined || tree.op === '!') return null;
  if (isMixed(tree)) return 'MIXED';
  return tree.op === '&&' ? 'AND' : 'OR';
}

/**
 * Recursively replace atoms with C1, C2, ... in an AST.
 */
function replaceAtoms(tree, condMap) {
  if (!tree) return tree;
  if (tree.atom !== undefined) {
    const name = condMap.get(tree.atom);
    return name ? { atom: name } : tree;
  }
  if (tree.op === '!') return { op: '!', child: replaceAtoms(tree.child, condMap) };
  return { op: tree.op, left: replaceAtoms(tree.left, condMap), right: replaceAtoms(tree.right, condMap) };
}

/**
 * Serialize an AST back to a string expression.
 */
function treeToString(tree) {
  if (!tree) return '';
  if (tree.atom !== undefined) return tree.atom;
  if (tree.op === '!') return '!' + (tree.child.atom !== undefined ? tree.child.atom : '(' + treeToString(tree.child) + ')');
  const l = tree.left.atom !== undefined ? treeToString(tree.left) : '(' + treeToString(tree.left) + ')';
  const r = tree.right.atom !== undefined ? treeToString(tree.right) : '(' + treeToString(tree.right) + ')';
  return l + ' ' + tree.op + ' ' + r;
}

/**
 * Build a normalized form for MIXED expressions.
 * Maps original condition text → C1, C2, ... and serializes the substituted tree.
 */
export function buildNormalizedFromTree(tree, conditions) {
  const condMap = new Map();
  conditions.forEach((c, i) => condMap.set(c.text, `C${i + 1}`));
  const substituted = replaceAtoms(tree, condMap);
  return treeToString(substituted);
}

// ── Boolean expression decomposition (backward-compatible) ──────────────────

/**
 * Decompose a boolean expression into atomic sub-condition identifiers.
 * Strips parens and negation, splits on && and ||.
 * Returns unique non-trivial sub-condition identifiers.
 *
 * @param {string} expr — boolean expression text
 * @returns {string[]} — array of atomic condition texts
 */
export function decomposeBoolean(expr) {
  if (!expr) return [];
  const stripped = expr.replace(/\(|\)/g, ' ');
  const parts = stripped.split(/&&|\|\|/);
  return [...new Set(
    parts.map(p => p.replace(/^[!\s]+/, '').trim())
         .filter(p => p.length > 1 && !/^\d+$/.test(p))
  )];
}

/**
 * Build a truth table for a set of sub-conditions.
 * @param {string[]} subConds
 * @returns {object[]|null} — array of { [condName]: boolean } or null if too many
 */
export function buildTruthTable(subConds) {
  const n = subConds.length;
  if (n > 12) return null; // 2^12=4096 rows — practical limit for in-memory
  const rows = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const row = {};
    for (let i = 0; i < n; i++) row[subConds[i]] = !!(mask & (1 << i));
    rows.push(row);
  }
  return rows;
}

/**
 * Compute true MC/DC independence pairs from a truth table.
 * Only returns pairs where outcomes differ (true independence).
 * Uses operator-aware outcome evaluation: AND = all true, OR = any true,
 * MIXED = AST-based evaluation (requires tree param).
 *
 * @param {string[]} subConds
 * @param {object[]} truthTable
 * @param {string} [operator] — 'AND' | 'OR' | 'MIXED' | null
 * @param {object} [tree] — AST from parseBooleanExpr, required for MIXED
 * @returns {object[]|null}
 */
export function computeMcdcPairs(subConds, truthTable, operator = null, tree = null) {
  if (!truthTable) return null;
  const pairs = [];

  const outcome = (row) => {
    if (operator === 'AND') {
      const vals = subConds.map(c => row[c]);
      return vals.every(Boolean) ? 1 : 0;
    }
    if (operator === 'OR') {
      const vals = subConds.map(c => row[c]);
      return vals.some(Boolean) ? 1 : 0;
    }
    if (operator === 'MIXED' && tree) {
      // Build { conditionName: bool } map from truth table row
      // row keys are normalizedText — use as-is for evalTree
      return evalTree(tree, row) ? 1 : 0;
    }
    // Default: first condition decides
    return row[subConds[0]] ? 1 : 0;
  };

  for (let i = 0; i < subConds.length; i++) {
    const cond = subConds[i];
    let found = false;
    for (let a = 0; a < truthTable.length && !found; a++) {
      for (let b = a + 1; b < truthTable.length && !found; b++) {
        const onlyI = subConds.every((c, j) => j === i || truthTable[a][c] === truthTable[b][c])
                   && truthTable[a][cond] !== truthTable[b][cond];
        if (onlyI && outcome(truthTable[a]) !== outcome(truthTable[b])) {
          pairs.push({ condition: cond, rowA: a, rowB: b });
          found = true;
        }
      }
    }
  }
  return pairs;
}

// ── Decision/condition creation ──────────────────────────────────────────────

/**
 * Detect the boolean operator in a compound expression.
 * Uses AST tree when available for accurate MIXED detection.
 * @param {string} expr — expression text (fallback for simple cases)
 * @param {object|null} tree — AST from parseBooleanExpr (preferred)
 * @returns {'AND'|'OR'|'MIXED'|null}
 */
function detectOperator(expr, tree = null) {
  if (tree) return detectOperatorFromTree(tree);
  if (!expr) return null;
  const hasAnd = /&&/.test(expr);
  const hasOr = /\|\|/.test(expr);
  if (hasAnd && hasOr) return 'MIXED';
  if (hasAnd) return 'AND';
  if (hasOr) return 'OR';
  return null;
}

/**
 * Detect if an atomic condition text starts with negation.
 * @param {string} text
 * @returns {'negated'|'atomic'}
 */
function detectConditionType(text) {
  return text.trim().startsWith('!') ? 'negated' : 'atomic';
}

/**
 * Strip leading negation and whitespace for normalized form.
 * @param {string} text
 * @returns {string}
 */
function normalizeConditionText(text) {
  return text.replace(/^[!\s]+/, '').trim();
}

/**
 * Build a normalized expression string (C1 && C2, etc.)
 */
function buildNormalized(count, operator) {
  if (count < 2) return '';
  const names = Array.from({ length: count }, (_, i) => `C${i + 1}`);
  if (operator === 'AND') return names.join(' && ');
  if (operator === 'OR') return names.join(' || ');
  return names.join(' && ');
}

/**
 * Create a Decision IR (camelCase) decision object from a boolean expression.
 * This is the v3 IR shape — used as the contract between parsers/extractors and DB ingest.
 *
 * @param {string} kind    — decision kind: if|while|for|do|switch|ternary|...
 * @param {string} expression — full boolean expression text
 * @param {number|null} line  — source line number
 * @returns {object|null} decision object with { kind, expression, normalized, operator,
 *          lineStart, lineEnd, branchCount, mcdcRequired, conditions, parseStatus, tree }
 */
export function createDecision(kind, expression, line) {
  if (!expression) return null;

  const tree = parseBooleanExpr(expression);
  // Use AST tree for atom extraction (handles single-letter conditions,
  // parenthesized nesting, negation; decomposeBoolean regex approach fails on these)
  // Use Set to dedup — same atom text = same condition for MC/DC purposes
  const atomicTexts = tree
    ? [...new Set(extractAtoms(tree))]
    : decomposeBoolean(expression);

  const conditions = atomicTexts.map((text, i) => ({
    text,
    normalizedText: normalizeConditionText(text),
    position: i + 1,
    conditionType: detectConditionType(text),
    parseStatus: 'ok',
  }));

  const operator = detectOperator(expression, tree);
  const normalized = conditions.length >= 2
    ? (operator === 'MIXED' && tree
        ? buildNormalizedFromTree(tree, conditions)
        : buildNormalized(conditions.length, operator))
    : expression;

  return {
    kind,
    expression,
    normalized,
    operator,
    tree: tree ?? undefined,
    lineStart: line,
    lineEnd: line,
    branchCount: 2,
    mcdcRequired: conditions.length >= 2,
    conditions,
    parseStatus: 'ok',
  };
}
