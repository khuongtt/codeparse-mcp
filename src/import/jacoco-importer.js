// src/import/jacoco-importer.js
// Parse JaCoCo XML coverage reports and extract per-method coverage data

import { readFileSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';

/**
 * Parse a JaCoCo XML report file.
 *
 * JaCoCo XML structure:
 * <report>
 *   <sessionInfo .../>
 *   <package name="com/example">
 *     <class name="com/example/Calculator" sourcefilename="Calculator.java">
 *       <method name="add" desc="(II)I" line="5">
 *         <counter type="LINE" missed="0" covered="3"/>
 *         <counter type="BRANCH" missed="0" covered="0"/>
 *         <counter type="COMPLEXITY" missed="0" covered="1"/>
 *       </method>
 *     </class>
 *   </package>
 * </report>
 *
 * @param {string} reportPath - path to jacoco.xml
 * @returns {Array<{className: string, methodName: string, methodDesc: string|null,
 *                   lineCoverage: number, branchCoverage: number, instructionCoverage: number,
 *                   complexityCoverage: number, missedLines: number, coveredLines: number,
 *                   missedBranches: number, coveredBranches: number}>}
 */
export function parseJacocoXml(reportPath) {
  if (!existsSync(reportPath)) throw new Error(`JaCoCo file not found: ${reportPath}`);

  const content = readFileSync(reportPath, 'utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  let doc;
  try {
    doc = parser.parse(content);
  } catch (e) {
    return { error: `XML parse error: ${e.message}`, records: [] };
  }

  const report = doc.report;
  if (!report) return { error: 'No <report> element found', records: [] };

  const packages = report.package;
  if (!packages) return { error: 'No <package> elements found', records: [] };

  const pkgArray = Array.isArray(packages) ? packages : [packages];
  const records = [];

  for (const pkg of pkgArray) {
    const clsArray = pkg.class;
    if (!clsArray) continue;
    const classes = Array.isArray(clsArray) ? clsArray : [clsArray];

    for (const cls of classes) {
      const rawClassName = cls['@_name'] ?? '';
      // JaCoCo uses / separators, convert to dots
      const className = rawClassName.replace(/\//g, '.').replace(/\.class$/, '');
      const methods = cls.method;
      if (!methods) continue;
      const methodArray = Array.isArray(methods) ? methods : [methods];

      for (const method of methodArray) {
        const methodName = method['@_name'] ?? 'unknown';
        const methodDesc = method['@_desc'] ?? null;
        const counters = method.counter;
        if (!counters) continue;

        const counterArray = Array.isArray(counters) ? counters : [counters];
        const counterMap = {};
        for (const c of counterArray) {
          const type = c['@_type'] ?? '';
          counterMap[type] = {
            missed: parseInt(c['@_missed'] ?? '0', 10),
            covered: parseInt(c['@_covered'] ?? '0', 10),
          };
        }

        function coverage(type) {
          const c = counterMap[type];
          if (!c) return null;
          const total = c.missed + c.covered;
          return total > 0 ? Math.round((c.covered / total) * 1000) / 10 : (c.covered > 0 ? 100 : 0);
        }

        function raw(type, field) {
          const c = counterMap[type];
          return c ? parseInt(c[field] ?? '0', 10) : 0;
        }

        records.push({
          className,
          methodName,
          methodDesc,
          lineCoverage: coverage('LINE'),
          branchCoverage: coverage('BRANCH'),
          instructionCoverage: coverage('INSTRUCTION'),
          complexityCoverage: coverage('COMPLEXITY'),
          missedLines: raw('LINE', 'missed'),
          coveredLines: raw('LINE', 'covered'),
          missedBranches: raw('BRANCH', 'missed'),
          coveredBranches: raw('BRANCH', 'covered'),
        });
      }
    }
  }

  return { error: null, records };
}
