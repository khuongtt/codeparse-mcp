// src/import/index.js
// Orchestrates importing JUnit/JaCoCo results into the graph DB

import { parseJunitXml } from './junit-importer.js';
import { parseJacocoXml } from './jacoco-importer.js';
import { resolve } from 'path';

/**
 * Import JUnit results into the database.
 * Tries to map test classes/methods to target classes/methods via naming convention.
 *
 * @param {import('../db/database.js').GraphDatabase} db
 * @param {string} junitPath - path to JUnit XML file or directory
 * @param {string} projectRoot - project root for path resolution
 * @returns {{total: number, passed: number, failed: number, skipped: number, errors: number}}
 */
export async function importJunitResults(db, junitPath, projectRoot) {
  const results = parseJunitXml(resolve(junitPath));

  let total = 0, passed = 0, failed = 0, skipped = 0, errors = 0;

  for (const r of results) {
    // Attempt to map test class → target class
    let targetClassId = null;
    let targetMethodId = null;

    // Convention: {TargetClass}Test or {TargetClass}IT
    const testClassBase = r.testClass.replace(/Test$|IT$/, '');
    if (testClassBase && testClassBase !== r.testClass) {
      // Search for matching class in DB
      let targetClass = null;
      try {
        targetClass = db.db.prepare(
          'SELECT id FROM classes WHERE name = ? OR qualified_name = ?'
        ).get(testClassBase, testClassBase);
      } catch (_) {}

      if (targetClass) {
        targetClassId = targetClass.id;
        // Try to map method: test{Method} or should{Method}
        const methodName = r.testMethod
          .replace(/^test/, '')
          .replace(/^should/, '')
          .replace(/^./, c => c.toLowerCase());
        try {
          const targetMethod = db.db.prepare(
            'SELECT id FROM methods WHERE class_id = ? AND (name = ? OR name = ?) LIMIT 1'
          ).get(targetClass.id, r.testMethod.replace(/^test/, ''), methodName);
          targetMethodId = targetMethod?.id ?? null;
        } catch (_) {}
      }
    }

    // Upsert test case
    const testCaseId = db.upsertTestCase({
      testClass: r.testClass,
      testMethod: r.testMethod,
      targetClassId,
      targetMethodId,
      objective: null,
      status: r.result === 'passed' ? 'passed' : (r.result === 'failed' || r.result === 'error' ? 'failed' : 'draft'),
    });

    // Insert test result
    db.insertTestResult({
      testCaseId,
      testClass: r.testClass,
      testMethod: r.testMethod,
      result: r.result,
      durationMs: r.durationMs,
      reportFile: r.reportFile ?? null,
      failureMessage: r.failureMessage,
      stackTrace: r.stackTrace,
    });

    total++;
    if (r.result === 'passed') passed++;
    else if (r.result === 'failed') failed++;
    else if (r.result === 'error') errors++;
    else if (r.result === 'skipped') skipped++;
  }

  return { total, passed, failed, skipped, errors };
}

/**
 * Import JaCoCo coverage data into the database.
 * Tries to map class/method names to DB records.
 *
 * @param {import('../db/database.js').GraphDatabase} db
 * @param {string} jacocoPath - path to jacoco.xml
 * @returns {number} number of coverage records imported
 */
export async function importJacocoCoverage(db, jacocoPath) {
  const { error, records } = parseJacocoXml(resolve(jacocoPath));
  if (error) throw new Error(`JaCoCo parse error: ${error}`);

  let imported = 0;

  for (const rec of records) {
    // Find matching class in DB
    let classRow = null;
    let fileId = null;

    try {
      classRow = db.db.prepare(
        'SELECT id, file_id FROM classes WHERE qualified_name = ? OR name = ?'
      ).get(rec.className, rec.className);
    } catch (_) {}

    if (classRow) {
      fileId = classRow.file_id;
      // Find matching method
      let methodId = null;
      try {
        const methodRow = db.db.prepare(
          'SELECT id FROM methods WHERE class_id = ? AND name = ? LIMIT 1'
        ).get(classRow.id, rec.methodName);
        methodId = methodRow?.id ?? null;
      } catch (_) {}

      db.upsertCoverageRecord({
        fileId,
        methodId,
        className: rec.className,
        methodName: rec.methodName,
        lineCoverage: rec.lineCoverage,
        branchCoverage: rec.branchCoverage,
        instructionCoverage: rec.instructionCoverage,
        complexityCoverage: rec.complexityCoverage,
        missedLines: rec.missedLines,
        coveredLines: rec.coveredLines,
        missedBranches: rec.missedBranches,
        coveredBranches: rec.coveredBranches,
        source: 'jacoco',
      });
      imported++;
    }
  }

  return imported;
}
