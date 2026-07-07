#!/usr/bin/env node
// src/cli/index.js
// CLI for codeparse-mcp: init | sync | status | sync-file

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import chalk from 'chalk';
import { GraphDatabase } from '../db/database.js';
import { GraphBuilder } from '../graph/builder.js';
import { importJunitResults, importJacocoCoverage } from '../import/index.js';
import { generateEvidencePackage } from '../export/evidence-writer.js';

const program = new Command();

program
  .name('codeparse')
  .description('Code Parser → Graph DB → MCP Knowledge Base for ISO 26262 ASIL-D UT Generation')
  .version('2.5.0');

// ── Shared config ─────────────────────────────────────────────────────────────

function loadConfig(projectRoot) {
  const root = resolve(projectRoot ?? process.cwd());
  const cfgPath = join(root, '.codeparse.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return { ...cfg, projectRoot: root };
  }
  return {
    projectRoot: root,
    dbPath: join(root, '.codeparse', 'graph.db'),
    include: ['**/*.java', '**/*.xtend'],
    exclude: ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**'],
  };
}

function openDb(config) {
  const db = new GraphDatabase(config.dbPath);
  return db.open();
}

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize graph database for the project')
  .option('-r, --root <path>', 'Project root directory', process.cwd())
  .option('--db <path>', 'Custom database path')
  .option('-f, --force', 'Drop and recreate database', false)
  .action(async (opts) => {
    const root = resolve(opts.root);
    const dbPath = opts.db ? resolve(opts.db) : join(root, '.codeparse', 'graph.db');

    console.log(chalk.cyan('\n  codeparse-mcp  ') + chalk.gray('v2.5.0'));
    console.log(chalk.bold('\n🔧 Initializing graph database...\n'));
    console.log(chalk.gray(`  Project root : ${root}`));
    console.log(chalk.gray(`  Database     : ${dbPath}`));

    const db = new GraphDatabase(dbPath).open();

    if (opts.force) {
      console.log(chalk.yellow('\n  ⚠  Force flag set — dropping all tables...'));
      db.db.exec(`
        DROP TABLE IF EXISTS evidence_log;
        DROP TABLE IF EXISTS coverage_records;
        DROP TABLE IF EXISTS test_results;
        DROP TABLE IF EXISTS test_cases;
        DROP TABLE IF EXISTS mcdc_pairs;
        DROP TABLE IF EXISTS mcdc_conditions;
        DROP TABLE IF EXISTS conditions;
        DROP TABLE IF EXISTS decisions;
        DROP TABLE IF EXISTS call_edges;
        DROP TABLE IF EXISTS cfg_edges;
        DROP TABLE IF EXISTS cfg_nodes;
        DROP TABLE IF EXISTS fields;
        DROP TABLE IF EXISTS dependencies;
        DROP TABLE IF EXISTS methods;
        DROP TABLE IF EXISTS classes;
        DROP TABLE IF EXISTS packages;
        DROP TABLE IF EXISTS parse_errors;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS meta;
      `);
      db._applySchema();
    }

    const config = {
      projectRoot: root,
      dbPath,
      include: ['**/*.java', '**/*.xtend'],
      exclude: ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**'],
    };

    writeFileSync(join(root, '.codeparse.json'), JSON.stringify(config, null, 2));
    db.close();

    console.log(chalk.green('\n  ✅ Initialized successfully.'));
    console.log(chalk.gray('\n  Next step: ') + chalk.white('codeparse sync'));
    console.log();
  });

// ── sync ──────────────────────────────────────────────────────────────────────

