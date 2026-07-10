// src/extractor/run-extractor.js
// Spawns Java-based AST extractor for .java or .xtend files.
// Falls back to JS parser if Java extractor not available or fails.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { constants } from 'node:fs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const EXTRACTOR_DIR = resolve(PROJECT_ROOT, 'extractors');
const M2_REPO = resolve(homedir(), '.m2', 'repository');

// Auto-detect JDK java.home from the runtime JVM
const JDK_HOME = resolve(process.env.JAVA_HOME || '/usr/lib/jvm/java-17-openjdk-amd64');

// Auto-detect JARs from local Maven repo
const JAVAPARSER_JAR = resolve(M2_REPO, 'com', 'github', 'javaparser', 'javaparser-core', '3.26.4', 'javaparser-core-3.26.4.jar');
const GSON_JAR = resolve(M2_REPO, 'com', 'google', 'code', 'gson', 'gson', '2.11.0', 'gson-2.11.0.jar');

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

  // Check if classes exist — extractor not available = silently fall back
  if (!existsSync(classesDir)) return null;

  // Build classpath: extractor classes + dependencies
  const classpath = [classesDir, JAVAPARSER_JAR, GSON_JAR]
    .filter(p => existsSync(p))
    .join(':');

  // If classpath is effectively empty (e.g. no JARs found), skip
  if (!classpath) return null;

  return new Promise((resolve) => {
    execFile(
      resolve(JDK_HOME, 'bin', 'java'),
      ['-cp', classpath, mainClass, absPath],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          resolve(null);
        }
      }
    );
  });
}
