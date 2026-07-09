// src/ir/validate-ir.js
// Validates Decision IR objects against the method-ir.schema.json contract.
// Returns structured { valid, errors, warnings } for use by ir-ingest.js.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schemas', 'method-ir.schema.json');

let schema = null;

function loadSchema() {
  if (!schema) {
    try {
      schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    } catch {
      return null;
    }
  }
  return schema;
}

const VALID_KINDS = new Set([
  'if', 'else_if', 'template_if', 'template_elseif', 'ternary',
  'for', 'foreach', 'while', 'do_while', 'switch', 'case', 'catch',
]);

const VALID_LANGUAGES = new Set(['java', 'xtend']);
const VALID_PARSE_STATUSES = new Set(['ok', 'warning', 'error']);
const VALID_CONDITION_TYPES = new Set(['atomic', 'negated']);

/**
 * Validate a Decision IR object against the schema contract.
 *
 * @param {object} ir — parsed IR JSON object
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateIr(ir) {
  const errors = [];
  const warnings = [];

  if (!ir || typeof ir !== 'object') {
    return { valid: false, errors: ['IR must be a non-null object'], warnings: [] };
  }

  // ── Top-level required fields ──
  if (!ir.irVersion) errors.push('irVersion is required');
  if (ir.irVersion && !/^\d+\.\d+$/.test(ir.irVersion)) {
    errors.push(`irVersion must match semver pattern, got: ${ir.irVersion}`);
  }

  if (!ir.sourceLanguage) errors.push('sourceLanguage is required');
  else if (!VALID_LANGUAGES.has(ir.sourceLanguage)) {
    errors.push(`sourceLanguage must be one of [java, xtend], got: ${ir.sourceLanguage}`);
  }

  if (!ir.filePath) errors.push('filePath is required');

  if (!ir.classes || !Array.isArray(ir.classes) || ir.classes.length === 0) {
    errors.push('classes array is required and must contain at least one class');
  } else {
    // ── Per-class validation ──
    for (let ci = 0; ci < ir.classes.length; ci++) {
      const cls = ir.classes[ci];
      if (!cls.name) errors.push(`classes[${ci}].name is required`);
      if (!cls.qualifiedName) errors.push(`classes[${ci}].qualifiedName is required`);
      if (!cls.methods || !Array.isArray(cls.methods)) {
        errors.push(`classes[${ci}].methods is required`);
        continue;
      }

      // ── Per-method validation ──
      for (let mi = 0; mi < cls.methods.length; mi++) {
        const m = cls.methods[mi];
        if (!m.name) errors.push(`classes[${ci}].methods[${mi}].name is required`);
        if (!m.signature) errors.push(`classes[${ci}].methods[${mi}].signature is required`);

        if (m.decisions && Array.isArray(m.decisions)) {
          // ── Per-decision validation ──
          for (let di = 0; di < m.decisions.length; di++) {
            const d = m.decisions[di];
            if (!d.kind) errors.push(`classes[${ci}].methods[${mi}].decisions[${di}].kind is required`);
            else if (!VALID_KINDS.has(d.kind)) {
              warnings.push(`classes[${ci}].methods[${mi}].decisions[${di}].kind '${d.kind}' is not standard (expected one of: ${[...VALID_KINDS].join(', ')})`);
            }

            if (d.branchCount === undefined || d.branchCount === null) {
              errors.push(`classes[${ci}].methods[${mi}].decisions[${di}].branchCount is required`);
            } else if (d.branchCount < 2) {
              errors.push(`classes[${ci}].methods[${mi}].decisions[${di}].branchCount must be >= 2, got ${d.branchCount}`);
            }

            // mcdcRequired must match condition count
            if (d.conditions && Array.isArray(d.conditions)) {
              const expectedMcdc = d.conditions.length >= 2;
              if (d.mcdcRequired !== expectedMcdc) {
                warnings.push(`classes[${ci}].methods[${mi}].decisions[${di}].mcdcRequired is ${d.mcdcRequired} but condition count is ${d.conditions.length} (expected ${expectedMcdc})`);
              }

              // ── Per-condition validation ──
              for (let pos = 0; pos < d.conditions.length; pos++) {
                const c = d.conditions[pos];
                if (c.position === undefined || c.position === null) {
                  errors.push(`classes[${ci}].methods[${mi}].decisions[${di}].conditions[${pos}].position is required`);
                } else if (c.position < 1) {
                  errors.push(`classes[${ci}].methods[${mi}].decisions[${di}].conditions[${pos}].position must be >= 1, got ${c.position}`);
                }
                if (!c.text) {
                  errors.push(`classes[${ci}].methods[${mi}].decisions[${di}].conditions[${pos}].text is required`);
                }
                if (c.conditionType && !VALID_CONDITION_TYPES.has(c.conditionType)) {
                  warnings.push(`classes[${ci}].methods[${mi}].decisions[${di}].conditions[${pos}].conditionType '${c.conditionType}' is not standard`);
                }
              }

              // Check position ordering
              const positions = d.conditions.map(c => c.position).filter(p => p !== undefined);
              for (let p = 0; p < positions.length; p++) {
                if (positions[p] !== p + 1) {
                  warnings.push(`classes[${ci}].methods[${mi}].decisions[${di}].conditions positions should start at 1 and be sequential`);
                  break;
                }
              }
            }

            if (d.parseStatus && !VALID_PARSE_STATUSES.has(d.parseStatus)) {
              warnings.push(`classes[${ci}].methods[${mi}].decisions[${di}].parseStatus '${d.parseStatus}' is not standard`);
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Quick check: validate IR and throw if invalid.
 * Returns the IR if valid, for chainability.
 */
export function assertValidIr(ir) {
  const result = validateIr(ir);
  if (!result.valid) {
    throw new Error(`IR validation failed:\n  ${result.errors.join('\n  ')}`);
  }
  return ir;
}
