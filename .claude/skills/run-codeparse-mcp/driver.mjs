#!/usr/bin/env node
/**
 * driver.mjs — Programmatic harness for codeparse-mcp.
 *
 * Three modes:
 *   1. CLI:   node driver.mjs cli <init|sync|status|sync-file> [args...]
 *   2. MCP:   node driver.mjs mcp <tool-name> <json-args>
 *   3. Smoke: node driver.mjs smoke <project-root>
 *
 * When used as a module:
 *   import { cli, mcpQuery, fullPipeline } from './driver.mjs';
 */

import { spawn, execSync } from 'child_process';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');          // <unit> root
const CLI_SCRIPT = join(ROOT, 'src/cli/index.js');
const MCP_SERVER = join(ROOT, 'src/mcp/server.js');

// ── CLI ───────────────────────────────────────────────────────────────────────────

/**
 * Run a CLI command and return { code, stdout, stderr }.
 * @param {string} cwd  — project root to operate on
 * @param  {...string} args  — e.g. 'init', '--force' or 'sync', '--verbose'
 */
export function cli(cwd, ...args) {
  const result = execSync(`node ${CLI_SCRIPT} ${args.join(' ')}`, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ── MCP ───────────────────────────────────────────────────────────────────────────

/**
 * Send one JSON-RPC request to the MCP server and return the parsed response.
 * The server is launched and killed for each call.
 *
 * @param {string}  cwd      — project root (where .codeparse.json lives)
 * @param {string}  tool     — tool name, e.g. 'get_class'
 * @param {object}  args     — tool arguments
 * @param {object}  [opts]
 * @param {number}  [opts.port]       — not used (stdio), kept for API compat
 * @param {number}  [opts.waitMs=2000]  — ms to wait before sending request
 * @returns {Promise<{id, result, error}>}
 */
export async function mcpQuery(cwd, tool, args = {}, opts = {}) {
  const waitMs = opts.waitMs ?? 2000;
  return new Promise((resolvePromise, reject) => {
    const proc = spawn('node', [MCP_SERVER], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 30_000,
    });

    let buf = '';
    let stderrBuf = '';
    let settled = false;

    proc.stdout.on('data', (data) => { buf += data.toString(); });
    proc.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (!proc.killed) proc.kill('SIGTERM');
      if (err) reject(err);
      else resolvePromise(result);
    };

    proc.on('error', (err) => finish(err));
    proc.on('exit', () => {
      // Parsed before exit — don't error
    });

    setTimeout(() => {
      const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n';
      proc.stdin.write(req);
    }, 1000);

    setTimeout(() => {
      const lines = buf.split('\n').filter(l => l.trim());
      let result = null;
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          if (p.id === 1) result = p;
        } catch (_) { /* skip partial lines */ }
      }
      if (result) {
        finish(null, result);
      } else {
        finish(new Error(`No response from MCP server for tool "${tool}". stderr:\n${stderrBuf}`));
      }
    }, waitMs);
  });
}

/**
 * Run the full pipeline against a project root: init, sync, status, then query.
 * Returns the status report and a few MCP responses.
 */
export async function fullPipeline(projectRoot) {
  projectRoot = resolve(projectRoot);

  console.log(`\n=== Full pipeline for ${projectRoot} ===\n`);

  // 1. Init
  console.log('▶️  Initializing DB...');
  cli(projectRoot, 'init', '--root', projectRoot);
  console.log('   ✅ init done\n');

  // 2. Sync
  console.log('▶️  Syncing files...');
  const syncOut = cli(projectRoot, 'sync', '--root', projectRoot, '--verbose');
  console.log(syncOut.stdout);
  console.log('   ✅ sync done\n');

  // 3. Status via CLI
  console.log('▶️  Status (CLI)...');
  const statusOut = cli(projectRoot, 'status', '--root', projectRoot);
  console.log(statusOut.stdout);
  console.log('   ✅ status done\n');

  // 4. MCP queries
  console.log('▶️  MCP: codeparse_status...');
  const mcpStatus = await mcpQuery(projectRoot, 'codeparse_status', {});
  console.log(`   ✅ got response (graph: ${mcpStatus?.result?.content?.[0]?.text?.slice(0, 80) || '?'})\n`);

  console.log('▶️  MCP: search_classes...');
  const searchResult = await mcpQuery(projectRoot, 'search_classes', { pattern: '' });
  const classes = (() => {
    try { return JSON.parse(searchResult?.result?.content?.[0]?.text || '[]'); }
    catch { return []; }
  })();
  console.log(`   ✅ found ${classes.length} class(es)\n`);

  console.log('=== Pipeline complete ===');
  return { status: statusOut.stdout, mcpStatus, classes };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === 'cli') {
  const cwd = process.argv[3];
  const args = process.argv.slice(4);
  try {
    const result = cli(cwd || process.cwd(), ...args);
    process.stdout.write(result.stdout);
    process.exit(result.code ?? 0);
  } catch (e) {
    process.stderr.write(e.stderr || e.message);
    process.exit(1);
  }
} else if (mode === 'mcp') {
  const cwd = process.argv[3];
  const tool = process.argv[4];
  const args = process.argv[5] ? JSON.parse(process.argv[5]) : {};
  mcpQuery(cwd || process.cwd(), tool, args).then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    process.stderr.write(e.message);
    process.exit(1);
  });
} else if (mode === 'smoke') {
  const projectRoot = process.argv[3];
  if (!projectRoot) { process.stderr.write('Usage: node driver.mjs smoke <project-root>\n'); process.exit(1); }
  fullPipeline(projectRoot).then(() => process.exit(0)).catch(e => { process.stderr.write(e.message); process.exit(1); });
} else if (mode) {
  process.stderr.write(`Unknown mode: ${mode}. Use: cli | mcp | smoke\n`);
  process.exit(1);
}
