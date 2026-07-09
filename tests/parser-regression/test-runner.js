// tests/parser-regression/test-runner.js
// Regression test runner for codeparse parsers.
// Parses fixture files and compares output to frozen expected JSON.
// Run: node --test tests/parser-regression/test-runner.js

import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJava } from '../../src/parser/java-parser.js';
import { parseXtend } from '../../src/parser/xtend-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, 'fixtures');
const expectedDir = __dirname;

function stripIrrelevant(parsed) {
  // Keep only fields meaningful for regression comparison
  return {
    packageName: parsed.packageName,
    classes: parsed.classes.map(c => ({
      name: c.name,
      kind: c.kind,
      methods: c.methods.map(m => ({
        name: m.name,
        signature: m.signature,
        cyclomaticComplexity: m.cyclomaticComplexity,
        branchCount: m.branchCount,
        conditionCount: m.conditionCount,
        decisions: m.decisions.map(d => ({
          kind: d.kind,
          expression: d.expression,
          normalized: d.normalized,
          operator: d.operator ?? null,
          lineStart: d.lineStart ?? null,
          branchCount: d.branchCount ?? 0,
          mcdcRequired: d.mcdcRequired ?? false,
          conditions: d.conditions.map(c => ({
            text: c.text,
            normalizedText: c.normalizedText ?? null,
            position: c.position,
            conditionType: c.conditionType ?? 'atomic',
            parseStatus: c.parseStatus ?? 'ok',
          })),
          parseStatus: d.parseStatus ?? 'ok',
        })),
        booleanConditions: (m.booleanConditions ?? m.boolean_conditions ?? []),
        cfgNodeCount: (m.cfgNodes ?? []).length,
        cfgEdgeCount: (m.cfgEdges ?? []).length,
        callSiteCount: (m.callSites ?? []).length,
        mcdcConditionCount: (m.mcdcConditions ?? []).length,
      })),
    })),
    errors: parsed.errors,
  };
}

function loadExpected(name) {
  const path = resolve(expectedDir, name);
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('Java parser regression', () => {
  it('SampleJava.java matches expected output', () => {
    const src = readFileSync(resolve(fixturesDir, 'SampleJava.java'), 'utf8');
    const result = parseJava(src, 'fixtures/SampleJava.java');
    const stripped = stripIrrelevant(result);
    const expected = loadExpected('SampleJava.java.expected.json');
    deepStrictEqual(stripped, expected);
  });
});

describe('Xtend parser regression', () => {
  it('SampleXtend.xtend matches expected output', () => {
    const src = readFileSync(resolve(fixturesDir, 'SampleXtend.xtend'), 'utf8');
    const result = parseXtend(src, 'fixtures/SampleXtend.xtend');
    const stripped = stripIrrelevant(result);
    const expected = loadExpected('SampleXtend.xtend.expected.json');
    deepStrictEqual(stripped, expected);
  });
});
