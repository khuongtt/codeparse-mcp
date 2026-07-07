// src/import/junit-importer.js
// Parse JUnit Surefire XML files and extract test results

import { readFileSync, existsSync, lstatSync } from 'fs';
import { extname, resolve } from 'path';
import { globSync } from 'glob';
import { XMLParser } from 'fast-xml-parser';

/**
 * Parse a JUnit Surefire XML file.
 * @param {string} filePath - path to TEST-*.xml
 * @returns {Array<{testClass: string, testMethod: string, result: string, durationMs: number, failureMessage: string|null, stackTrace: string|null}>}
 */
export function parseJunitFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`JUnit file not found: ${filePath}`);

  const content = readFileSync(filePath, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let doc;
  try {
    doc = parser.parse(content);
  } catch (e) {
    return { error: `XML parse error: ${e.message}`, results: [] };
  }

  const testsuite = doc.testsuite || doc.testsuites?.testsuite;
  if (!testsuite) return { error: 'No <testsuite> element found', results: [] };

  const suites = Array.isArray(testsuite) ? testsuite : [testsuite];
  const results = [];

  for (const suite of suites) {
    const suiteName = suite['@_name'] ?? suite.name ?? 'unknown';
    const testcases = suite.testcase;
    if (!testcases) continue;

    const cases = Array.isArray(testcases) ? testcases : [testcases];

    for (const tc of cases) {
      const testClass = tc['@_classname'] ?? tc.classname ?? suiteName;
      const testMethod = tc['@_name'] ?? tc.name ?? 'unknown';
      const timeSec = parseFloat(tc['@_time'] ?? tc.time ?? 0);
      const durationMs = Math.round(timeSec * 1000);

      let result = 'passed';
      let failureMessage = null;
      let stackTrace = null;

      if (tc.skipped) {
        result = 'skipped';
      } else if (tc.failure) {
        result = 'failed';
        const f = Array.isArray(tc.failure) ? tc.failure[0] : tc.failure;
        failureMessage = typeof f === 'string' ? f : (f['#text'] ?? f['@_message'] ?? f.message ?? 'failure');
        stackTrace = typeof f === 'string' ? f : (f['#text'] ?? null);
      } else if (tc.error) {
        result = 'error';
        const e = Array.isArray(tc.error) ? tc.error[0] : tc.error;
        failureMessage = typeof e === 'string' ? e : (e['#text'] ?? e['@_message'] ?? e.message ?? 'error');
        stackTrace = typeof e === 'string' ? e : (e['#text'] ?? null);
      }

      results.push({ testClass, testMethod, result, durationMs, failureMessage, stackTrace });
    }
  }

  return { error: null, results };
}

/**
 * Parse all JUnit XML files from a path (file or directory).
 * @param {string} reportPath - path to a JUnit XML file or directory of TEST-*.xml files
 * @returns {Array<{testClass: string, testMethod: string, result: string, durationMs: number, failureMessage: string|null, stackTrace: string|null}>}
 */
export function parseJunitXml(reportPath) {
  const resolved = resolve(reportPath);

  if (existsSync(resolved) && !isDirectory(resolved)) {
    const r = parseJunitFile(resolved);
    return r.results;
  }

  // Directory — glob for TEST-*.xml
  const files = globSync('**/TEST-*.xml', {
    cwd: resolved,
    absolute: true,
  });

  const allResults = [];
  for (const file of files) {
    const r = parseJunitFile(file);
    for (const res of r.results) allResults.push({ ...res, reportFile: file });
  }
  return allResults;
}

function isDirectory(path) {
  try { return lstatSync(path).isDirectory(); }
  catch { return false; }
}
