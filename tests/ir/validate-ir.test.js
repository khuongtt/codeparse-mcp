// tests/ir/validate-ir.test.js
// Tests for the Decision IR validator.

import { describe, it } from 'node:test';
import { strictEqual, deepEqual } from 'node:assert';
import { validateIr, assertValidIr } from '../../src/ir/validate-ir.js';

function makeValidIr() {
  return {
    irVersion: '1.0',
    sourceLanguage: 'java',
    filePath: 'Test.java',
    packageName: 'com.example',
    classes: [
      {
        name: 'Test',
        qualifiedName: 'com.example.Test',
        kind: 'class',
        methods: [
          {
            name: 'foo',
            signature: 'foo():void',
            decisions: [],
            cfg: { nodes: [], edges: [] },
            calls: [],
          },
        ],
      },
    ],
  };
}

describe('validate-ir', () => {
  it('passes valid IR', () => {
    const result = validateIr(makeValidIr());
    strictEqual(result.valid, true);
    strictEqual(result.errors.length, 0);
  });

  it('rejects null IR', () => {
    const result = validateIr(null);
    strictEqual(result.valid, false);
  });

  it('rejects missing irVersion', () => {
    const ir = makeValidIr();
    delete ir.irVersion;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
    deepEqual(result.errors, ['irVersion is required']);
  });

  it('rejects missing sourceLanguage', () => {
    const ir = makeValidIr();
    delete ir.sourceLanguage;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects invalid sourceLanguage', () => {
    const ir = makeValidIr();
    ir.sourceLanguage = 'python';
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects missing filePath', () => {
    const ir = makeValidIr();
    delete ir.filePath;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects empty classes array', () => {
    const ir = makeValidIr();
    ir.classes = [];
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects missing class name', () => {
    const ir = makeValidIr();
    delete ir.classes[0].name;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects missing class qualifiedName', () => {
    const ir = makeValidIr();
    delete ir.classes[0].qualifiedName;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects missing method name', () => {
    const ir = makeValidIr();
    delete ir.classes[0].methods[0].name;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('rejects missing method signature', () => {
    const ir = makeValidIr();
    delete ir.classes[0].methods[0].signature;
    const result = validateIr(ir);
    strictEqual(result.valid, false);
  });

  it('validates a decision with conditions', () => {
    const ir = makeValidIr();
    ir.classes[0].methods[0].decisions = [
      {
        kind: 'if',
        expression: 'a && b',
        normalized: 'C1 && C2',
        lineStart: 5,
        lineEnd: 5,
        branchCount: 2,
        mcdcRequired: true,
        parseStatus: 'ok',
        conditions: [
          { position: 1, text: 'a', normalizedText: 'a', conditionType: 'atomic', parseStatus: 'ok' },
          { position: 2, text: 'b', normalizedText: 'b', conditionType: 'atomic', parseStatus: 'ok' },
        ],
      },
    ];
    const result = validateIr(ir);
    strictEqual(result.valid, true);
  });

  it('warns on mcdcRequired mismatch', () => {
    const ir = makeValidIr();
    ir.classes[0].methods[0].decisions = [
      {
        kind: 'if',
        expression: 'a',
        branchCount: 2,
        mcdcRequired: true, // wrong: only 1 condition
        conditions: [
          { position: 1, text: 'a', conditionType: 'atomic', parseStatus: 'ok' },
        ],
      },
    ];
    const result = validateIr(ir);
    strictEqual(result.valid, true); // warnings don't fail validation
    strictEqual(result.warnings.length >= 1, true);
  });

  it('warns on unknown decision kind', () => {
    const ir = makeValidIr();
    ir.classes[0].methods[0].decisions = [
      {
        kind: 'weird',
        expression: 'a',
        branchCount: 2,
        mcdcRequired: false,
        conditions: [{ position: 1, text: 'a', conditionType: 'atomic', parseStatus: 'ok' }],
      },
    ];
    const result = validateIr(ir);
    strictEqual(result.valid, true);
    strictEqual(result.warnings.some(w => w.includes('not standard')), true);
  });

  it('assertValidIr throws on invalid', () => {
    const ir = makeValidIr();
    delete ir.irVersion;
    try {
      assertValidIr(ir);
      strictEqual(true, false); // should not reach
    } catch (e) {
      strictEqual(e.message.includes('IR validation failed'), true);
    }
  });
});
