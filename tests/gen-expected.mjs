import fs from 'fs';
import { parseJava } from './src/parser/java-parser.js';
import { parseXtend } from './src/parser/xtend-parser.js';

function stripIrrelevant(parsed) {
  return {
    packageName: parsed.packageName,
    classes: parsed.classes.map(c => ({
      name: c.name, kind: c.kind,
      methods: c.methods.map(m => ({
        name: m.name, signature: m.signature,
        cyclomaticComplexity: m.cyclomaticComplexity,
        branchCount: m.branchCount, conditionCount: m.conditionCount,
        decisions: m.decisions.map(d => ({
          kind: d.kind, expression: d.expression, normalized: d.normalized,
          operator: d.operator ?? null, lineStart: d.lineStart ?? null,
          branchCount: d.branchCount ?? 0, mcdcRequired: d.mcdcRequired ?? false,
          conditions: d.conditions.map(c => ({
            text: c.text, normalizedText: c.normalizedText ?? null,
            position: c.position, conditionType: c.conditionType ?? 'atomic',
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

const javaSrc = fs.readFileSync('tests/parser-regression/fixtures/SampleJava.java', 'utf8');
fs.writeFileSync('tests/parser-regression/SampleJava.java.expected.json',
  JSON.stringify(stripIrrelevant(parseJava(javaSrc, 'fixtures/SampleJava.java')), null, 2));

const xtendSrc = fs.readFileSync('tests/parser-regression/fixtures/SampleXtend.xtend', 'utf8');
fs.writeFileSync('tests/parser-regression/SampleXtend.xtend.expected.json',
  JSON.stringify(stripIrrelevant(parseXtend(xtendSrc, 'fixtures/SampleXtend.xtend')), null, 2));

console.log('Done');
