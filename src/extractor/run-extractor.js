// src/extractor/run-extractor.js
// Spawns Java-based AST extractor for .java or .xtend files.
// Falls back to JS parser if Java extractor not available or fails.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PROJECT_ROOT = resolve(__dirname, '..', '..');

const EXTRACTOR_DIR = resolve(PROJECT_ROOT, 'extractors');
const JDK_HOME = '/tmp/jdk-17.0.13+11';
const JAVAPARSER_JAR = '/tmp/javaparser-lib/javaparser-core-3.25.10.jar';
const GSON_JAR = '/tmp/javaparser-lib/gson-2.10.1.jar';

/**
 * Run the Java AST extractor for a source file.
 * @param {string} absPath - absolute path to source file
 * @param {string} lang - 'java' or 'xtend'
 * @returns {object|null} IR JSON object, or null if extractor not available/failed
 */
export async function runExtractor(absPath, lang) {
  const langDir = lang === 'java' ? 'java' : 'xtend';
  const mainClass = lang === 'java'
    ? 'com.codeparse.extractor.JavaAstExtractor'
    : 'com.codeparse.extractor.XtendAstExtractor';

  const classesDir = resolve(EXTRACTOR_DIR, langDir, 'target', 'classes');
  const javaClassesDir = resolve(EXTRACTOR_DIR, 'java', 'target', 'classes');

  // Check if classes exist
  if (!existsSync(classesDir) && !existsSync(javaClassesDir)) return null;

  const classpath = [classesDir, javaClassesDir, JAVAPARSER_JAR, GSON_JAR]
    .filter(p => existsSync(p) || !p.includes('target'))
    .join(':');

  return new Promise((resolve) => {
    execFile(
      resolve(JDK_HOME, 'bin', 'java'),
      ['-cp', classpath, mainClass, absPath],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`[extractor] ${lang} extractor failed for ${absPath}: ${err.message}`);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          console.warn(`[extractor] JSON parse failed for ${absPath}: ${parseErr.message}`);
          resolve(null);
        }
      }
    );
  });
}
