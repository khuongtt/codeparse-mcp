import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBooleanExpr, evalTree, buildNormalizedFromTree,
  createDecision, computeMcdcPairs, buildTruthTable,
  decomposeBoolean,
} from '../../src/parser/decision-utils.js';

describe('parseBooleanExpr', () => {
  it('parses simple condition as atom', () => {
    const t = parseBooleanExpr('x > 0');
    assert.deepEqual(t, { atom: 'x > 0' });
  });

  it('parses a && b', () => {
    const t = parseBooleanExpr('a && b');
    assert.equal(t.op, '&&');
    assert.equal(t.left.atom, 'a');
    assert.equal(t.right.atom, 'b');
  });

  it('parses a || b', () => {
    const t = parseBooleanExpr('a || b');
    assert.equal(t.op, '||');
    assert.equal(t.left.atom, 'a');
    assert.equal(t.right.atom, 'b');
  });

  it('parses (a || b) && c', () => {
    const t = parseBooleanExpr('(a || b) && c');
    assert.equal(t.op, '&&');
    assert.equal(t.left.op, '||');
    assert.equal(t.left.left.atom, 'a');
    assert.equal(t.left.right.atom, 'b');
    assert.equal(t.right.atom, 'c');
  });

  it('parses a && b || c (OR top-level)', () => {
    const t = parseBooleanExpr('a && b || c');
    assert.equal(t.op, '||');
    assert.equal(t.left.op, '&&');
    assert.equal(t.left.left.atom, 'a');
    assert.equal(t.left.right.atom, 'b');
    assert.equal(t.right.atom, 'c');
  });

  it('handles ! negation', () => {
    const t = parseBooleanExpr('!a && b');
    assert.equal(t.op, '&&');
    assert.equal(t.left.op, '!');
    assert.equal(t.left.child.atom, 'a');
    assert.equal(t.right.atom, 'b');
  });

  it('handles !a && b && !c', () => {
    const t = parseBooleanExpr('!a && b && !c');
    // Tree: ((!a) && b) && (!c) — left-associative &&
    assert.equal(t.op, '&&');
    assert.equal(t.left.op, '&&');      // (!a) && b
    assert.equal(t.left.left.op, '!');
    assert.equal(t.left.left.child.atom, 'a');
    assert.equal(t.left.right.atom, 'b');
    assert.equal(t.right.op, '!');
    assert.equal(t.right.child.atom, 'c');
  });

  it('handles conditions with comparison operators', () => {
    const t = parseBooleanExpr('x >= min && x <= max');
    assert.equal(t.op, '&&');
    assert.equal(t.left.atom, 'x >= min');
    assert.equal(t.right.atom, 'x <= max');
  });

  it('handles complex Java conditions', () => {
    // grade() from SampleJava: score >= 90 && score <= 100
    const t = parseBooleanExpr('score >= 90 && score <= 100');
    assert.equal(t.op, '&&');
    assert.equal(t.left.atom, 'score >= 90');
    assert.equal(t.right.atom, 'score <= 100');
  });

  it('handles != without splitting on !', () => {
    const t = parseBooleanExpr('a != null && b != 0');
    assert.equal(t.op, '&&');
    assert.equal(t.left.atom, 'a != null');
    assert.equal(t.right.atom, 'b != 0');
  });

  it('returns null for empty expression', () => {
    assert.equal(parseBooleanExpr(''), null);
    assert.equal(parseBooleanExpr(null), null);
  });
});

