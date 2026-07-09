// src/mcp/util.js
// Shared utility functions for MCP handlers

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Constants ────────────────────────────────────────────────────────────────────

export const MAX_SOURCE_LINES_PER_METHOD = 300;
export const MAX_CONTEXT_TOKENS = 4000;

// ── Context budget tracking ────────────────────────────────────────────────────

/**
 * Graduated context truncation for get_method_context response.
 * Drops least-essential data first, then more, to fit token budget.
 */
export function truncateContext(response, maxTokens = MAX_CONTEXT_TOKENS) {
  const budget = { max: maxTokens, used: estimateTokens(response), truncated: false, reason: null };
  if (budget.used <= maxTokens) {
    response.contextBudget = budget;
    return response;
  }

  // Stage 1: drop source code
  if (budget.used > maxTokens && response.method?.source) {
    delete response.method.source;
    budget.used = estimateTokens(response);
    budget.truncated = true;
    budget.reason = 'SOURCE_DROPPED';
  }

  // Stage 2: drop CFG nodes/edges
  if (budget.used > maxTokens && response.cfg) {
    delete response.cfg;
    budget.used = estimateTokens(response);
    budget.truncated = true;
    budget.reason = budget.reason ? 'CFG_DROPPED' : 'SOURCE_AND_CFG_DROPPED';
  }

  // Stage 3: drop calls
  if (budget.used > maxTokens && response.calls?.length > 0) {
    response.calls = [];
    budget.used = estimateTokens(response);
    budget.truncated = true;
    budget.reason = 'CALLS_DROPPED';
  }

  // Stage 4: drop decisions
  if (budget.used > maxTokens && response.decisions?.length > 0) {
    response.decisions = [];
    budget.used = estimateTokens(response);
    budget.truncated = true;
    budget.reason = 'DECISIONS_DROPPED';
  }

  response.contextBudget = budget;
  return response;
}

// ── HTML entity decoding ─────────────────────────────────────────────────────────

