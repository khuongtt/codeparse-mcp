// src/graph/builder.js
// Orchestrates parsing and writing graph data to SQLite.
// After v3 refactor: scans files, dispatches parsers, delegates DB writes to ir-ingest.js.

import { readFileSync, existsSync } from 'fs';
import { relative, extname, resolve } from 'path';
import { globSync } from 'glob';
import { GraphDatabase, sha256 } from '../db/database.js';
import { parseJava } from '../parser/java-parser.js';
import { parseXtend } from '../parser/xtend-parser.js';
import { IrIngest } from './ir-ingest.js';
import { runExtractor } from '../extractor/run-extractor.js';

export class GraphBuilder {
  /**
   * @param {GraphDatabase} db
   * @param {string} projectRoot - absolute path to project root
   */
  constructor(db, projectRoot) {
    this.db = db;
    this.projectRoot = resolve(projectRoot);
  }

  // ── Full sync ─────────────────────────────────────────────────────────────

  /**
   * Scan all Java/Xtend files, parse changed files, persist to DB.
   * Returns a report object.
   */
  async syncProject(options = {}) {
    const {
      include = ['**/*.java', '**/*.xtend'],
      exclude = ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**'],
      force = false,
      onProgress = null,
    } = options;

    const report = {
      scanned: 0,
      skipped: 0,
      parsed: 0,
      errors: 0,
      classes: 0,
      methods: 0,
      start: Date.now(),
    };

    // Collect source files
    const files = [];
    for (const pattern of include) {
      const matches = globSync(pattern, {
        cwd: this.projectRoot,
        ignore: exclude,
        absolute: true,
      });
      files.push(...matches);
    }

    report.scanned = files.length;
    const ingest = new IrIngest(this.db);

    // Parse each file
    for (let i = 0; i < files.length; i++) {
      const absPath = files[i];
      const relPath = relative(this.projectRoot, absPath);

      if (onProgress) onProgress({ i, total: files.length, path: relPath });

      try {
        const content = readFileSync(absPath, 'utf8');
        const hash = sha256(content);

        // Check if unchanged
        const existing = this.db.getFile(relPath);
        if (!force && existing?.sha256 === hash) {
          report.skipped++;
          continue;
        }

        const lang = extname(absPath).slice(1);
        const lineCount = content.split('\n').length;

        // Parse — try Java extractor first, fall back to JS parser
        let parsed;
        if (lang === 'java' || lang === 'xtend') {
          parsed = await runExtractor(absPath, lang);
        }
        if (!parsed) {
          if (lang === 'java') {
            parsed = parseJava(content, relPath);
          } else if (lang === 'xtend') {
            parsed = parseXtend(content, relPath);
          } else {
            report.skipped++;
            continue;
          }
        }

        // Delegate all DB writes to ir-ingest.js
        const result = ingest.ingest(parsed, { filePath: relPath, absPath, lang, sha256: hash, lineCount });

        // Record parse errors
        for (const err of parsed.errors) {
          try { this.db.markFileError(relPath, err.message); } catch (_) {}
        }

        report.parsed += result.fileId ? 1 : 0;
        report.classes += result.classCount;
        report.methods += result.methodCount;
        report.errors += result.errors.length;

      } catch (err) {
        report.errors++;
        try {
          this.db.db?.prepare(
            "INSERT OR IGNORE INTO parse_errors (path, error, logged_at) VALUES (?, ?, datetime('now'))"
          ).run(relative(this.projectRoot, absPath), err.message);
        } catch (_) {}
      }
    }

    // Second pass: resolve call graph
    const resolved = this.db.resolveCalleeIds();

    report.duration = Date.now() - report.start;
    report.callEdgesResolved = resolved;

    return report;
  }

  // ── Single file sync ──────────────────────────────────────────────────────

  async syncFile(absPath) {
    const relPath = relative(this.projectRoot, absPath);
    const lang = extname(absPath).slice(1);
    const content = readFileSync(absPath, 'utf8');
    const hash = sha256(content);
    const lineCount = content.split('\n').length;

    let parsed;
    if (lang === 'java') parsed = parseJava(content, relPath);
    else if (lang === 'xtend') parsed = parseXtend(content, relPath);
    else return { skipped: true };

    const ingest = new IrIngest(this.db);
    const result = ingest.ingest(parsed, { filePath: relPath, absPath, lang, sha256: hash, lineCount });

    return { relPath, classCount: result.classCount, methodCount: result.methodCount, errorCount: result.errors.length };
  }
}