describe('evalTree', () => {
  it('evaluates simple atom', () => {
    const t = parseBooleanExpr('x > 0');
    assert.equal(evalTree(t, { 'x > 0': true }), true);
    assert.equal(evalTree(t, { 'x > 0': false }), false);
  });

  it('evaluates a && b', () => {
    const t = parseBooleanExpr('a && b');
    assert.equal(evalTree(t, { a: true, b: true }), true);
    assert.equal(evalTree(t, { a: true, b: false }), false);
    assert.equal(evalTree(t, { a: false, b: true }), false);
  });

  it('evaluates (a || b) && c', () => {
    const t = parseBooleanExpr('(a || b) && c');
    assert.equal(evalTree(t, { a: true, b: false, c: true }), true);
    assert.equal(evalTree(t, { a: false, b: false, c: true }), false);
    assert.equal(evalTree(t, { a: true, b: false, c: false }), false);
    assert.equal(evalTree(t, { a: false, b: true, c: true }), true);
  });

  it('evaluates a && b || c', () => {
    const t = parseBooleanExpr('a && b || c');
    assert.equal(evalTree(t, { a: true, b: true, c: false }), true);  // (T&&T)||F = T
    assert.equal(evalTree(t, { a: true, b: false, c: false }), false); // (T&&F)||F = F
    assert.equal(evalTree(t, { a: false, b: false, c: true }), true); // (F&&F)||T = T
    assert.equal(evalTree(t, { a: false, b: false, c: false }), false); // (F&&F)||F = F
  });

  it('evaluates ! negation', () => {
    const t = parseBooleanExpr('!a && b');
    assert.equal(evalTree(t, { a: false, b: true }), true);
    assert.equal(evalTree(t, { a: true, b: true }), false);
  });
});

describe('createDecision with MIXED', () => {
  it('detects MIXED for (a || b) && c', () => {
    const d = createDecision('if', '(a || b) && c', 1);
    assert.equal(d.operator, 'MIXED');
    assert.ok(d.tree);
    assert.equal(d.tree.op, '&&');
  });

  it('detects MIXED for a && b || c', () => {
    const d = createDecision('if', 'a && b || c', 1);
    assert.equal(d.operator, 'MIXED');
    assert.ok(d.tree);
    assert.equal(d.tree.op, '||');
  });

  it('detects AND (not MIXED) for a && b', () => {
    const d = createDecision('if', 'a && b', 1);
    assert.equal(d.operator, 'AND');
    assert.ok(d.tree);
  });

  it('detects OR (not MIXED) for a || b', () => {
    const d = createDecision('if', 'a || b', 1);
    assert.equal(d.operator, 'OR');
    assert.ok(d.tree);
  });

  it('normalized uses tree form for MIXED', () => {
    const d = createDecision('if', '(a || b) && c', 1);
    assert.equal(d.operator, 'MIXED');
    assert.ok(d.normalized.includes('||'));
  });
});

describe('MC/DC pairs with MIXED', () => {
  it('computes MC/DC pairs for (cond1 || cond2) && cond3', () => {
    const d = createDecision('if', '(cond1 || cond2) && cond3', 1);
    assert.equal(d.operator, 'MIXED');
    assert.ok(d.conditions.length >= 2);

    const subConds = d.conditions.map(c => c.normalizedText || c.text);
    const tt = buildTruthTable(subConds);
    const pairs = computeMcdcPairs(subConds, tt, d.operator, d.tree);

    assert.ok(pairs, 'should produce MC/DC pairs');
    assert.ok(pairs.length > 0, 'should have at least one independence pair');
  });

  it('MC/DC for cond1 && cond2 || cond3 uses correct outcome evaluation', () => {
    const d = createDecision('if', 'cond1 && cond2 || cond3', 1);
    assert.equal(d.operator, 'MIXED');

    const subConds = d.conditions.map(c => c.normalizedText || c.text);
    const tt = buildTruthTable(subConds);
    const pairs = computeMcdcPairs(subConds, tt, d.operator, d.tree);

    assert.ok(pairs, 'should produce MC/DC pairs');
    assert.ok(pairs.length > 0, 'MIXED should have MC/DC pairs');
  });

  it('AND condition still produces correct MC/DC pairs', () => {
    const d = createDecision('if', 'cond1 && cond2 && cond3', 1);
    assert.equal(d.operator, 'AND');
    const subConds = d.conditions.map(c => c.normalizedText || c.text);
    const tt = buildTruthTable(subConds);
    const pairs = computeMcdcPairs(subConds, tt, d.operator, d.tree);

    assert.ok(pairs);
    assert.equal(pairs.length, 3); // 3 conditions, each should have 1 pair
  });
});

describe('decomposeBoolean backward compat', () => {
  it('still works for expressions with multi-char conditions', () => {
    const parts = decomposeBoolean('foo && bar');
    assert.deepEqual(parts, ['foo', 'bar']);
  });

  it('filters out single-letter tokens (limitation)', () => {
    const parts = decomposeBoolean('a && b');
    assert.deepEqual(parts, []); // single-char filtered by length > 1 check
  });
});
