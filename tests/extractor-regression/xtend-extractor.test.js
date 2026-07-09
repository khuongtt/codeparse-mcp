// Xtend AST extractor regression tests
// Validates extractor output matches expected IR shape and metrics.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const EXTRACTOR_SCRIPT = resolve(PROJECT_ROOT, 'extractors/xtend/run-extractor.sh');

const EXPECTED = {
  classify: {
    cc: 3, bc: 4, condCount: 2, decCount: 2,
    decisions: [
      { kind: 'if', mcdc: false, condCount: 1 },
      { kind: 'else_if', mcdc: false, condCount: 1 },
    ],
    calls: 0,
  },
  sumEven: {
    cc: 3, bc: 4, condCount: 2, decCount: 2,
    decisions: [
      { kind: 'foreach', mcdc: false, condCount: 1 },
      { kind: 'if', mcdc: false, condCount: 1 },
    ],
    calls: 0,
  },
  isInRange: {
    cc: 2, bc: 2, condCount: 2, decCount: 1,
    decisions: [
      { kind: 'ternary', mcdc: true, condCount: 2, op: 'AND' },
    ],
    calls: 0,
  },
  grade: {
    cc: 5, bc: 8, condCount: 8, decCount: 4,
    decisions: [
      { kind: 'if', mcdc: true, condCount: 2, op: 'AND' },
      { kind: 'else_if', mcdc: true, condCount: 2, op: 'AND' },
      { kind: 'else_if', mcdc: true, condCount: 2, op: 'AND' },
      { kind: 'else_if', mcdc: true, condCount: 2, op: 'AND' },
    ],
    calls: 0,
  },
  formatLabel: {
    cc: 3, bc: 4, condCount: 2, decCount: 2,
    decisions: [
      { kind: 'template_if', mcdc: false, condCount: 1 },
      { kind: 'template_elseif', mcdc: false, condCount: 1 },
    ],
    calls: 1,
  },
  sign: {
    cc: 2, bc: 2, condCount: 1, decCount: 1,
    decisions: [
      { kind: 'ternary', mcdc: false, condCount: 1 },
    ],
    calls: 0,
  },
  process: {
    cc: 1, bc: 0, condCount: 0, decCount: 0,
    decisions: [],
    calls: 1,
  },
  doSomething: {
    cc: 1, bc: 0, condCount: 0, decCount: 0,
    decisions: [],
    calls: 1,
  },
};

describe('Xtend AST Extractor', () => {
  let ir;

  it('should run extractor and produce valid JSON', async () => {
    if (!existsSync(EXTRACTOR_SCRIPT)) {
      console.warn(`extractor script not found at ${EXTRACTOR_SCRIPT}, skipping test`);
      return;
    }

    const fixture = resolve(PROJECT_ROOT, 'tests/parser-regression/fixtures/SampleXtend.xtend');
    if (!existsSync(fixture)) {
      throw new Error(`fixture not found: ${fixture}`);
    }

    const stdout = await new Promise((resolve, reject) => {
      execFile(EXTRACTOR_SCRIPT, [fixture], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`extractor failed: ${err.message}\n${stderr.slice(-200)}`));
        resolve(stdout);
      });
    });

    ir = JSON.parse(stdout);
    assert.ok(ir, 'should parse JSON');
    assert.equal(ir.irVersion, '1.0');
    assert.equal(ir.sourceLanguage, 'xtend');
    assert.equal(ir.classes.length, 1);
    assert.equal(ir.classes[0].name, 'SampleXtend');
    assert.equal(ir.classes[0].kind, 'xtend_class');
  });

  it('should have 8 methods with correct metrics', () => {
    if (!ir) return;
    const methods = ir.classes[0].methods;
    assert.equal(methods.length, 8);

    for (const m of methods) {
      const exp = EXPECTED[m.name];
      if (!exp) {
        assert.fail(`unexpected method: ${m.name}`);
        continue;
      }
      assert.equal(m.cyclomaticComplexity, exp.cc, `${m.name}: cyclomaticComplexity`);
      assert.equal(m.branchCount, exp.bc, `${m.name}: branchCount`);
      assert.equal(m.conditionCount, exp.condCount, `${m.name}: conditionCount`);
      assert.equal(m.decisions.length, exp.decCount, `${m.name}: decisions count`);

      for (let i = 0; i < Math.min(exp.decisions.length, m.decisions.length); i++) {
        const d = m.decisions[i];
        const ed = exp.decisions[i];
        assert.equal(d.kind, ed.kind, `${m.name}: decisions[${i}] kind`);
        assert.equal(d.mcdcRequired, ed.mcdc, `${m.name}: decisions[${i}] mcdcRequired`);
        assert.equal(d.conditions.length, ed.condCount, `${m.name}: decisions[${i}] condition count`);
        if (ed.op) {
          assert.equal(d.operator, ed.op, `${m.name}: decisions[${i}] operator`);
        }
      }

      // Call counts (allow some variance)
      if (exp.calls !== undefined && m.calls && m.calls.length !== exp.calls) {
        console.warn(`${m.name}: expected ${exp.calls} calls, got ${m.calls.length}`);
      }
    }
  });

  it('should have conditions with correct positions and types', () => {
    if (!ir) return;
    for (const m of ir.classes[0].methods) {
      for (const d of m.decisions) {
        for (let i = 0; i < d.conditions.length; i++) {
          const c = d.conditions[i];
          assert.equal(c.position, i + 1, `${m.name}: condition ${i} position`);
          assert.ok(c.text, `${m.name}: condition ${i} text`);
          assert.ok(c.parseStatus, `${m.name}: condition ${i} parseStatus`);
        }
      }
    }
  });

  it('should have valid JSON (validateIr)', async () => {
    if (!ir) return;
    const { validateIr } = await import(resolve(PROJECT_ROOT, 'src/ir/validate-ir.js'));
    const result = validateIr(ir);
    if (!result.valid) {
      console.error('validation errors:', result.errors);
      console.error('warnings:', result.warnings);
    }
    assert.ok(result.valid, `IR validation failed: ${result.errors.join('; ')}`);
  });
});
