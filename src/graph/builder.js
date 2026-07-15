// src/graph/builder.js
// Orchestrates parsing and writing graph data to SQLite.
// After v3 refactor: scans files, dispatches parsers, delegates DB writes to ir-ingest.js.

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { relative, extname, resolve, join, basename, dirname } from 'path';
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
        if (!parsed || typeof parsed !== 'object' || !parsed.classes) {
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
        for (const err of parsed.errors ?? []) {
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

  // ── Module manifest generation ──────────────────────────────────────────

  /**
   * Find Maven modules (directories containing pom.xml) under projectRoot.
   * Returns map of moduleName → { dir: relativeDir, files: [absolutePaths] }
   */
  _detectMavenModules(files) {
    // Find all pom.xml (exclude hidden dirs, build dirs)
    const pomFiles = globSync('**/pom.xml', {
      cwd: this.projectRoot,
      ignore: ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**', '**/.*/**'],
      absolute: true,
    });

    // moduleDir → { dir: relPath, name }
    const modules = new Map();
    // Always include root pseudo-module for files outside any Maven module
    modules.set('', { dir: '', name: '__root__', files: [] });

    for (const pom of pomFiles) {
      const relDir = relative(this.projectRoot, dirname(pom));
      if (!relDir || relDir.startsWith('.')) continue;
      const name = basename(relDir);
      modules.set(relDir, { dir: relDir, name, files: [] });
    }

    // Assign each file to the deepest matching module dir
    const sortedDirs = [...modules.keys()].filter(Boolean).sort((a, b) => b.length - a.length);

    for (const absPath of files) {
      const relPath = relative(this.projectRoot, absPath);
      let assigned = false;
      for (const dir of sortedDirs) {
        if (relPath === dir || relPath.startsWith(dir + '/')) {
          modules.get(dir).files.push(absPath);
          assigned = true;
          break;
        }
      }
      if (!assigned) modules.get('').files.push(absPath);
    }

    // Remove empty modules (except root if it has files)
    for (const [key, mod] of modules) {
      if (key !== '' && mod.files.length === 0) modules.delete(key);
    }
    if (modules.get('')?.files.length === 0) modules.delete('');

    return modules;
  }

  /**
   * Scan source files, parse each, group by Maven module, and write per-module
   * module.json + module.csv to outputDir/modules/<moduleName>/.
   * Returns { moduleCount, classCount, methodCount, modules: [{ name, jsonPath, csvPath }] }.
   */
  async generateModuleFiles(options = {}) {
    const {
      include = ['**/*.java', '**/*.xtend'],
      exclude = ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**'],
      outputDir = join(this.projectRoot, '.codeparse'),
    } = options;

    // Collect source files
    const allFiles = [];
    for (const pattern of include) {
      const matches = globSync(pattern, { cwd: this.projectRoot, ignore: exclude, absolute: true });
      allFiles.push(...matches);
    }

    // Group by Maven module
    const mavenModules = this._detectMavenModules(allFiles);

    mkdirSync(outputDir, { recursive: true });

    const results = [];
    let totalClassCount = 0, totalMethodCount = 0;

    for (const [modDir, mod] of mavenModules) {
      const modOutDir = join(outputDir, 'modules', mod.name);
      mkdirSync(modOutDir, { recursive: true });

      let classCount = 0, methodCount = 0;

      for (const absPath of mod.files) {
        const relPath = relative(this.projectRoot, absPath);
        const lang = extname(absPath).slice(1);
        const content = readFileSync(absPath, 'utf8');
        const lineCount = content.split('\n').length;
        const base = basename(absPath, extname(absPath));

        let parsed;
        try {
          if (lang === 'java' || lang === 'xtend') {
            parsed = await runExtractor(absPath, lang);
          }
          if (!parsed || typeof parsed !== 'object' || !parsed.classes) {
            if (lang === 'java') parsed = parseJava(content, relPath);
            else if (lang === 'xtend') parsed = parseXtend(content, relPath);
          }
        } catch (_) { /* skip unparseable files */ }

        const classes = (parsed?.classes ?? []).map(c => {
          const methods = (c.methods ?? []).map(m => ({
            name: m.name,
            signature: m.signature ?? m.name,
            cyclomaticComplexity: m.cyclomaticComplexity ?? m.cyclomatic_complexity ?? 1,
            mcdcRequired: (m.decisions ?? []).some(d => (d.conditions ?? []).length >= 2),
          }));
          return {
            name: c.name,
            qualifiedName: c.qualifiedName ?? c.qualified_name ?? c.name,
            kind: c.kind,
            methods,
          };
        });
        classCount += classes.length;
        methodCount += classes.reduce((s, c) => s + c.methods.length, 0);

        // Per-file JSON
        const jsonPath = join(modOutDir, `${base}.json`);
        const json = { generatedAt: new Date().toISOString(), projectRoot: this.projectRoot, moduleName: mod.name, path: relPath, lang, lineCount, classes };
        writeFileSync(jsonPath, JSON.stringify(json, null, 2));

        // Per-file CSV
        const csvPath = join(modOutDir, `${base}.csv`);
        const csvRows = ['file_path,file_lang,file_lines,class_name,class_qualified_name,class_kind,method_name,method_signature,cc,mcdc_required'];
        for (const cls of classes) {
          if (cls.methods.length === 0) {
            csvRows.push(`"${relPath}","${lang}",${lineCount},"${cls.name}","${cls.qualifiedName}","${cls.kind}","","",0,false`);
          }
          for (const m of cls.methods) {
            csvRows.push(`"${relPath}","${lang}",${lineCount},"${cls.name}","${cls.qualifiedName}","${cls.kind}","${m.name}","${m.signature}",${m.cyclomaticComplexity},${m.mcdcRequired}`);
          }
        }
        writeFileSync(csvPath, csvRows.join('\n'));
      }

      totalClassCount += classCount;
      totalMethodCount += methodCount;
      results.push({ name: mod.name, fileCount: mod.files.length, classCount, methodCount, dir: modOutDir });
    }

    return {
      moduleCount: results.length,
      classCount: totalClassCount,
      methodCount: totalMethodCount,
      modules: results,
    };
  }

  // ── Single file sync ──────────────────────────────────────────────────────

  async syncFile(absPath) {
    const relPath = relative(this.projectRoot, absPath);
    const lang = extname(absPath).slice(1);
    const content = readFileSync(absPath, 'utf8');
    const hash = sha256(content);
    const lineCount = content.split('\n').length;

    // Always re-parse: cascade-delete existing data to avoid UNIQUE constraint
    const existing = this.db.getFile(relPath);
    if (existing) {
      this.db.db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
    }

    let parsed;
    if (lang === 'java') parsed = parseJava(content, relPath);
    else if (lang === 'xtend') parsed = parseXtend(content, relPath);
    else return { skipped: true };

    const ingest = new IrIngest(this.db);
    const result = ingest.ingest(parsed, { filePath: relPath, absPath, lang, sha256: hash, lineCount });

    return { relPath, classCount: result.classCount, methodCount: result.methodCount, errorCount: result.errors.length };
  }
}
