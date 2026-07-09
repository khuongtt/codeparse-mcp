// src/mcp/server.js
// MCP Server for codeparse-mcp
// Protocol: Model Context Protocol (stdio transport)
// Compatible with GitHub Copilot, Claude Desktop, and any MCP client

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { GraphDatabase } from '../db/database.js';
import { GraphBuilder } from '../graph/builder.js';
import { importJunitResults, importJacocoCoverage } from '../import/index.js';
import { generateEvidencePackage } from '../export/evidence-writer.js';
import {
  decodeHtmlEntities,
  decodeMcdcConditions,
  readSourceRange,
  buildParseQuality,
  recommendedNextActions,
  estimateTokens,
  MAX_SOURCE_LINES_PER_METHOD,
  MAX_CONTEXT_TOKENS,
} from './util.js';

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = resolve(process.cwd(), '.codeparse.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }
  return {
    projectRoot: process.cwd(),
    dbPath: join(process.cwd(), '.codeparse', 'graph.db'),
    include: ['**/*.java', '**/*.xtend'],
    exclude: ['**/node_modules/**', '**/build/**', '**/target/**', '**/.gradle/**'],
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

const config = loadConfig();
const db = new GraphDatabase(config.dbPath);
db.open();

const server = new Server(
  { name: 'codeparse-mcp', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  // ── Init / Sync / Status ─────────────────────────────────────────────────

  {
    name: 'codeparse_init',
    description: 'Initialize the graph database for the project. Creates schema and resets all data. Required before first use.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'Absolute path to project root (defaults to cwd)' },
        force: { type: 'boolean', description: 'Drop and recreate all tables', default: false },
      },
    },
  },

  {
    name: 'codeparse_sync',
    description: 'Parse all Java/Xtend source files and sync changes to the graph DB. Only re-parses changed files (by SHA-256). Returns a report.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Re-parse all files even if unchanged', default: false },
        include: {
          type: 'array', items: { type: 'string' },
          description: 'Glob patterns to include (default: **/*.java, **/*.xtend)',
        },
        exclude: {
          type: 'array', items: { type: 'string' },
          description: 'Glob patterns to exclude',
        },
      },
    },
  },

  {
    name: 'codeparse_status',
    description: 'Show current status of the graph DB: file count, class count, method count, CFG stats, MC/DC conditions, parse errors.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Class queries ────────────────────────────────────────────────────────

  {
    name: 'get_class',
    description: 'Get full class information: fields, hierarchy, annotations, ASIL level. Used to understand class structure for UT generation.',
    inputSchema: {
      type: 'object',
      required: ['qualifiedName'],
      properties: {
        qualifiedName: { type: 'string', description: 'Fully qualified class name, e.g. com.example.SafetyModule' },
      },
    },
  },

  {
    name: 'search_classes',
    description: 'Search for classes by name or qualified name pattern. Returns matching class summaries.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Search pattern (substring match)' },
      },
    },
  },

  // ── Method queries ───────────────────────────────────────────────────────

  {
    name: 'get_methods',
    description: 'Get all methods for a class including signatures, parameters, visibility, ASIL, cyclomatic complexity.',
    inputSchema: {
      type: 'object',
      required: ['qualifiedName'],
      properties: {
        qualifiedName: { type: 'string', description: 'Fully qualified class name' },
      },
    },
  },

  {
    name: 'search_methods',
    description: 'Search for methods by name or signature pattern across all classes.',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Method name or signature pattern' },
      },
    },
  },

  // ── CFG queries ──────────────────────────────────────────────────────────

  {
    name: 'get_cfg',
    description: 'Get the Control Flow Graph for a specific method. Returns nodes (ENTRY, STATEMENT, BRANCH, LOOP, RETURN, etc.) and edges (sequential, true_branch, false_branch, exception). Used for C0/C1 coverage analysis.',
    inputSchema: {
      type: 'object',
      required: ['methodId'],
      properties: {
        methodId: { type: 'number', description: 'Method DB ID (from get_methods response)' },
      },
    },
  },

  // ── Decision / MC/DC queries ─────────────────────────────────────────────

  {
    name: 'get_decisions',
    description: 'Get all decisions (if, while, for, do, switch) for a method with their atomic conditions. Each decision has a unique D-UID and decomposed atomic conditions. Required for decision-level MC/DC planning.',
    inputSchema: {
      type: 'object',
      required: ['method_id'],
      properties: {
        method_id: { type: 'number', description: 'Method DB ID (from get_methods response)' },
      },
    },
  },

  {
    name: 'get_mcdc',
    description: 'Get MC/DC (Modified Condition/Decision Coverage) analysis for a method. Returns boolean conditions, atomic sub-conditions, truth tables, and independence pairs required for ISO 26262 ASIL-D 100% MC/DC. Used directly by AI to generate test cases.',
    inputSchema: {
      type: 'object',
      required: ['methodId'],
      properties: {
        methodId: { type: 'number', description: 'Method DB ID' },
      },
    },
  },

  {
    name: 'get_mcdc_for_class',
    description: 'Get all MC/DC conditions for every method in a class. Returns the full MC/DC knowledge base needed to generate ASIL-D compliant unit tests with 100% MC/DC coverage.',
    inputSchema: {
      type: 'object',
      required: ['qualifiedName'],
      properties: {
        qualifiedName: { type: 'string', description: 'Fully qualified class name' },
      },
    },
  },

  // ── Call graph queries ───────────────────────────────────────────────────

  {
    name: 'get_callees',
    description: 'Get all methods called by a given method. Used to identify mock targets for unit test isolation.',
    inputSchema: {
      type: 'object',
      required: ['methodId'],
      properties: {
        methodId: { type: 'number', description: 'Method DB ID' },
      },
    },
  },

  {
    name: 'get_callers',
    description: 'Get all methods that call a given method. Useful for impact analysis.',
    inputSchema: {
      type: 'object',
      required: ['methodId'],
      properties: {
        methodId: { type: 'number', description: 'Method DB ID' },
      },
    },
  },

  // ── Knowledge base for UT generation ────────────────────────────────────

  {
    name: 'get_ut_context',
    description: 'Get the complete unit test context for a class or method: class info, all methods with signatures, CFG, MC/DC conditions, call sites for mocking, and field dependencies. This is the primary tool for AI-driven UT generation targeting ISO 26262 ASIL-D compliance with 100% MC/DC + C0 + C1 coverage.',
    inputSchema: {
      type: 'object',
      required: ['qualifiedName'],
      properties: {
        qualifiedName: { type: 'string', description: 'Fully qualified class name' },
        methodName: { type: 'string', description: 'Optional: focus on a specific method' },
      },
    },
  },

  {
    name: 'get_dependencies',
    description: 'Get all import dependencies for a file. Used to understand what needs to be imported/mocked in unit tests.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Relative file path' },
      },
    },
  },

  // ── Sync single file ─────────────────────────────────────────────────────

  {
    name: 'sync_file',
    description: 'Parse and sync a single source file to the graph DB. Useful for incremental updates during development.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Absolute or relative path to the Java/Xtend file' },
      },
    },
  },

  // ── Method context ──────────────────────────────────────────────────────

  {
    name: 'get_method_context',
    description: 'Get full source context for a method: source code, fields read/written, calls, decisions, and parse quality. Use this instead of reading source files directly.',
    inputSchema: {
      type: 'object',
      required: ['method_id'],
      properties: {
        method_id: { type: 'number', description: 'Method DB ID (from get_methods response)' },
        include_source: { type: 'boolean', description: 'Include source code snippet', default: true },
        include_fields: { type: 'boolean', description: 'Include class fields used by this method', default: true },
        include_calls: { type: 'boolean', description: 'Include method calls from this method', default: true },
        include_decisions: { type: 'boolean', description: 'Include decisions/conditions for MC/DC', default: true },
      },
    },
  },

  // ── Evidence tools (v2.5.0) ──────────────────────────────────────────────

  {
    name: 'import_test_results',
    description: 'Import JUnit XML test results and JaCoCo XML coverage data into the graph DB. Supports Surefire format JUnit XML and standard JaCoCo XML.',
    inputSchema: {
      type: 'object',
      properties: {
        junitPath: { type: 'string', description: 'Path to JUnit XML file or directory of TEST-*.xml files' },
        jacocoPath: { type: 'string', description: 'Path to JaCoCo XML coverage report (jacoco.xml)' },
      },
    },
  },

  {
    name: 'get_coverage_summary',
    description: 'Get coverage summary for a class or method. Returns line/branch/instruction coverage percentages from imported JaCoCo data.',
    inputSchema: {
      type: 'object',
      properties: {
        qualifiedName: { type: 'string', description: 'Fully qualified class name' },
        methodId: { type: 'number', description: 'Method DB ID (alternative to qualifiedName for single method)' },
      },
    },
  },

  {
    name: 'export_evidence_plan',
    description: 'Generate an ISO 26262 ASIL-D evidence package for a class. Returns the list of generated files. Writes to disk — does not return file contents.',
    inputSchema: {
      type: 'object',
      required: ['qualifiedName', 'asilLevel'],
      properties: {
        qualifiedName: { type: 'string', description: 'Fully qualified class name' },
        asilLevel: { type: 'string', description: 'ASIL level: A, B, C, D, or QM', default: 'D' },
        outputDir: { type: 'string', description: 'Output directory (default: evidence/{className})' },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args ?? {});
    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function handleTool(name, args) {
  switch (name) {

    // ── Init ───────────────────────────────────────────────────────────────

    case 'codeparse_init': {
      const root = args.projectRoot ? resolve(args.projectRoot) : resolve(config.projectRoot);
      if (args.force) {
        // Drop and recreate
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
      // Save config
      const cfg = { projectRoot: root, dbPath: config.dbPath, include: config.include, exclude: config.exclude };
      const { writeFileSync } = await import('fs');
      writeFileSync(join(root, '.codeparse.json'), JSON.stringify(cfg, null, 2));

      return {
        status: 'initialized',
        projectRoot: root,
        dbPath: config.dbPath,
        message: 'Graph database initialized. Run codeparse_sync to parse source files.',
      };
    }

    // ── Sync ───────────────────────────────────────────────────────────────

    case 'codeparse_sync': {
      const builder = new GraphBuilder(db, config.projectRoot);
      const report = await builder.syncProject({
        force: args.force ?? false,
        include: args.include ?? config.include,
        exclude: args.exclude ?? config.exclude,
      });
      return {
        status: 'synced',
        ...report,
        duration_ms: report.duration,
      };
    }

    // ── Status ─────────────────────────────────────────────────────────────

    case 'codeparse_status': {
      const stats = db.getStats();
      const files = db.getAllFiles();
      const errorFiles = files.filter(f => f.status === 'error');
      return {
        status: 'ok',
        projectRoot: config.projectRoot,
        dbPath: config.dbPath,
        files: {
          total: stats.files.n ?? 0,
          total_lines: stats.files.lines ?? 0,
          errors: errorFiles.length,
        },
        graph: {
          classes: stats.classes.n ?? 0,
          methods: stats.methods.n ?? 0,
          avg_cyclomatic_complexity: Math.round((stats.methods.avg_cc ?? 1) * 10) / 10,
          total_branches: stats.methods.total_branches ?? 0,
          cfg_nodes: stats.cfg_nodes.n ?? 0,
          cfg_edges: stats.cfg_edges.n ?? 0,
          call_edges: stats.call_edges.n ?? 0,
          mcdc_conditions: stats.mcdc.n ?? 0,
        },
        parse_errors: stats.errors.n ?? 0,
        error_files: errorFiles.map(f => f.path),
      };
    }

    // ── Get class ──────────────────────────────────────────────────────────

    case 'get_class': {
      const cls = db.getClassByQualifiedName(args.qualifiedName);
      if (!cls) return { error: `Class not found: ${args.qualifiedName}` };

      const file = db.db.prepare('SELECT path, lang FROM files WHERE id = ?').get(cls.file_id);

      return {
        ...cls,
        javadoc: decodeHtmlEntities(cls.javadoc),
        file: file ? { path: file.path, language: file.lang } : null,
        interfaces: cls.interfaces,
        annotations: cls.annotations,
        parse_quality: { status: 'ok', warnings: [] },
        recommended_next_actions: recommendedNextActions('get_class', {
          qualifiedName: cls.qualified_name,
        }),
      };
    }

    case 'search_classes': {
      const classes = db.searchClasses(args.pattern);
      return {
        results: classes.map(c => ({
          id: c.id,
          qualifiedName: c.qualified_name,
          name: c.name,
          kind: c.kind,
          isAbstract: !!c.is_abstract,
          asilLevel: c.asil_level,
          lineStart: c.line_start,
        })),
        recommended_next_actions: classes.length > 0
          ? [{ tool: 'get_class', input: { qualifiedName: classes[0].qualified_name }, reason: 'View full class details' }]
          : [],
      };
    }

    // ── Methods ────────────────────────────────────────────────────────────

    case 'get_methods': {
      const cls = db.getClassByQualifiedName(args.qualifiedName);
      if (!cls) return { error: `Class not found: ${args.qualifiedName}` };
      const methods = db.getMethodsForClass(cls.id);
      return {
        class: {
          id: cls.id,
          name: cls.name,
          qualifiedName: cls.qualified_name,
        },
        methods: methods.map(m => ({
          ...m,
          javadoc: decodeHtmlEntities(m.javadoc),
          boolean_conditions: (m.boolean_conditions || []).map(decodeHtmlEntities),
          parse_quality: buildParseQuality(m),
          recommended_next_actions: recommendedNextActions('get_methods', {
            methodId: m.id,
            qualifiedName: cls.qualified_name,
          }),
        })),
      };
    }

    case 'search_methods': {
      const results = db.searchMethods(args.pattern);
      return {
        results: results.map(m => ({
          ...m,
          boolean_conditions: (m.boolean_conditions || []).map(decodeHtmlEntities),
        })),
        recommended_next_actions: results.length > 0
          ? [{ tool: 'get_method_context', input: { method_id: results[0].id }, reason: 'Get full context for this method' }]
          : [],
      };
    }

    // ── CFG ────────────────────────────────────────────────────────────────

    case 'get_cfg': {
      const cfg = db.getCfgForMethod(args.methodId);
      const method = db.db.prepare(`
        SELECT m.name, m.signature, f.path AS _file_path
        FROM methods m
        JOIN files f ON f.id = m.file_id
        WHERE m.id = ?
      `).get(args.methodId);
      return {
        method_id: args.methodId,
        method_name: method?.name,
        signature: method?.signature,
        file: method ? { path: method._file_path } : null,
        nodes: (cfg.nodes || []).map(n => ({
          ...n,
          condition: decodeHtmlEntities(n.condition),
          label: decodeHtmlEntities(n.label),
        })),
        edges: cfg.edges,
        recommended_next_actions: recommendedNextActions('get_cfg', {
          methodId: args.methodId,
        }),
      };
    }

    // ── Decisions ──────────────────────────────────────────────────────────

    case 'get_decisions': {
      const decMethodId = args.method_id;
      const decMethod = db.db.prepare(`
        SELECT m.name, m.signature, m.cyclomatic_complexity, m.branch_count, m.condition_count,
               c.qualified_name AS class_qualified_name,
               f.path AS _file_path
        FROM methods m
        JOIN classes c ON c.id = m.class_id
        JOIN files f ON f.id = m.file_id
        WHERE m.id = ?
      `).get(decMethodId);

      if (!decMethod) return { error: `Method not found: ${decMethodId}` };

      const decisions = db.getDecisionsForMethod(decMethodId);

      return {
        status: 'ok',
        method_id: decMethodId,
        method_name: decMethod.name,
        signature: decMethod.signature,
        class_qualified_name: decMethod.class_qualified_name,
        file: { path: decMethod._file_path },
        decisions: decisions.map(d => ({
          decision_uid: d.decision_uid,
          kind: d.kind,
          line_start: d.line_start,
          expression: decodeHtmlEntities(d.expression),
          normalized: decodeHtmlEntities(d.normalized),
          operator: d.operator,
          branch_count: d.branch_count,
          mcdc_required: !!d.mcdc_required,
          parse_status: d.parse_status,
          conditions: (d.conditions || []).map(c => ({
            condition_uid: c.condition_uid,
            text: decodeHtmlEntities(c.text),
            normalized_text: decodeHtmlEntities(c.normalized_text),
            position: c.position,
            condition_type: c.condition_type,
            parse_status: c.parse_status,
          })),
        })),
        decision_count: decisions.length,
        mcdc_required_count: decisions.filter(d => !!d.mcdc_required).length,
        recommended_next_actions: recommendedNextActions('get_decisions', {
          methodId: decMethodId,
          qualifiedName: decMethod.class_qualified_name,
        }),
      };
    }

    // ── MC/DC ──────────────────────────────────────────────────────────────

    case 'get_mcdc': {
      const conditions = db.getMcdcForMethod(args.methodId);
      const method = db.db.prepare(`
        SELECT m.*, f.path AS _file_path
        FROM methods m
        JOIN files f ON f.id = m.file_id
        WHERE m.id = ?
      `).get(args.methodId);

      if (!method) return { error: `Method not found: ${args.methodId}` };

      let bc = [];
      try { bc = JSON.parse(method.boolean_conditions ?? '[]'); } catch (_) {}
      bc = bc.map(decodeHtmlEntities);

      const decodedConds = decodeMcdcConditions(conditions);
      const decisions = db.getDecisionsForMethod(args.methodId);

      return {
        method_id: args.methodId,
        method_name: method.name,
        signature: method.signature,
        branch_count: method.branch_count,
        condition_count: method.condition_count,
        cyclomatic_complexity: method.cyclomatic_complexity,
        boolean_conditions: bc,
        decisions: decisions.length > 0 ? decisions.map(d => ({
          decision_uid: d.decision_uid,
          kind: d.kind,
          expression: decodeHtmlEntities(d.normalized || d.expression),
          mcdc_required: !!d.mcdc_required,
          conditions: (d.conditions || []).map(c => ({
            condition_uid: c.condition_uid,
            text: decodeHtmlEntities(c.text),
          })),
          mcdc_analysis: decodedConds.filter(mc =>
            mc.expression === d.expression || mc.expression === d.normalized
          ).map(mc => ({
            sub_conditions: mc.subConditions,
            truth_table: mc.truthTable,
            mcdc_pairs: mc.mcdcPairs,
          })),
        })) : undefined,
        mcdc_conditions: decodedConds,
        file: { path: method._file_path },
        coverage_requirements: {
          c0_statement: 'Every statement must be executed',
          c1_branch: `All ${method.branch_count ?? 0} branches (true/false) must be covered`,
          mcdc: `${decisions.filter(d => !!d.mcdc_required).length} compound decisions require MC/DC independence pairs`,
          asil_d_target: '100% MC/DC required',
        },
        parse_quality: buildParseQuality(method),
        recommended_next_actions: recommendedNextActions('get_mcdc', {
          methodId: method.id,
        }),
      };
    }

    case 'get_mcdc_for_class': {
      const cls = db.getClassByQualifiedName(args.qualifiedName);
      if (!cls) return { error: `Class not found: ${args.qualifiedName}` };
      const methods = db.getMethodsForClass(cls.id);
      const result = [];
      for (const m of methods) {
        const conditions = db.getMcdcForMethod(m.id);
        if (conditions.length > 0 || m.branch_count > 0) {
          result.push({
            method_id: m.id,
            method_name: m.name,
            signature: m.signature,
            branch_count: m.branch_count,
            condition_count: m.condition_count,
            cyclomatic_complexity: m.cyclomatic_complexity,
            boolean_conditions: (m.boolean_conditions || []).map(decodeHtmlEntities),
            mcdc_conditions: decodeMcdcConditions(conditions),
            parse_quality: buildParseQuality(m),
          });
        }
      }
      return {
        class_name: cls.name,
        qualified_name: cls.qualified_name,
        methods: result,
        recommended_next_actions: recommendedNextActions('get_mcdc_for_class', {
          qualifiedName: cls.qualified_name,
        }),
      };
    }

    // ── Call graph ─────────────────────────────────────────────────────────

    case 'get_callees': {
      const callees = db.getCallees(args.methodId);
      return {
        method_id: args.methodId,
        callees: callees.map(c => ({
          callee_name: c.callee_name,
          callee_id: c.callee_id,
          signature: c.signature,
          qualified_name: c.qualified_name,
          resolved: !!c.callee_id,
        })),
        recommended_next_actions: recommendedNextActions('get_callees', {
          methodId: args.methodId,
        }),
      };
    }

    case 'get_callers': {
      const callers = db.db.prepare(`
        SELECT ce.*, m.signature, m.name as method_name, c.qualified_name as class_name
        FROM call_edges ce
        JOIN methods m ON m.id = ce.caller_id
        JOIN classes c ON c.id = m.class_id
        WHERE ce.callee_id = ?
      `).all(args.methodId);
      return {
        method_id: args.methodId,
        callers,
        recommended_next_actions: [],
      };
    }

    // ── Full UT context ────────────────────────────────────────────────────

    case 'get_ut_context': {
      const cls = db.getClassByQualifiedName(args.qualifiedName);
      if (!cls) return { error: `Class not found: ${args.qualifiedName}` };

      const file = db.db.prepare('SELECT * FROM files WHERE id = ?').get(cls.file_id);
      const allMethods = db.getMethodsForClass(cls.id);
      const fields = db.db.prepare('SELECT * FROM fields WHERE class_id = ?').all(cls.id)
        .map(f => ({ ...f, annotations: JSON.parse(f.annotations ?? '[]') }));

      const deps = db.db.prepare(`
        SELECT * FROM dependencies WHERE from_file_id = ?
      `).all(cls.file_id);

      let targetMethods = allMethods;
      if (args.methodName) {
        targetMethods = allMethods.filter(m => m.name === args.methodName);
      }

      const methodContexts = [];
      for (const m of targetMethods) {
        const cfg = db.getCfgForMethod(m.id);
        const mcdc = db.getMcdcForMethod(m.id);
        const decisions = db.getDecisionsForMethod(m.id);
        const callees = db.getCallees(m.id);

        methodContexts.push({
          id: m.id,
          name: m.name,
          signature: m.signature,
          return_type: m.return_type,
          visibility: m.visibility,
          is_static: m.is_static,
          is_abstract: m.is_abstract,
          annotations: m.annotations,
          parameters: m.parameters,
          throws_list: m.throws_list,
          javadoc: decodeHtmlEntities(m.javadoc),
          line_start: m.line_start,
          line_end: m.line_end,
          asil_level: m.asil_level,
          cyclomatic_complexity: m.cyclomatic_complexity,
          branch_count: m.branch_count,
          condition_count: m.condition_count,
          decision_count: decisions.length,
          boolean_conditions: (m.boolean_conditions || []).map(decodeHtmlEntities),
          decisions: decisions.map(d => ({
            decision_uid: d.decision_uid,
            kind: d.kind,
            line_start: d.line_start,
            expression: decodeHtmlEntities(d.expression),
            normalized: decodeHtmlEntities(d.normalized),
            conditions: (d.conditions || []).map(c => ({
              condition_uid: c.condition_uid,
              text: decodeHtmlEntities(c.text),
              position: c.position,
            })),
            mcdc_required: !!d.mcdc_required,
          })),
          file: m.file,
          cfg: {
            node_count: cfg.nodes.length,
            edge_count: cfg.edges.length,
            nodes: (cfg.nodes || []).map(n => ({
              ...n,
              condition: decodeHtmlEntities(n.condition),
              label: decodeHtmlEntities(n.label),
            })),
            edges: cfg.edges,
          },
          mcdc_conditions: decodeMcdcConditions(mcdc),
          mock_targets: callees.map(c => ({
            callee_name: c.callee_name,
            line: c.line,
            resolved: !!c.callee_id,
          })),
          coverage_requirements: {
            c0_statement: 'All statements executed',
            c1_branch: `${m.branch_count} branches — true+false for each`,
            mcdc: mcdc.length > 0
              ? `${mcdc.length} decisions, each with independence pairs`
              : 'No complex boolean decisions',
            asil_d: 'ISO 26262 ASIL-D: 100% MC/DC mandatory',
          },
          parse_quality: buildParseQuality(m),
          recommended_next_actions: recommendedNextActions('get_ut_context', {
            methodId: m.id,
            qualifiedName: cls.qualified_name,
          }),
        });
      }

      return {
        class: {
          id: cls.id,
          qualifiedName: cls.qualified_name,
          name: cls.name,
          kind: cls.kind,
          isAbstract: !!cls.is_abstract,
          superclass: cls.superclass,
          interfaces: cls.interfaces,
          annotations: cls.annotations,
          javadoc: decodeHtmlEntities(cls.javadoc),
          asilLevel: cls.asil_level,
          lineStart: cls.line_start,
        },
        file: { path: file?.path, lang: file?.lang, lineCount: file?.line_count },
        fields,
        imports: deps.filter(d => d.dep_type === 'import').map(d => d.to_qualified),
        methods: methodContexts,
        summary: {
          totalMethods: allMethods.length,
          totalBranches: allMethods.reduce((s, m) => s + (m.branch_count ?? 0), 0),
          totalMcdcConditions: methodContexts.reduce((s, m) => s + m.mcdc_conditions.length, 0),
          estimatedMinTestCases: methodContexts.reduce((s, m) => {
            const mcdcPairs = m.mcdc_conditions.reduce((sum, c) => sum + (c.mcdcPairs?.length ?? 0), 0);
            return s + Math.max(m.branch_count, mcdcPairs, 1);
          }, 0),
        },
        recommended_next_actions: recommendedNextActions('get_ut_context', {
          qualifiedName: cls.qualified_name,
        }),
      };
    }

    // ── Dependencies ───────────────────────────────────────────────────────

    case 'get_dependencies': {
      const file = db.db.prepare('SELECT * FROM files WHERE path = ?').get(args.filePath);
      if (!file) return { error: `File not found: ${args.filePath}` };
      return db.db.prepare(`
        SELECT d.*, f.path as to_path
        FROM dependencies d
        LEFT JOIN files f ON f.id = d.to_file_id
        WHERE d.from_file_id = ?
      `).all(file.id);
    }

    // ── Sync file ──────────────────────────────────────────────────────────

    case 'sync_file': {
      const absPath = existsSync(args.filePath)
        ? args.filePath
        : join(config.projectRoot, args.filePath);
      if (!existsSync(absPath)) return { error: `File not found: ${args.filePath}` };
      const builder = new GraphBuilder(db, config.projectRoot);
      return builder.syncFile(absPath);
    }

    // ── Method context ─────────────────────────────────────────────────────

    case 'get_method_context': {
      const methodId = args.method_id;

      const method = db.db.prepare(`
        SELECT m.*,
               c.name AS class_name,
               c.qualified_name AS class_qualified_name,
               f.path AS _file_path,
               f.lang AS _file_lang
        FROM methods m
        JOIN classes c ON c.id = m.class_id
        JOIN files f ON f.id = m.file_id
        WHERE m.id = ?
      `).get(methodId);

      if (!method) return { error: `Method not found: ${methodId}` };

      const annotations = JSON.parse(method.annotations ?? '[]');
      const parameters = JSON.parse(method.parameters ?? '[]');
      const throwsList = JSON.parse(method.throws_list ?? '[]');
      const booleanConditions = JSON.parse(method.boolean_conditions ?? '[]');

      const response = {
        status: 'ok',
        method: {
          id: method.id,
          class_id: method.class_id,
          class_name: method.class_name,
          class_qualified_name: method.class_qualified_name,
          name: method.name,
          signature: method.signature,
          return_type: method.return_type,
          visibility: method.visibility,
          is_static: !!method.is_static,
          is_abstract: !!method.is_abstract,
          is_override: !!method.is_override,
          annotations,
          parameters,
          throws_list: throwsList,
          javadoc: decodeHtmlEntities(method.javadoc),
          source_ref: {
            file: { path: method._file_path, language: method._file_lang },
            line_start: method.line_start,
            line_end: method.line_end,
          },
        },
        state: { fields_read: [], fields_written: [] },
        calls: [],
        decisions: [],
        parse_quality: buildParseQuality(method),
      };

      // 1. Include source code
      if (args.include_source !== false) {
        const sourceResult = readSourceRange(
          config.projectRoot,
          method._file_path,
          method.line_start,
          method.line_end,
          MAX_SOURCE_LINES_PER_METHOD
        );
        if (sourceResult.error) {
          response.source_error = sourceResult.error;
          if (sourceResult.pathTraversalRejected) {
            response.status = 'error';
            response.error = 'Path traversal detected: cannot read source file';
          }
        } else {
          response.method.source = sourceResult.content;
          response.method.source_ref.line_start = sourceResult.line_start;
          response.method.source_ref.line_end = sourceResult.line_end;
          response.method.source_truncated = sourceResult.truncated;
          if (sourceResult.truncated) {
            response.status = 'partial';
            response.truncated = true;
            response.truncation_reason = 'MAX_SOURCE_LINES_PER_METHOD_EXCEEDED';
          }
        }

        // Check token budget
        if (response.status === 'ok' || response.status === 'partial') {
          const tokens = estimateTokens(response);
          if (tokens > MAX_CONTEXT_TOKENS) {
            // Remove expensive fields to fit budget
            response.decisions = [];
            response.status = 'partial';
            response.truncated = true;
            response.truncation_reason = 'TOKEN_BUDGET_EXCEEDED';
          }
        }
      }

      // 2. Include fields
      if (args.include_fields !== false) {
        const classFields = db.db.prepare(
          'SELECT name, type, is_static, is_final FROM fields WHERE class_id = ? ORDER BY name'
        ).all(method.class_id);
        response.state.fields_read = classFields.map(f => ({
          name: f.name,
          type: f.type,
          is_static: !!f.is_static,
          is_final: !!f.is_final,
        }));
      }

      // 3. Include calls from this method
      if (args.include_calls !== false) {
        const callees = db.getCallees(methodId);
        response.calls = callees.map(c => ({
          callee_name: c.callee_name,
          callee_id: c.callee_id,
          signature: c.signature,
          line: c.line,
          resolved: !!c.callee_id,
        }));
      }

      // 4. Include decisions (from decisions/conditions tables)
      if (args.include_decisions !== false) {
        const decisions = db.getDecisionsForMethod(methodId);
        response.decisions = decisions.map(d => ({
          decision_uid: d.decision_uid,
          kind: d.kind,
          line_start: d.line_start,
          expression: decodeHtmlEntities(d.expression),
          normalized: decodeHtmlEntities(d.normalized),
          operator: d.operator,
          mcdc_required: !!d.mcdc_required,
          conditions: (d.conditions || []).map(c => ({
            condition_uid: c.condition_uid,
            text: decodeHtmlEntities(c.text),
            position: c.position,
            condition_type: c.condition_type,
          })),
        }));
      }

      // 5. Recommended next actions
      response.recommended_next_actions = recommendedNextActions('get_method_context', {
        methodId: method.id,
        qualifiedName: method.class_qualified_name,
      });

      return response;
    }

    // ── Import test results ───────────────────────────────────────────────

    case 'import_test_results': {
      const report = { testResults: 0, passed: 0, failed: 0, errors: 0, coverageRecords: 0 };
      if (args.junitPath) {
        const result = await importJunitResults(db, args.junitPath, config.projectRoot);
        report.testResults = result.total;
        report.passed = result.passed;
        report.failed = result.failed;
        report.errors = result.errors;
      }
      if (args.jacocoPath) {
        const count = await importJacocoCoverage(db, args.jacocoPath);
        report.coverageRecords = count;
      }
      return { status: 'ok', ...report };
    }

    // ── Get coverage summary ─────────────────────────────────────────────

    case 'get_coverage_summary': {
      if (args.methodId) {
        const coverage = db.getCoverageForMethod(args.methodId);
        return { status: 'ok', method_id: args.methodId, coverage };
      }
      if (args.qualifiedName) {
        const cls = db.getClassByQualifiedName(args.qualifiedName);
        if (!cls) return { error: `Class not found: ${args.qualifiedName}` };
        const coverage = db.getCoverageForClass(cls.id);
        return { status: 'ok', class: args.qualifiedName, coverage };
      }
      return { error: 'Provide either methodId or qualifiedName' };
    }

    // ── Export evidence plan ─────────────────────────────────────────────

    case 'export_evidence_plan': {
      const asilStr = (args.asilLevel || 'D').toUpperCase();
      const asil = asilStr.startsWith('ASIL-') ? asilStr : `ASIL-${asilStr}`;
      const cls = db.getClassByQualifiedName(args.qualifiedName);
      if (!cls) return { error: `Class not found: ${args.qualifiedName}` };
      const outputDir = args.outputDir || join(process.cwd(), 'evidence', cls.name);
      const { files, summary } = await generateEvidencePackage(db, args.qualifiedName, asil, outputDir);
      return {
        status: 'ok',
        class: args.qualifiedName,
        asil_level: asil,
        output_directory: outputDir,
        files,
        summary,
        recommended_next_actions: [],
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('[codeparse-mcp] Server started. Listening on stdio.\n');

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