program
  .command('sync')
  .description('Parse source files and sync to graph DB (incremental by default)')
  .option('-r, --root <path>', 'Project root directory')
  .option('-f, --force', 'Re-parse all files', false)
  .option('--include <patterns>', 'Comma-separated glob patterns', null)
  .option('--exclude <patterns>', 'Comma-separated glob patterns to exclude', null)
  .option('-v, --verbose', 'Show per-file progress', false)
  .action(async (opts) => {
    const config = loadConfig(opts.root);

    if (!existsSync(config.dbPath)) {
      console.error(chalk.red('\n  ❌ Database not found. Run: codeparse init\n'));
      process.exit(1);
    }

    const db = openDb(config);
    const builder = new GraphBuilder(db, config.projectRoot);

    const include = opts.include ? opts.include.split(',').map(s => s.trim()) : config.include;
    const exclude = opts.exclude ? opts.exclude.split(',').map(s => s.trim()) : config.exclude;

    console.log(chalk.cyan('\n  codeparse-mcp  ') + chalk.gray('sync'));
    console.log(chalk.gray(`\n  Root    : ${config.projectRoot}`));
    console.log(chalk.gray(`  Patterns: ${include.join(', ')}`));
    console.log(chalk.gray(`  Force   : ${opts.force}\n`));

    const spinner = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let spinIdx = 0;
    let lastMsg = '';

    const report = await builder.syncProject({
      force: opts.force,
      include,
      exclude,
      onProgress: opts.verbose
        ? ({ i, total, path }) => {
            process.stdout.write(`\r  ${spinner[spinIdx++ % spinner.length]} [${i}/${total}] ${path.slice(-60).padEnd(60)}`);
          }
        : ({ i, total }) => {
            if (i % 10 === 0) {
              process.stdout.write(`\r  ${spinner[spinIdx++ % spinner.length]} Parsing ${i}/${total} files...`);
            }
          },
    });

    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    console.log(chalk.bold('\n  📊 Sync Report\n'));
    console.log(`  ${chalk.white('Files scanned    :')} ${report.scanned}`);
    console.log(`  ${chalk.white('Files parsed     :')} ${chalk.green(report.parsed)}`);
    console.log(`  ${chalk.white('Files skipped    :')} ${chalk.gray(report.skipped)}`);
    if (report.errors > 0) {
      console.log(`  ${chalk.white('Parse errors     :')} ${chalk.red(report.errors)}`);
    }
    console.log(`  ${chalk.white('Classes found    :')} ${chalk.cyan(report.classes)}`);
    console.log(`  ${chalk.white('Methods found    :')} ${chalk.cyan(report.methods)}`);
    console.log(`  ${chalk.white('Call edges linked:')} ${chalk.gray(report.callEdgesResolved ?? 0)}`);
    console.log(`  ${chalk.white('Duration         :')} ${report.duration}ms`);

    if (report.errors > 0) {
      console.log(chalk.yellow('\n  ⚠  Some files had parse errors. Run: codeparse status'));
    }

    console.log(chalk.green('\n  ✅ Sync complete.\n'));
    db.close();
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show graph DB status and statistics')
  .option('-r, --root <path>', 'Project root directory')
  .option('--errors', 'Show parse error details', false)
  .action(async (opts) => {
    const config = loadConfig(opts.root);

    if (!existsSync(config.dbPath)) {
      console.error(chalk.red('\n  ❌ Database not found. Run: codeparse init\n'));
      process.exit(1);
    }

    const db = openDb(config);
    const stats = db.getStats();
    const files = db.getAllFiles();
    const errorFiles = files.filter(f => f.status === 'error');

    console.log(chalk.cyan('\n  codeparse-mcp  ') + chalk.gray('status'));
    console.log(chalk.gray(`\n  Root : ${config.projectRoot}`));
    console.log(chalk.gray(`  DB   : ${config.dbPath}\n`));

    console.log(chalk.bold('  📁 Source Files'));
    console.log(`     Total       : ${chalk.white(stats.files.n ?? 0)}`);
    console.log(`     Total lines : ${chalk.white((stats.files.lines ?? 0).toLocaleString())}`);
    console.log(`     Errors      : ${errorFiles.length > 0 ? chalk.red(errorFiles.length) : chalk.green(0)}`);

    const javaCount = files.filter(f => f.lang === 'java').length;
    const xtendCount = files.filter(f => f.lang === 'xtend').length;
    console.log(`     Java        : ${chalk.gray(javaCount)}`);
    console.log(`     Xtend       : ${chalk.gray(xtendCount)}`);

    console.log(chalk.bold('\n  🔷 Graph Data'));
    console.log(`     Classes     : ${chalk.cyan(stats.classes.n ?? 0)}`);
    console.log(`     Methods     : ${chalk.cyan(stats.methods.n ?? 0)}`);
    console.log(`     Avg CC      : ${chalk.gray(Math.round(((stats.methods.avg_cc ?? 1)) * 10) / 10)}`);
    console.log(`     CFG Nodes   : ${chalk.gray(stats.cfg_nodes.n ?? 0)}`);
    console.log(`     CFG Edges   : ${chalk.gray(stats.cfg_edges.n ?? 0)}`);
    console.log(`     Call edges  : ${chalk.gray(stats.call_edges.n ?? 0)}`);
    console.log(`     Total branches : ${chalk.gray(stats.methods.total_branches ?? 0)}`);

    console.log(chalk.bold('\n  🎯 MC/DC (ISO 26262 ASIL-D)'));
    console.log(`     MC/DC conditions : ${chalk.green(stats.mcdc.n ?? 0)}`);
    console.log(`     Parse errors     : ${stats.errors.n > 0 ? chalk.red(stats.errors.n) : chalk.green(0)}`);

    if (opts.errors && errorFiles.length > 0) {
      console.log(chalk.bold('\n  ❌ Error Files:'));
      for (const f of errorFiles.slice(0, 20)) {
        console.log(`     ${chalk.red('✗')} ${f.path}`);
      }
    }

    console.log(chalk.bold('\n  🔌 MCP Integration'));
    console.log(`     Server command : ${chalk.white('node src/mcp/server.js')}`);
    console.log(`     Tools exposed  : ${chalk.white('17 tools')}`);
    console.log(`     Protocol       : ${chalk.gray('MCP stdio (compatible with GitHub Copilot)')}`);
    console.log();

    db.close();
  });

// ── sync-file ─────────────────────────────────────────────────────────────────

program
  .command('sync-file <path>')
  .description('Parse and sync a single file to the graph DB')
  .option('-r, --root <path>', 'Project root directory')
  .action(async (filePath, opts) => {
    const config = loadConfig(opts.root);

    if (!existsSync(config.dbPath)) {
      console.error(chalk.red('\n  ❌ Database not found. Run: codeparse init\n'));
      process.exit(1);
    }

    const absPath = existsSync(filePath) ? resolve(filePath) : join(config.projectRoot, filePath);

    if (!existsSync(absPath)) {
      console.error(chalk.red(`\n  ❌ File not found: ${filePath}\n`));
      process.exit(1);
    }

    const db = openDb(config);
    const builder = new GraphBuilder(db, config.projectRoot);
    const result = await builder.syncFile(absPath);
    db.close();

    if (result.skipped) {
      console.log(chalk.gray(`  Skipped (unsupported file type): ${filePath}`));
    } else {
      console.log(chalk.green(`  ✅ Synced: ${result.relPath}`));
      console.log(chalk.gray(`     Classes: ${result.classCount}, Methods: ${result.methodCount}, Errors: ${result.errorCount}`));
    }
  });

// ── import-results ────────────────────────────────────────────────────────────

program
  .command('import-results')
  .description('Import JUnit test results and JaCoCo coverage data')
  .requiredOption('--junit <path>', 'Path to JUnit XML report file or directory of Surefire reports')
  .option('--jacoco <path>', 'Path to JaCoCo XML coverage report')
  .option('-r, --root <path>', 'Project root directory')
  .action(async (opts) => {
    const config = loadConfig(opts.root);

    if (!existsSync(config.dbPath)) {
      console.error(chalk.red('\n  ❌ Database not found. Run: codeparse init\n'));
      process.exit(1);
    }

    const db = openDb(config);

    console.log(chalk.cyan('\n  codeparse-mcp  ') + chalk.gray('import-results'));

    let testCount = 0, passedCount = 0, failedCount = 0, errorCount = 0;
    let coverageCount = 0;

    if (opts.junit) {
      const results = await importJunitResults(db, opts.junit, config.projectRoot);
      testCount = results.total;
      passedCount = results.passed;
      failedCount = results.failed;
      errorCount = results.errors;
      console.log(chalk.bold('\n  🧪 JUnit Results\n'));
      console.log(`  ${chalk.white('Imported  :')} ${chalk.green(testCount)}`);
      console.log(`  ${chalk.white('Passed    :')} ${chalk.green(passedCount)}`);
      console.log(`  ${chalk.white('Failed    :')} ${failedCount > 0 ? chalk.red(failedCount) : chalk.green(failedCount)}`);
      if (errorCount > 0) console.log(`  ${chalk.white('Errors    :')} ${chalk.red(errorCount)}`);
    }

    if (opts.jacoco) {
      const count = await importJacocoCoverage(db, opts.jacoco);
      coverageCount = count;
      console.log(chalk.bold('\n  📊 Coverage Results\n'));
      console.log(`  ${chalk.white('Records   :')} ${chalk.green(coverageCount)}`);
    }

    console.log(chalk.green('\n  ✅ Import complete.\n'));
    db.close();
  });

// ── evidence ─────────────────────────────────────────────────────────────────

program
  .command('evidence')
  .description('Generate ISO 26262 evidence package for a class')
  .requiredOption('--asil <level>', 'ASIL safety level (A, B, C, D, or QM)')
  .requiredOption('--class <qname>', 'Fully qualified class name')
  .requiredOption('--output <path>', 'Output directory for evidence package')
  .option('-r, --root <path>', 'Project root directory')
  .action(async (opts) => {
    const config = loadConfig(opts.root);

    if (!existsSync(config.dbPath)) {
      console.error(chalk.red('\n  ❌ Database not found. Run: codeparse init\n'));
      process.exit(1);
    }

    const db = openDb(config);
    const asilLevel = `ASIL-${opts.asil.toUpperCase()}`;
    const outputPath = resolve(opts.output);

    console.log(chalk.cyan('\n  codeparse-mcp  ') + chalk.gray('evidence'));
    console.log(chalk.bold('\n  Generating ISO 26262 Evidence Package...\n'));
    console.log(`  ${chalk.white('Target class :')} ${opts['class']}`);
    console.log(`  ${chalk.white('ASIL level   :')} ${chalk.yellow(asilLevel)}`);
    console.log(`  ${chalk.white('Output dir   :')} ${outputPath}`);

    try {
      const { files, summary } = await generateEvidencePackage(db, opts['class'], asilLevel, outputPath);

      console.log(chalk.bold('\n  📦 Generated Files\n'));
      for (const f of files) {
        const icon = f.status === 'ok' ? chalk.green('✓') : chalk.yellow('⚠');
        console.log(`  ${icon} ${f.file}  ${chalk.gray(f.status)}`);
      }

      console.log(chalk.bold('\n  📊 Summary\n'));
      console.log(`  ${chalk.white('Methods     :')} ${chalk.cyan(summary.methods)}`);
      console.log(`  ${chalk.white('Decisions   :')} ${chalk.cyan(summary.decisions)}`);
      console.log(`  ${chalk.white('MC/DC Pairs :')} ${chalk.cyan(summary.mcdcPairs)}`);
      console.log(`  ${chalk.white('Test Cases  :')} ${chalk.cyan(summary.testCases)}`);
      console.log(`  ${chalk.white('Coverage    :')} ${chalk.cyan(summary.coverageRecords)}`);

      if (!summary.allOk) {
        console.log(chalk.yellow('\n  ⚠  Some files had errors.'));
      }

      console.log(chalk.green('\n  ✅ Evidence package generated.\n'));
    } catch (err) {
      console.error(chalk.red(`\n  ❌ Error: ${err.message}\n`));
      process.exit(1);
    }

    db.close();
  });

// ── serve ─────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the MCP server (stdio)')
  .action(async () => {
    // Dynamically import to avoid loading SDK if not needed
    await import('../mcp/server.js');
  });

program.parse();
