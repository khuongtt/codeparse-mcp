// src/parser/decision-utils.js
// Shared logic for creating decision/condition objects from boolean expressions.
// Used by both Java and Xtend parsers.

// ── Boolean expression decomposition ─────────────────────────────────────────

/**
 * Decompose a boolean expression into atomic sub-condition identifiers.
 * Splits on && and ||, strips parentheses and leading negation.
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
  if (n > 8) return null;
  const rows = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const row = {};
    for (let i = 0; i < n; i++) row[subConds[i]] = !!(mask & (1 << i));
    rows.push(row);
  }
  return rows;
}

/**
 * Compute MC/DC independence pairs from a truth table.
 * @param {string[]} subConds
 * @param {object[]} truthTable
 * @returns {object[]|null}
 */
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

// ── Decision/condition creation ──────────────────────────────────────────────

/**
 * Detect the boolean operator in a compound expression.
 * @param {string} expr
 * @returns {'AND'|'OR'|'MIXED'|null}
 */
function detectOperator(expr) {
  if (!expr) return null;
  const hasAnd = /\b&&\b/.test(expr);
  const hasOr = /\b\|\|\b/.test(expr);
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
 * Create a decision object from a boolean expression.
 *
 * @param {string} kind    — decision kind: if|while|for|do|switch|ternary|return|assignment
 * @param {string} expression — full boolean expression text
 * @param {number|null} line  — source line number
 * @returns {object|null} decision object with { kind, expression, normalized, operator,
 *          line_start, branch_count: 2, mcdc_required, conditions, parse_status }
 */
export function createDecision(kind, expression, line) {
  if (!expression) return null;

  // Decompose into atomic sub-conditions
  const atomicTexts = decomposeBoolean(expression);

  // Build condition objects — use original text before normalizeConditionText strips !
  const conditions = atomicTexts.map((text, i) => ({
    text: text,
    normalized: normalizeConditionText(text),
    position: i + 1,
    condition_type: detectConditionType(text),
    parse_status: 'ok',
  }));

  const operator = detectOperator(expression);
  const normalized = conditions.length >= 2
    ? buildNormalized(conditions.length, operator)
    : expression;

  return {
    kind,
    expression,
    normalized,
    operator,
    line_start: line,
    branch_count: 2,
    mcdc_required: conditions.length >= 2,
    conditions,
    parse_status: 'ok',
  };
}
