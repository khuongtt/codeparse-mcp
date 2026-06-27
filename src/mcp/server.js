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
  { name: 'codeparse-mcp', version: '1.0.0' },
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

  // ── MC/DC queries ────────────────────────────────────────────────────────

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
          DROP TABLE IF EXISTS mcdc_conditions;
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
      return {
        ...cls,
        interfaces: JSON.parse(cls.interfaces ?? '[]'),
        annotations: JSON.parse(cls.annotations ?? '[]'),
      };
    }

    case 'search_classes': {
      const classes = db.searchClasses(args.pattern);
      return classes.map(c => ({
        id: c.id,
        qualifiedName: c.qualified_name,
        name: c.name,
        kind: c.kind,
        isAbstract: !!c.is_abstract,
        asilLevel: c.asil_level,
        lineStart: c.line_start,
      }));
    }

    // ── Methods ────────────────────────────────────────────────────────────

    case 'get_methods': {
      const cls = db.getClassByQualifiedName(args.qualifiedName);
      if (!cls) return { error: `Class not found: ${args.qualifiedName}` };
      return db.getMethodsForClass(cls.id);
    }

    case 'search_methods': {
      return db.searchMethods(args.pattern);
    }

    // ── CFG ────────────────────────────────────────────────────────────────

    case 'get_cfg': {
      return db.getCfgForMethod(args.methodId);
    }

    // ── MC/DC ──────────────────────────────────────────────────────────────

    case 'get_mcdc': {
      const conditions = db.getMcdcForMethod(args.methodId);
      const method = db.db.prepare('SELECT * FROM methods WHERE id = ?').get(args.methodId);
      return {
        methodId: args.methodId,
        methodName: method?.name,
        signature: method?.signature,
        branchCount: method?.branch_count,
        conditionCount: method?.condition_count,
        cyclomaticComplexity: method?.cyclomatic_complexity,
        booleanConditions: method ? JSON.parse(method.boolean_conditions ?? '[]') : [],
        mcdcConditions: conditions,
        coverage_requirements: {
          C0_statement: 'Every statement must be executed',
          C1_branch: `All ${method?.branch_count ?? 0} branches (true/false) must be covered`,
          MCDC: `Each of ${conditions.length} boolean decisions must independently affect outcome`,
          ASIL_D_target: '100% MC/DC required',
        },
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
            methodId: m.id,
            methodName: m.name,
            signature: m.signature,
            branchCount: m.branch_count,
            conditionCount: m.condition_count,
            cyclomaticComplexity: m.cyclomatic_complexity,
            mcdcConditions: conditions,
          });
        }
      }
      return { className: args.qualifiedName, methods: result };
    }

    // ── Call graph ─────────────────────────────────────────────────────────

    case 'get_callees': {
      return db.getCallees(args.methodId);
    }

    case 'get_callers': {
      return db.db.prepare(`
        SELECT ce.*, m.signature, m.name as method_name, c.qualified_name as class_name
        FROM call_edges ce
        JOIN methods m ON m.id = ce.caller_id
        JOIN classes c ON c.id = m.class_id
        WHERE ce.callee_id = ?
      `).all(args.methodId);
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
        const callees = db.getCallees(m.id);

        methodContexts.push({
          id: m.id,
          name: m.name,
          signature: m.signature,
          returnType: m.return_type,
          visibility: m.visibility,
          isStatic: !!m.is_static,
          isAbstract: !!m.is_abstract,
          annotations: m.annotations,
          parameters: m.parameters,
          throwsList: m.throwsList,
          javadoc: m.javadoc,
          lineStart: m.line_start,
          lineEnd: m.line_end,
          asilLevel: m.asil_level,
          cyclomaticComplexity: m.cyclomatic_complexity,
          branchCount: m.branch_count,
          conditionCount: m.condition_count,
          booleanConditions: m.booleanConditions,
          cfg: { nodeCount: cfg.nodes.length, edgeCount: cfg.edges.length, nodes: cfg.nodes, edges: cfg.edges },
          mcdcConditions: mcdc,
          mockTargets: callees.map(c => ({ calleeName: c.callee_name, line: c.line, resolved: !!c.callee_id })),
          coverage_requirements: {
            C0_statement: 'All statements executed',
            C1_branch: `${m.branch_count} branches — true+false for each`,
            MCDC: mcdc.length > 0
              ? `${mcdc.length} decisions, each with independence pairs`
              : 'No complex boolean decisions',
            ASIL_D: 'ISO 26262 ASIL-D: 100% MC/DC mandatory',
          },
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
          interfaces: JSON.parse(cls.interfaces ?? '[]'),
          annotations: JSON.parse(cls.annotations ?? '[]'),
          javadoc: cls.javadoc,
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
          totalMcdcConditions: methodContexts.reduce((s, m) => s + m.mcdcConditions.length, 0),
          estimatedMinTestCases: methodContexts.reduce((s, m) => {
            // Minimum: max(branches, mcdc_pairs) per method
            const mcdcPairs = m.mcdcConditions.reduce((sum, c) => sum + (c.mcdcPairs?.length ?? 0), 0);
            return s + Math.max(m.branchCount, mcdcPairs, 1);
          }, 0),
        },
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