const HTML_ENTITIES = [
  [/&amp;lt;/g, '&lt;'],
  [/&amp;gt;/g, '&gt;'],
  [/&amp;amp;/g, '&amp;'],
  [/&amp;quot;/g, '"'],
  [/&#x27;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&amp;/g, '&'],
  [/&quot;/g, '"'],
];

/**
 * Decode HTML entities in a string.
 * Handles double-encoded entities too (e.g. &amp;lt; → &lt; → <).
 * Runs multiple passes until no more changes.
 */
export function decodeHtmlEntities(text) {
  if (typeof text !== 'string') return text;
  let prev;
  let result = text;
  do {
    prev = result;
    for (const [pattern, replacement] of HTML_ENTITIES) {
      result = result.replace(pattern, replacement);
    }
  } while (result !== prev);
  return result;
}

/**
 * Decode HTML entities in all items of a string array.
 */
export function decodeHtmlArray(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.map(decodeHtmlEntities);
}

/**
 * Decode HTML entities in an MC/DC conditions array (nested objects).
 */
export function decodeMcdcConditions(conditions) {
  if (!Array.isArray(conditions)) return conditions;
  return conditions.map(c => ({
    ...c,
    expression: decodeHtmlEntities(c.expression ?? ''),
    subConditions: Array.isArray(c.subConditions)
      ? c.subConditions.map(decodeHtmlEntities)
      : c.subConditions,
  }));
}

// ── Path-safe source file reader ─────────────────────────────────────────────────

/**
 * Read a range of lines from a source file with path traversal protection.
 *
 * @param {string} projectRoot  — absolute path to project root
 * @param {string} filePath     — relative path from project root
 * @param {number} [lineStart]  — 1-based start line
 * @param {number} [lineEnd]    — 1-based end line (inclusive)
 * @param {number} [maxLines]   — max lines to read (default 300)
 * @returns {{content: string, line_start: number, line_end: number,
 *            total_file_lines: number, truncated: boolean,
 *            truncation_reason?: string} | {error: string, pathTraversalRejected?: boolean}}
 */
export function readSourceRange(projectRoot, filePath, lineStart, lineEnd, maxLines = MAX_SOURCE_LINES_PER_METHOD) {
  // 1. Normalise and resolve paths
  const root = resolve(projectRoot);
  const resolved = resolve(root, filePath);

  // 2. Path traversal check — resolved MUST be under projectRoot
  const rootWithSep = root.endsWith('/') ? root : root + '/';
  if (!resolved.startsWith(rootWithSep) && resolved !== root) {
    return { error: 'Path traversal detected: file outside project root', pathTraversalRejected: true };
  }

  // 3. Read file
  let content;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch (e) {
    return { error: `Cannot read file: ${e.message}` };
  }

  // 4. Extract lines (1-based line numbers)
  const lines = content.split('\n');
  const startIdx = Math.max(0, (lineStart || 1) - 1);
  const requestedEnd = lineEnd ? Math.min(lineEnd, lines.length) : lines.length;
  const budgetEnd = Math.min(requestedEnd, startIdx + maxLines);

  const sourceLines = lines.slice(startIdx, budgetEnd);
  const truncated = budgetEnd < requestedEnd;  // true only if we hit the line cap before requested end

  return {
    content: sourceLines.join('\n'),
    line_start: startIdx + 1,
    line_end: budgetEnd,
    total_file_lines: lines.length,
    truncated,
    truncation_reason: truncated ? 'MAX_SOURCE_LINES_PER_METHOD_EXCEEDED' : null,
  };
}

// ── Parse quality builder ─────────────────────────────────────────────────────────

/**
 * Build a parse_quality object from a method record.
 * Expanded in v1.3.0 with more checks (HTML_ENTITY_DETECTED, UNBALANCED_PARENTHESIS, etc.)
 *
 * @param {object} method  — method record (from DB or MCP)
 * @returns {{status: string, warnings: string[]}}
 */
export function buildParseQuality(method) {
  const warnings = [];
  if (!method) return { status: 'ok', warnings: [] };

  if (method.branch_count > 0 && method.condition_count === 0) {
    warnings.push('BRANCH_WITHOUT_EXTRACTED_CONDITION');
  }

  // Check boolean conditions for potential quality issues
  const conditions = method.boolean_conditions ?? [];
  if (Array.isArray(conditions)) {
    for (const cond of conditions) {
      if (typeof cond === 'string') {
        // Check for unbalanced parentheses
        let depth = 0;
        for (const ch of cond) {
          if (ch === '(') depth++;
          if (ch === ')') depth--;
        }
        if (depth !== 0) {
          warnings.push('UNBALANCED_PARENTHESIS');
          break;
        }
      }
    }
  }

  return {
    status: warnings.length > 0 ? 'warning' : 'ok',
    warnings,
  };
}

// ── Boundary value hints ─────────────────────────────────────────────────────────

/**
 * Compute boundary value hints for method parameters based on comparison conditions.
 * @param {object[]} decisions — array of decision objects with conditions
 * @param {object[]} parameters — method parameters [{name, type}]
 * @returns {object[]} — [{paramName, type, boundaries: [{expr, value, category}]}]
 */
export function computeBoundaryHints(decisions, parameters) {
  const hints = [];
  for (const param of parameters ?? []) {
    const boundaries = [];
    const paramName = param.name;
    const paramType = param.type;
    if (!paramName || /^(String|boolean|Boolean|List|Set|Map|void)/.test(paramType)) continue;

    for (const dec of decisions ?? []) {
      for (const cond of dec.conditions ?? []) {
        const text = cond.text ?? '';
        // Match patterns: paramName >= N, paramName > N, etc.
        const patterns = [
          { re: new RegExp(`\\b${paramName}\\s*>=\\s*(\\d+)`), cat: 'lower' },
          { re: new RegExp(`\\b${paramName}\\s*>\\s*(\\d+)`), cat: 'lower_exclusive' },
          { re: new RegExp(`\\b${paramName}\\s*<=\\s*(\\d+)`), cat: 'upper' },
          { re: new RegExp(`\\b${paramName}\\s*<\\s*(\\d+)`), cat: 'upper_exclusive' },
          { re: new RegExp(`\\b${paramName}\\s*==\\s*(\\d+)`), cat: 'equality' },
          { re: new RegExp(`\\b${paramName}\\s*!=\\s*(\\d+)`), cat: 'inequality' },
        ];
        for (const { re, cat } of patterns) {
          const m = text.match(re);
          if (m) {
            const val = parseInt(m[1], 10);
            boundaries.push({ expr: m[0], value: val, category: cat });
          }
        }
      }
    }

    if (boundaries.length > 0) {
      const values = new Set();
      for (const b of boundaries) {
        values.add(b.value);
        values.add(b.value - 1);
        values.add(b.value + 1);
      }
      // Common integer extremes for testing
      values.add(0);
      values.add(-1);
      values.add(2147483647);  // Integer.MAX_VALUE equivalent
      values.add(-2147483648); // Integer.MIN_VALUE equivalent

      hints.push({
        paramName,
        type: paramType,
        boundaries: boundaries.sort((a, b) => a.value - b.value),
        suggestedTestValues: [...values].filter(v => Number.isFinite(v)).sort((a, b) => a - b),
      });
    }
  }
  return hints;
}

// ── Recommended next actions ──────────────────────────────────────────────────────

/**
 * Generate context-sensitive recommended_next_actions based on current tool and context.
 *
 * @param {string} currentTool  — the tool that was just called
 * @param {object} context      — { methodId?, qualifiedName? }
 * @returns {Array<{tool: string, input: object, reason: string}>}
 */
export function recommendedNextActions(currentTool, context = {}) {
  const actions = [];
  const { methodId, qualifiedName } = context;

  if (methodId && currentTool !== 'get_method_context') {
    actions.push({
      tool: 'get_method_context',
      input: { method_id: methodId },
      reason: 'Get full source and execution context for this method',
    });
  }

  if (methodId && currentTool !== 'get_decisions') {
    actions.push({
      tool: 'get_decisions',
      input: { method_id: methodId },
      reason: 'View decision-level condition decomposition for MC/DC',
    });
  }

  if (methodId && currentTool !== 'get_mcdc') {
    actions.push({
      tool: 'get_mcdc',
      input: { methodId },
      reason: 'Analyse MC/DC coverage requirements for this method',
    });
  }

  if (qualifiedName && currentTool !== 'get_ut_context') {
    actions.push({
      tool: 'get_ut_context',
      input: { qualifiedName },
      reason: 'Get complete UT generation context for the class',
    });
  }

  if (methodId && currentTool !== 'get_coverage_summary') {
    actions.push({
      tool: 'get_coverage_summary',
      input: { methodId },
      reason: 'View JaCoCo coverage data for this method',
    });
  }

  if (qualifiedName && currentTool !== 'export_evidence_plan') {
    actions.push({
      tool: 'export_evidence_plan',
      input: { qualifiedName, asilLevel: 'D' },
      reason: 'Generate ISO 26262 evidence package for this class',
    });
  }

  if (qualifiedName && currentTool !== 'get_methods') {
    actions.push({
      tool: 'get_methods',
      input: { qualifiedName },
      reason: 'List all methods in this class with signatures',
    });
  }

  return actions;
}

/**
 * Compute a rough token estimate for a response object.
 * Used to enforce MAX_CONTEXT_TOKENS budget.
 *
 * @param {object} obj  — response object to estimate
 * @returns {number}  — estimated token count
 */
export function estimateTokens(obj) {
  try {
    const json = JSON.stringify(obj);
    return Math.ceil(json.length / 3.5);
  } catch {
    return Infinity;
  }
}
