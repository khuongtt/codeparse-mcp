// src/export/evidence-writer.js
// Orchestrates the generation of the full 10-file ISO 26262 evidence package

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createDecisionList, createMcdcMatrix, createTestMapping,
         createRequirementTraceability, createTechReviewChecklist,
         createProcessSafetyReviewChecklist, createAuditSummary } from './evidence-excel.js';

// ── Static files ──────────────────────────────────────────────────────────────

const TOOL_LIMITATION_STATEMENT = `# Tool Limitation Statement

codeparse-mcp is used as an analysis and evidence preparation aid.
The tool extracts candidate decisions and conditions, generates draft MC/DC
independence pairs, and prepares context for AI-assisted JUnit generation.

Final MC/DC acceptance, requirement adequacy, and safety compliance approval
remain the responsibility of independent human reviewers.

JaCoCo coverage is used for C0/C1/branch evidence only and is not claimed as
standalone proof of MC/DC.

---

Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}
`;

const COVERAGE_HTML_TEMPLATE = (clsName, methods, coverageRecords) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Coverage Report - ${clsName}</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 20px; }
  h1 { color: #333; border-bottom: 2px solid #4472C4; padding-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th { background: #D9E1F2; font-weight: bold; text-align: left; padding: 8px; border: 1px solid #ccc; }
  td { padding: 6px 8px; border: 1px solid #ddd; }
  .bar { height: 16px; background: #e0e0e0; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; }
  .green { background: #4caf50; }
  .yellow { background: #ffc107; }
  .red { background: #f44336; }
  .na { color: #999; font-style: italic; }
  tr:nth-child(even) { background: #f8f9fa; }
</style>
</head>
<body>
<h1>Coverage Report</h1>
<p><strong>Class:</strong> ${clsName}</p>
<p><strong>Source:</strong> JaCoCo</p>
<table>
  <tr>
    <th>Method</th>
    <th>Line Coverage</th>
    <th>Branch Coverage</th>
    <th>Instruction Coverage</th>
    <th>Lines</th>
    <th>Branches</th>
  </tr>
  ${coverageRecords.length === 0 ? '<tr><td colspan="6">No coverage data imported. Run: codeparse import-results --jacoco &lt;path&gt;</td></tr>' : ''}
  ${coverageRecords.map(cr => {
    const barColor = (v) => v >= 80 ? 'green' : (v >= 50 ? 'yellow' : 'red');
    const bar = (v) => v != null
      ? '<div class="bar"><div class="bar-fill ' + barColor(v) + '" style="width:' + v + '%"></div></div>'
      : '<span class="na">N/A</span>';
    return '<tr><td>' + (cr.method_name || '?') + '</td>' +
      '<td>' + (cr.line_coverage != null ? bar(cr.line_coverage) + ' ' + cr.line_coverage + '%' : '<span class="na">N/A</span>') + '</td>' +
      '<td>' + (cr.branch_coverage != null ? bar(cr.branch_coverage) + ' ' + cr.branch_coverage + '%' : '<span class="na">N/A</span>') + '</td>' +
      '<td>' + (cr.instruction_coverage != null ? cr.instruction_coverage + '%' : '<span class="na">N/A</span>') + '</td>' +
      '<td>' + (cr.covered_lines || 0) + '/' + ((cr.missed_lines || 0) + (cr.covered_lines || 0)) + '</td>' +
      '<td>' + (cr.covered_branches || 0) + '/' + ((cr.missed_branches || 0) + (cr.covered_branches || 0)) + '</td></tr>';
  }).join('\\n')}
</table>
</body>
</html>`;

/**
 * Generate a consolidated JUnit XML from stored test results.
 */
function buildJunitXml(testResults) {
  if (testResults.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="(no data)" tests="0" failures="0" errors="0" time="0">
  <system-out><![CDATA[No JUnit test results have been imported yet.
Run: codeparse import-results --junit <path>]]></system-out>
</testsuite>`;
  }

  const byClass = {};
  for (const tr of testResults) {
    const list = byClass[tr.test_class] || [];
    list.push(tr);
    byClass[tr.test_class] = list;
  }

  const parts = [];
  for (const [clsName, results] of Object.entries(byClass)) {
    const total = results.length;
    const failures = results.filter(r => r.result === 'failed').length;
    const errors = results.filter(r => r.result === 'error').length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const totalTime = results.reduce((s, r) => s + (r.duration_ms || 0), 0) / 1000;

    parts.push(`  <testsuite name="${clsName}" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${totalTime.toFixed(3)}">`);
    for (const r of results) {
      parts.push(`    <testcase name="${r.test_method}" classname="${r.test_class}" time="${((r.duration_ms || 0) / 1000).toFixed(3)}">`);
      if (r.result === 'failed' && r.failure_message) {
        parts.push(`      <failure message="${escapeXml(r.failure_message)}"><![CDATA[${r.stack_trace || r.failure_message}]]></failure>`);
      } else if (r.result === 'error' && r.failure_message) {
        parts.push(`      <error message="${escapeXml(r.failure_message)}"><![CDATA[${r.stack_trace || r.failure_message}]]></error>`);
      } else if (r.result === 'skipped') {
        parts.push('      <skipped/>');
      }
      parts.push('    </testcase>');
    }
    parts.push('  </testsuite>');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
${parts.join('\n')}
</testsuites>`;
}

function escapeXml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Generate the full 10-file evidence package for a class.
 *
 * @param {import('../db/database.js').GraphDatabase} db
 * @param {string} qualifiedName — fully qualified class name
 * @param {string} asilLevel — e.g. 'ASIL-D'
 * @param {string} outputDir — absolute path for output
 * @returns {Promise<{files: Array<{file: string, status: string}>, summary: object}>}
 */
export async function generateEvidencePackage(db, qualifiedName, asilLevel, outputDir) {
  // 1. Load class
  const cls = db.getClassByQualifiedName(qualifiedName);
  if (!cls) throw new Error(`Class not found: ${qualifiedName}`);

  // 2. Load methods with decisions, conditions, pairs
  const methods = db.getMethodsForClass(cls.id);
  const allDecisions = [];
  const allPairs = [];
  let fileId = null;

  for (const m of methods) {
    const decisions = db.getDecisionsForMethod(m.id);
    allDecisions.push(...decisions.map(d => ({ ...d, method_id: m.id, method_name: m.name })));
    const pairs = db.getMcdcPairsForMethod(m.id);
    allPairs.push(...pairs);
    if (!fileId) fileId = m.file_id;
  }

  // 3. Load test data and coverage
  const testCases = db.db.prepare(
    'SELECT * FROM test_cases WHERE target_class_id = ? ORDER BY test_class, test_method'
  ).all(cls.id);

  const testResults = db.getTestResultsForClass(cls.id);

  const coverageRecords = db.getCoverageForClass(cls.id);

  // Compute coverage averages
  const coverageAvg = coverageRecords.length > 0 ? {
    lineCoverage: Math.round(coverageRecords.reduce((s, r) => s + (r.line_coverage ?? 0), 0) / coverageRecords.length * 10) / 10,
    branchCoverage: Math.round(coverageRecords.reduce((s, r) => s + (r.branch_coverage ?? 0), 0) / coverageRecords.length * 10) / 10,
  } : null;

  const testPassCount = testResults.filter(r => r.result === 'passed').length;
  const testFailCount = testResults.filter(r => r.result === 'failed' || r.result === 'error').length;

  // 4. Ensure output directory
  mkdirSync(outputDir, { recursive: true });

  const files = [];

  // 5. Generate files
  try {
    const wb1 = await createDecisionList(allDecisions);
    await wb1.xlsx.writeFile(join(outputDir, '01_Decision_List.xlsx'));
    files.push({ file: '01_Decision_List.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '01_Decision_List.xlsx', status: `error: ${e.message}` });
  }

  try {
    const wb2 = await createMcdcMatrix(allDecisions, allPairs);
    await wb2.xlsx.writeFile(join(outputDir, '02_MCDC_Matrix.xlsx'));
    files.push({ file: '02_MCDC_Matrix.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '02_MCDC_Matrix.xlsx', status: `error: ${e.message}` });
  }

  try {
    const wb3 = await createTestMapping(testCases, testResults);
    await wb3.xlsx.writeFile(join(outputDir, '03_Test_Mapping.xlsx'));
    files.push({ file: '03_Test_Mapping.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '03_Test_Mapping.xlsx', status: `error: ${e.message}` });
  }

  try {
    const junitXml = buildJunitXml(testResults);
    writeFileSync(join(outputDir, '04_JUnit_Execution_Result.xml'), junitXml, 'utf8');
    files.push({ file: '04_JUnit_Execution_Result.xml', status: 'ok' });
  } catch (e) {
    files.push({ file: '04_JUnit_Execution_Result.xml', status: `error: ${e.message}` });
  }

  try {
    const html = COVERAGE_HTML_TEMPLATE(cls.qualified_name, methods, coverageRecords);
    writeFileSync(join(outputDir, '05_JaCoCo_C0_C1_Report.html'), html, 'utf8');
    files.push({ file: '05_JaCoCo_C0_C1_Report.html', status: 'ok' });
  } catch (e) {
    files.push({ file: '05_JaCoCo_C0_C1_Report.html', status: `error: ${e.message}` });
  }

  try {
    const wb6 = await createRequirementTraceability(cls, methods, allDecisions, asilLevel);
    await wb6.xlsx.writeFile(join(outputDir, '06_Requirement_Traceability.xlsx'));
    files.push({ file: '06_Requirement_Traceability.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '06_Requirement_Traceability.xlsx', status: `error: ${e.message}` });
  }

  try {
    const wb7 = await createTechReviewChecklist(allDecisions);
    await wb7.xlsx.writeFile(join(outputDir, '07_Technical_Review_Checklist.xlsx'));
    files.push({ file: '07_Technical_Review_Checklist.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '07_Technical_Review_Checklist.xlsx', status: `error: ${e.message}` });
  }

  try {
    const wb8 = await createProcessSafetyReviewChecklist(asilLevel);
    await wb8.xlsx.writeFile(join(outputDir, '08_Process_Safety_Review_Checklist.xlsx'));
    files.push({ file: '08_Process_Safety_Review_Checklist.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '08_Process_Safety_Review_Checklist.xlsx', status: `error: ${e.message}` });
  }

  try {
    const wb9 = await createAuditSummary({
      methodCount: methods.length,
      decisionCount: allDecisions.length,
      conditionCount: allDecisions.reduce((s, d) => s + (d.conditions?.length || 0), 0),
      mcdcPairCount: allPairs.length,
      testCaseCount: testCases.length,
      testPassCount,
      testFailCount,
      coverageAvg,
      asilLevel,
    });
    await wb9.xlsx.writeFile(join(outputDir, '09_Audit_Summary.xlsx'));
    files.push({ file: '09_Audit_Summary.xlsx', status: 'ok' });
  } catch (e) {
    files.push({ file: '09_Audit_Summary.xlsx', status: `error: ${e.message}` });
  }

  try {
    writeFileSync(join(outputDir, '10_Tool_Limitation_Statement.md'), TOOL_LIMITATION_STATEMENT, 'utf8');
    files.push({ file: '10_Tool_Limitation_Statement.md', status: 'ok' });
  } catch (e) {
    files.push({ file: '10_Tool_Limitation_Statement.md', status: `error: ${e.message}` });
  }

  // 6. Log to evidence_log
  const allOk = files.every(f => f.status === 'ok');
  db.insertEvidenceLog({
    targetClass: qualifiedName,
    asilLevel,
    outputPath: outputDir,
    filesGenerated: files.length,
    status: allOk ? 'generated' : 'partial',
  });

  return {
    files,
    summary: {
      methods: methods.length,
      decisions: allDecisions.length,
      mcdcPairs: allPairs.length,
      testCases: testCases.length,
      testResults: testResults.length,
      coverageRecords: coverageRecords.length,
      allOk,
    },
  };
}
