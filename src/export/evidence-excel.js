// src/export/evidence-excel.js
// xlsx workbook builders for the ISO 26262 evidence package
// Each function returns an exceljs Workbook ready to be written to disk

import ExcelJS from 'exceljs';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Style the header row of a worksheet.
 */
function styleHeader(ws, columns) {
  ws.columns = columns;
  const header = ws.getRow(1);
  header.font = { bold: true, size: 11 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  header.border = {
    bottom: { style: 'thin', color: { argb: 'FF4472C4' } },
  };
  header.alignment = { vertical: 'middle', wrapText: true };
}

// ── 01_Decision_List.xlsx ───────────────────────────────────────────────────

/**
 * @param {Array} decisions — array of decision rows, each with .conditions[]
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createDecisionList(decisions) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Decision List');

  styleHeader(ws, [
    { header: 'Decision UID', key: 'uid', width: 20 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Expression', key: 'expression', width: 55 },
    { header: 'Normalized', key: 'normalized', width: 22 },
    { header: 'Conditions', key: 'conditions', width: 12 },
    { header: 'MC/DC Required', key: 'mcdc', width: 14 },
    { header: 'Line', key: 'line', width: 8 },
    { header: 'Operator', key: 'operator', width: 10 },
    { header: 'Parse Status', key: 'parseStatus', width: 14 },
    { header: 'Atomic Conditions', key: 'list', width: 60 },
  ]);

  for (const dec of decisions) {
    const condList = (dec.conditions || [])
      .map(c => `${c.condition_uid}: ${c.text}`)
      .join('; ');
    ws.addRow({
      uid: dec.decision_uid,
      kind: dec.kind,
      expression: dec.expression,
      normalized: dec.normalized,
      conditions: (dec.conditions || []).length,
      mcdc: dec.mcdc_required ? 'YES' : 'NO',
      line: dec.line_start,
      operator: dec.operator || '',
      parseStatus: dec.parse_status,
      list: condList,
    });
  }

  return wb;
}

// ── 02_MCDC_Matrix.xlsx ─────────────────────────────────────────────────────

/**
 * @param {Array} decisions — decisions with .conditions[]
 * @param {Array} pairs — mcdc_pairs rows
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createMcdcMatrix(decisions, pairs) {
  const wb = new ExcelJS.Workbook();

  for (const dec of decisions.filter(d => d.mcdc_required)) {
    const ws = wb.addWorksheet(dec.decision_uid.replace(/[\[\]:*?\/\\]/g, '_').slice(0, 31));

    styleHeader(ws, [
      { header: 'Condition', key: 'cond', width: 30 },
      { header: 'Position', key: 'pos', width: 10 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Normalized', key: 'normalized', width: 30 },
    ]);

    for (const c of dec.conditions || []) {
      ws.addRow({
        cond: c.text,
        pos: c.position,
        type: c.condition_type,
        normalized: c.normalized_text,
      });
    }

    // Add pair section header
    const lastRow = ws.rowCount + 1;
    ws.addRow({});
    ws.addRow({ cond: 'MC/DC Independence Pairs:' });
    ws.getRow(lastRow + 1).font = { bold: true };

    styleHeader(ws, [
      { header: 'Pair UID', key: 'puid', width: 22 },
      { header: 'Condition', key: 'pcond', width: 20 },
      { header: 'Vector A', key: 'va', width: 35 },
      { header: 'Outcome A', key: 'oa', width: 12 },
      { header: 'Vector B', key: 'vb', width: 35 },
      { header: 'Outcome B', key: 'ob', width: 12 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Review', key: 'review', width: 16 },
    ]);
    // Re-add headers at the pair section position
    // (styleHeader added at row 1; need header row above pairs)
    const headerRow = ws.addRow({
      puid: 'Pair UID', pcond: 'Condition', va: 'Vector A', oa: 'Outcome A',
      vb: 'Vector B', ob: 'Outcome B', status: 'Status', review: 'Review',
    });
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

    const decPairs = pairs.filter(p => p.decision_id === dec.id);
    if (decPairs.length === 0) {
      ws.addRow({ puid: '(no independence pairs generated)' });
    } else {
      for (const p of decPairs) {
        ws.addRow({
          puid: p.pair_uid,
          pcond: p.condition_uid || '',
          va: p.testVectorA ? JSON.stringify(p.testVectorA) : '',
          oa: p.outcome_a,
          vb: p.testVectorB ? JSON.stringify(p.testVectorB) : '',
          ob: p.outcome_b,
          status: p.independence_status,
          review: p.review_status,
        });
      }
    }
  }

  // If no mcdc-required decisions, still create a sheet
  if (wb.worksheets.length === 0) {
    const ws = wb.addWorksheet('MC/DC Matrix');
    ws.addRow(['No compound decisions requiring MC/DC found.']);
  }

  return wb;
}

// ── 03_Test_Mapping.xlsx ────────────────────────────────────────────────────

/**
 * @param {Array} testCases — from test_cases table
 * @param {Array} testResults — from test_results table
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createTestMapping(testCases, testResults) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Test Mapping');

  styleHeader(ws, [
    { header: 'Test Class', key: 'testClass', width: 40 },
    { header: 'Test Method', key: 'testMethod', width: 30 },
    { header: 'Result', key: 'result', width: 12 },
    { header: 'Duration (ms)', key: 'duration', width: 14 },
    { header: 'Target Method ID', key: 'targetMethodId', width: 16 },
    { header: 'Failure Message', key: 'failure', width: 50 },
  ]);

  // Index test results by test class + method
  const resultMap = new Map();
  for (const tr of testResults) {
    resultMap.set(`${tr.test_class}:${tr.test_method}`, tr);
  }

  for (const tc of testCases) {
    const key = `${tc.test_class}:${tc.test_method}`;
    const tr = resultMap.get(key) || {};
    ws.addRow({
      testClass: tc.test_class,
      testMethod: tc.test_method,
      result: tr.result || tc.status,
      duration: tr.duration_ms || '',
      targetMethodId: tc.target_method_id || '',
      failure: tr.failure_message || '',
    });
  }

  return wb;
}

// ── 06_Requirement_Traceability.xlsx ────────────────────────────────────────

/**
 * @param {object} cls — class row { qualified_name, name, asil_level, ... }
 * @param {Array} methods — from getMethodsForClass
 * @param {Array} decisions — flat array of decisions across all methods
 * @param {string} asilLevel — e.g. 'ASIL-D'
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createRequirementTraceability(cls, methods, decisions, asilLevel) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Traceability');

  styleHeader(ws, [
    { header: 'ASIL Level', key: 'asil', width: 14 },
    { header: 'Class', key: 'cls', width: 45 },
    { header: 'Method', key: 'method', width: 30 },
    { header: 'Decision UID', key: 'duid', width: 20 },
    { header: 'Decision Kind', key: 'kind', width: 12 },
    { header: 'Expression', key: 'expr', width: 50 },
    { header: 'MC/DC Required', key: 'mcdc', width: 14 },
  ]);

  // Map decisions by method_id
  const decByMethod = new Map();
  for (const d of decisions) {
    const list = decByMethod.get(d.method_id) || [];
    list.push(d);
    decByMethod.set(d.method_id, list);
  }

  for (const m of methods) {
    const mDecs = decByMethod.get(m.id) || [];
    if (mDecs.length === 0) {
      ws.addRow({
        asil: asilLevel,
        cls: cls.qualified_name,
        method: m.name,
        duid: '(no decisions)',
        kind: '',
        expr: '',
        mcdc: '',
      });
    } else {
      for (const d of mDecs) {
        ws.addRow({
          asil: asilLevel,
          cls: cls.qualified_name,
          method: m.name,
          duid: d.decision_uid,
          kind: d.kind,
          expr: d.expression,
          mcdc: d.mcdc_required ? 'YES' : 'NO',
        });
      }
    }
  }

  return wb;
}

// ── 07_Technical_Review_Checklist.xlsx ──────────────────────────────────────

/**
 * @param {Array} decisions — flat array with .conditions[]
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createTechReviewChecklist(decisions) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Technical Review');

  styleHeader(ws, [
    { header: 'Decision UID', key: 'uid', width: 20 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Expression', key: 'expression', width: 45 },
    { header: 'Line', key: 'line', width: 8 },
    { header: 'Condition', key: 'condition', width: 35 },
    { header: 'Atomic?', key: 'atomic', width: 10 },
    { header: 'Correct?', key: 'correct', width: 12 },
    { header: 'Covered?', key: 'covered', width: 12 },
    { header: 'Reviewer Notes', key: 'notes', width: 40 },
  ]);

  for (const dec of decisions) {
    const conditions = dec.conditions || [];
    if (conditions.length === 0) {
      ws.addRow({
        uid: dec.decision_uid,
        kind: dec.kind,
        expression: dec.expression,
        line: dec.line_start,
        condition: '(no conditions)',
        atomic: '',
        correct: '',
        covered: '',
        notes: '',
      });
    } else {
      for (const c of conditions) {
        ws.addRow({
          uid: dec.decision_uid,
          kind: dec.kind,
          expression: dec.expression,
          line: dec.line_start,
          condition: c.text,
          atomic: c.condition_type === 'atomic' ? 'Yes' : 'No',
          correct: '',  // reviewer fills
          covered: '',  // reviewer fills
          notes: '',    // reviewer fills
        });
      }
    }
  }

  // Add a review section at the bottom
  ws.addRow({});
  ws.addRow({ uid: 'INSTRUCTIONS:', condition: 'For each condition mark: Correct? (C)orrect / (I)ncorrect, Covered? (Y)es / (N)o. Add reviewer notes as needed.' });
  ws.getRow(ws.rowCount).font = { italic: true, color: { argb: 'FF666666' } };

  ws.addRow({});
  ws.addRow({ uid: 'Reviewer:' });
  ws.addRow({ uid: 'Date:' });
  ws.addRow({ uid: 'Status:' });

  return wb;
}

// ── 08_Process_Safety_Review_Checklist.xlsx ─────────────────────────────────

/**
 * @param {string} asilLevel — e.g. 'ASIL-D'
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createProcessSafetyReviewChecklist(asilLevel) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Process Safety Review');

  const checklist = [
    { item: '1', check: 'ASIL level correctly assigned based on hazard analysis', role: 'Safety Manager' },
    { item: '2', check: 'All decisions with compound boolean conditions identified for MC/DC', role: 'Engineer' },
    { item: '3', check: 'MC/DC independence pairs reviewed and approved', role: 'Reviewer' },
    { item: '4', check: 'Each atomic condition has at least one test case proving independence', role: 'Engineer' },
    { item: '5', check: 'C0 (statement) coverage confirmed via JaCoCo', role: 'Engineer' },
    { item: '6', check: 'C1 (branch) coverage confirmed via JaCoCo', role: 'Engineer' },
    { item: '7', check: 'No dead code or unreachable branches in analysis scope', role: 'Reviewer' },
    { item: '8', check: 'Tool limitations documented (see Tool Limitation Statement)', role: 'Engineer' },
    { item: '9', check: 'Parser warnings reviewed and mitigated', role: 'Engineer' },
    { item: '10', check: 'Evidence package complete and audit-ready', role: 'Reviewer' },
  ];

  styleHeader(ws, [
    { header: '#', key: 'item', width: 6 },
    { header: 'Checklist Item', key: 'check', width: 60 },
    { header: 'Responsible', key: 'role', width: 20 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Evidence Reference', key: 'ref', width: 30 },
    { header: 'Notes', key: 'notes', width: 40 },
  ]);

  for (const c of checklist) {
    ws.addRow({ item: c.item, check: c.check, role: c.role, status: '', ref: '', notes: '' });
  }

  // ASIL-specific section
  ws.addRow({});
  ws.addRow({ item: '', check: `Target ASIL Level: ${asilLevel}`, role: '' });
  ws.getRow(ws.rowCount).font = { bold: true };

  ws.addRow({});
  ws.addRow({ item: 'Reviewer Name:' });
  ws.addRow({ item: 'Review Date:' });
  ws.addRow({ item: 'Approval Status:' });

  return wb;
}

// ── 09_Audit_Summary.xlsx ───────────────────────────────────────────────────

/**
 * @param {number} methodCount
 * @param {number} decisionCount
 * @param {number} conditionCount
 * @param {number} mcdcPairCount
 * @param {number} testCaseCount
 * @param {object|null} coverageAvg — { lineCoverage, branchCoverage } or null
 * @param {string} asilLevel
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function createAuditSummary({
  methodCount, decisionCount, conditionCount, mcdcPairCount,
  testCaseCount, testPassCount, testFailCount,
  coverageAvg, asilLevel,
}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Audit Summary');

  ws.columns = [
    { header: 'Metric', key: 'metric', width: 35 },
    { header: 'Value', key: 'value', width: 20 },
    { header: 'Status', key: 'status', width: 16 },
  ];
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  function addMetric(metric, value, status) {
    const r = ws.addRow({ metric, value, status });
    if (status === 'PASS') r.getCell('status').font = { color: { argb: 'FF008000' } };
    else if (status === 'FAIL') r.getCell('status').font = { color: { argb: 'FFFF0000' } };
    return r;
  }

  addMetric('ASIL Level', asilLevel, '');
  addMetric('Class Methods', String(methodCount), '');
  addMetric('Total Decisions', String(decisionCount), '');
  addMetric('Total Atomic Conditions', String(conditionCount), '');
  addMetric('MC/DC Independence Pairs', String(mcdcPairCount), mcdcPairCount > 0 ? 'PASS' : 'WARNING');
  addMetric('Test Cases Imported', String(testCaseCount), testCaseCount > 0 ? 'PASS' : 'WARNING');
  addMetric('Tests Passed', String(testPassCount), '');
  addMetric('Tests Failed', String(testFailCount), testFailCount === 0 ? 'PASS' : 'FAIL');
  addMetric('Line Coverage', coverageAvg?.lineCoverage != null ? `${coverageAvg.lineCoverage}%` : 'N/A', '');
  addMetric('Branch Coverage', coverageAvg?.branchCoverage != null ? `${coverageAvg.branchCoverage}%` : 'N/A', '');

  ws.addRow({});
  ws.addRow({ metric: 'Generated:', value: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  ws.addRow({ metric: 'Status:', value: testFailCount === 0 && testCaseCount > 0 ? 'ALL CHECKS PASSED' : 'REVIEW REQUIRED' });
  const statusRow = ws.getRow(ws.rowCount);
  statusRow.font = {
    bold: true,
    color: { argb: testFailCount === 0 && testCaseCount > 0 ? 'FF008000' : 'FFFF0000' },
  };

  return wb;
}
