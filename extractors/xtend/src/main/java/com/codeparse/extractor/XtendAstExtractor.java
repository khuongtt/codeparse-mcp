package com.codeparse.extractor;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.stmt.BlockStmt;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.*;

/**
 * Xtend AST extractor using XtendPreprocessor + JavaParser + CfgBuilder.
 *
 * Structural scanning (line-based) for class/method boundaries + brace matching.
 * Body analysis via preprocessor -> JavaParser parseBlock -> CfgBuilder.
 * This replaces the old line-by-line XtendBodyAnalyzer with proper AST analysis.
 *
 * Method patterns handled:
 *   def foo()                          — Xtend standard
 *   private def void foo()             — modifier + def
 *   override def foo()                 — override + def
 *   override foo()                     — Xtend shorthand (no def)
 *   new(Params)                        — constructor
 *   dispatch foo()                     — dispatch
 *   private override void foo(Stage)   — Java-style with modifiers
 *   @Annotation def foo()              — annotation on same line
 */
public class XtendAstExtractor {

    private static final Set<String> MODIFIERS = new HashSet<>(Arrays.asList(
        "public", "protected", "private", "abstract", "final", "static", "override", "dispatch"));

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Usage: xtend-ast-extractor <file.xtend>");
            System.exit(1);
        }
        Path path = Path.of(args[0]);
        if (!Files.exists(path)) {
            System.err.println("File not found: " + args[0]);
            System.exit(1);
        }

        XtendAstExtractor ext = new XtendAstExtractor();
        IrClasses.IrFile ir = ext.extract(path);

        Gson gson = new GsonBuilder().setPrettyPrinting().serializeNulls().create();
        System.out.println(gson.toJson(ir));
    }

    final XtendPreprocessor preprocessor = new XtendPreprocessor();

    IrClasses.IrFile extract(Path path) throws IOException {
        String source = Files.readString(path);
        String filePath = path.toString();
        String[] lines = source.split("\n", -1);

        IrClasses.IrFile ir = new IrClasses.IrFile();
        ir.sourceLanguage = "xtend";
        ir.filePath = filePath;

        // Collect template markers across the file
        List<XtendTemplateMarker> allTemplateMarkers = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            Matcher tmplIf = Pattern.compile("^«IF\\s+(.+?)»").matcher(line);
            if (tmplIf.find()) { allTemplateMarkers.add(new XtendTemplateMarker(i, "template_if", tmplIf.group(1))); }
            Matcher tmplElseIf = Pattern.compile("^«ELSEIF\\s+(.+?)»").matcher(line);
            if (tmplElseIf.find()) { allTemplateMarkers.add(new XtendTemplateMarker(i, "template_elseif", tmplElseIf.group(1))); }
            if (line.startsWith("«ELSE»")) allTemplateMarkers.add(new XtendTemplateMarker(i, "template_else", null));
            if (line.startsWith("«ENDIF»")) allTemplateMarkers.add(new XtendTemplateMarker(i, "template_endif", null));
        }

        // Phase 1: structural scan — find classes + methods + body ranges
        ClassParseState currentClass = null;
        String pkg = null;

        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("//")) continue;
            if (line.startsWith("/*") || line.startsWith("/**") || line.startsWith("*")) continue;
            if (line.contains("«") && !line.contains("IF") && !line.contains("ELSEIF") && !line.contains("ELSE") && !line.contains("ENDIF")) continue;

            // ── Top-level (before any class) ──
            if (currentClass == null) {
                // Package
                Matcher pkgMatch = Pattern.compile("^package\\s+([\\w.]+)").matcher(line);
                if (pkgMatch.find() && !line.contains(";")) {
                    pkg = pkgMatch.group(1);
                    ir.packageName = pkg;
                    continue;
                }
                if (line.startsWith("import ")) continue;
                if (line.startsWith("@")) continue;

                // Class declaration
                Matcher clsMatch = Pattern.compile(
                    "^((?:public|protected|private|abstract|final|static)\\s+)*(@\\w+\\s+)?(class|interface|enum)\\s+(\\w+)"
                ).matcher(line);
                if (clsMatch.find()) {
                    currentClass = new ClassParseState();
                    currentClass.name = clsMatch.group(4);
                    currentClass.qualifiedName = (pkg != null ? pkg + "." : "") + currentClass.name;
                    currentClass.kind = "xtend_class";
                    currentClass.lineStart = i + 1;
                    Matcher extMatch = Pattern.compile("extends\\s+(\\w+)").matcher(line);
                    if (extMatch.find()) currentClass.superclass = extMatch.group(1);
                    currentClass.braceDepth = 0;
                    currentClass.classStartLine = i;
                    currentClass.sourceLines = lines;
                    currentClass.templateMarkers = allTemplateMarkers;
                }
                continue;
            }

            // ── Inside class body ──
            int depthBeforeLine = currentClass.braceDepth;
            for (char c : line.toCharArray()) {
                if (c == '{') currentClass.braceDepth++;
                if (c == '}') currentClass.braceDepth--;
            }

            // End of class
            if (depthBeforeLine == 0
                && currentClass.braceDepth == -1
                && currentClass.currentMethod == null
                && line.trim().startsWith("}")) {
                currentClass.lineEnd = i + 1;
                analyzeMethods(currentClass);
                ir.classes.add(currentClass.toIrClass());
                currentClass = null;
                continue;
            }

            // Annotation-only line — skip unless followed by method
            if (line.startsWith("@")) {
                String stripped = line.replaceFirst("^@\\w+\\s+", "");
                if (!isMethodDeclaration(stripped)) continue;
            }

            // ── Method / constructor detection ──
            if (currentClass.currentMethod == null
                || currentClass.braceDepth < currentClass.currentMethod.braceDepthOnEntry) {
                String checkLine = line.replaceFirst("^@\\w+\\s+", "");
                if (isMethodDeclaration(checkLine)) {
                    if (currentClass.currentMethod != null) {
                        currentClass.endMethod(i - 1);
                    }
                    currentClass.startMethod(i, pkg, depthBeforeLine);
                    continue;
                }
            }

            // ── Method body tracking ──
            if (currentClass.currentMethod != null) {
                if (currentClass.braceDepth == currentClass.currentMethod.braceDepthOnEntry
                    && line.trim().startsWith("}")) {
                    currentClass.endMethod(i);
                    continue;
                }
                if (currentClass.currentMethod.bodyEndLine < i) {
                    currentClass.currentMethod.bodyEndLine = i;
                }
            }
        }

        // Finalize last class
        if (currentClass != null) {
            if (currentClass.currentMethod != null) currentClass.endMethod(lines.length - 1);
            analyzeMethods(currentClass);
            ir.classes.add(currentClass.toIrClass());
        }

        return ir;
    }

    /**
     * Heuristic: check if a trimmed source line looks like a method/constructor declaration.
     */
    private static boolean isMethodDeclaration(String raw) {
        if (Pattern.compile("^(?:public|protected|private)?\\s*new\\s*\\(").matcher(raw).find()) return true;
        if (Pattern.compile("\\bdef\\s+").matcher(raw).find()) return true;
        if (Pattern.compile("\\b(?:override|dispatch)\\b").matcher(raw).find()) {
            if (raw.contains("(") && raw.contains(")")) return true;
        }
        if (Pattern.compile("^(?:public|protected|private|static|final|abstract|synchronized|native)\\s+").matcher(raw).find()) {
            return raw.contains("(") && raw.contains(")");
        }
        return false;
    }

    /**
     * Analyze each method's body: preprocess -> JavaParser -> CfgBuilder.
     * Then attach template markers for post-processing.
     */
    void analyzeMethods(ClassParseState cls) {
        for (MethodParseState mp : cls.methods) {
            int lineStartOneBased = mp.declaredOnLine + 1;
            int lineEndOneBased = mp.bodyEndLine + 1;

            // Attach template markers (by original line range)
            for (XtendTemplateMarker tm : cls.templateMarkers) {
                int tmLine = tm.line + 1;
                if (tmLine >= lineStartOneBased && tmLine <= lineEndOneBased) {
                    if ("template_if".equals(tm.kind) || "template_elseif".equals(tm.kind)) {
                        if (mp.templateDecisions == null) mp.templateDecisions = new ArrayList<>();
                        mp.templateDecisions.add(tm);
                    }
                }
            }

            // Extract body lines
            List<String> bodyLines = new ArrayList<>();
            if (mp.hasBody && mp.bodyStartLine <= mp.bodyEndLine && mp.bodyStartLine < cls.sourceLines.length) {
                for (int bi = mp.bodyStartLine; bi <= mp.bodyEndLine && bi < cls.sourceLines.length; bi++) {
                    bodyLines.add(cls.sourceLines[bi]);
                }
            }

            if (bodyLines.isEmpty()) {
                mp.analyzerDecisions = new ArrayList<>();
                mp.analyzerCalls = new ArrayList<>();
                mp.analyzerBranchCount = 0;
                mp.analyzerConditionCount = 0;
                mp.analyzerCyclomaticComplexity = 1;
                mp.analyzerCfgNodes = new ArrayList<>();
                mp.analyzerCfgEdges = new ArrayList<>();
                continue;
            }

            // Preprocess and parse
            try {
                // Run preprocessor (include closing } for implicit return detection)
                String bodyText = preprocessor.processMethodBody(bodyLines);

                // Strip any trailing } from preprocessed body — our wrapper adds one
                bodyText = bodyText.replaceFirst("\\s*}\\s*$", "");

                // Parse with JavaParser
                String blockSource = "{\n" + bodyText + "\n}";
                BlockStmt block = StaticJavaParser.parseBlock(blockSource);

                // Run CfgBuilder
                CfgBuilder cfgBuilder = new CfgBuilder();
                cfgBuilder.visit(block);

                // Post-process: if template markers present, match them to decisions by ORDER.
                // Template markers are collected in file order; CfgBuilder decisions are in
                // body order. The first "if" decision matches first template_if marker, etc.
                if (mp.templateDecisions != null && !mp.templateDecisions.isEmpty()) {
                    int markerIdx = 0;
                    for (int di = 0; di < cfgBuilder.decisions.size() && markerIdx < mp.templateDecisions.size(); di++) {
                        IrClasses.IrDecision d = cfgBuilder.decisions.get(di);
                        XtendTemplateMarker tm = mp.templateDecisions.get(markerIdx);
                        if (d.kind.equals("if") && tm.kind.equals("template_if")) {
                            d.kind = "template_if";
                            markerIdx++;
                        } else if (d.kind.equals("else_if") && tm.kind.equals("template_elseif")) {
                            d.kind = "template_elseif";
                            markerIdx++;
                        }
                    }
                }

                // Store results
                mp.analyzerDecisions = cfgBuilder.decisions;
                mp.analyzerCalls = cfgBuilder.calls;
                mp.analyzerBranchCount = cfgBuilder.branchCount;
                mp.analyzerConditionCount = cfgBuilder.conditionCount;
                mp.analyzerCyclomaticComplexity = cfgBuilder.cyclomaticComplexity;
                IrClasses.IrCfg cfg = cfgBuilder.buildCfg();
                mp.analyzerCfgNodes = cfg.nodes;
                mp.analyzerCfgEdges = cfg.edges;

            } catch (Exception e) {
                // Fallback to empty data on parse failure
                System.err.println("[xtend-extractor] parse error in method " + mp.name + ": " + e.getMessage());
                mp.analyzerDecisions = new ArrayList<>();
                mp.analyzerCalls = new ArrayList<>();
                mp.analyzerBranchCount = 0;
                mp.analyzerConditionCount = 0;
                mp.analyzerCyclomaticComplexity = 1;
                mp.analyzerCfgNodes = new ArrayList<>();
                mp.analyzerCfgEdges = new ArrayList<>();

                // Still add template decisions even on parse failure
                if (mp.templateDecisions != null) {
                    for (XtendTemplateMarker tm : mp.templateDecisions) {
                        CfgBuilder cb = new CfgBuilder();
                        IrClasses.IrDecision dec = cb.createDecision(tm.kind, tm.expression, tm.line + 1);
                        if (dec != null) {
                            mp.analyzerDecisions.add(dec);
                            mp.analyzerCyclomaticComplexity++;
                            mp.analyzerBranchCount += 2;
                            if (dec.conditions != null) mp.analyzerConditionCount += dec.conditions.size();
                        }
                    }
                }
            }
        }
    }

    // ── Internal state classes ──

    static class XtendTemplateMarker {
        int line;
        String kind;
        String expression;
        XtendTemplateMarker(int line, String kind, String expression) {
            this.line = line;
            this.kind = kind;
            this.expression = expression;
        }
    }

    static class ClassParseState {
        String name, qualifiedName, kind, superclass;
        int lineStart, lineEnd;
        int braceDepth = 0;
        int classStartLine;
        String[] sourceLines;
        MethodParseState currentMethod;
        List<MethodParseState> methods = new ArrayList<>();
        List<XtendTemplateMarker> templateMarkers = new ArrayList<>();

        void startMethod(int lineIdx, String pkg, int depthBeforeLine) {
            if (currentMethod != null) endMethod(lineIdx - 1);
            MethodParseState mp = new MethodParseState();
            mp.declaredOnLine = lineIdx;
            mp.bodyStartLine = lineIdx + 1;
            mp.bodyEndLine = lineIdx;
            mp.braceDepthOnEntry = depthBeforeLine;

            String raw = sourceLines[lineIdx].trim()
                .replaceFirst("^@\\w+\\s+", "");

            // Constructor: new(Params)
            Matcher ctorMatch = Pattern.compile("^(?:public|protected|private)?\\s*new\\s*\\(([^)]*)\\)").matcher(raw);
            if (ctorMatch.find()) {
                String className = qualifiedName != null
                    ? qualifiedName.substring(qualifiedName.lastIndexOf('.') + 1)
                    : "Constructor";
                mp.name = className;
                mp.returnType = className;
                mp.signature = className + "(" + parseParamTypes(ctorMatch.group(1)) + "):" + className;
                currentMethod = mp;
                methods.add(mp);
                return;
            }

            // def pattern
            Matcher defMatch = Pattern.compile(
                "^((?:" +
                "public|protected|private|abstract|final|static|override|dispatch" +
                ")\\s+)*" +
                "def\\s+" +
                "((?:" +
                "public|protected|private|abstract|final|static|override|dispatch" +
                ")\\s+)*" +
                "(?:(\\w+(?:<[^>]*>)?(?:\\[\\])?)\\s+)?" +
                "(\\w+)\\s*\\(([^)]*)\\)"
            ).matcher(raw);
            if (defMatch.find()) {
                String modStr = defMatch.group(1) != null ? defMatch.group(1) : "";
                modStr += defMatch.group(2) != null ? defMatch.group(2) : "";
                mp.name = defMatch.group(4);
                String rawParams = defMatch.group(5);
                String retType = defMatch.group(3) != null ? defMatch.group(3) : "void";

                Matcher afterRet = Pattern.compile(":\\s*(\\w+(?:\\.\\w+)*(?:<[^>]*>)?)\\s*$").matcher(raw);
                if (afterRet.find()) retType = afterRet.group(1);

                mp.returnType = retType;
                mp.signature = mp.name + "(" + parseParamTypes(rawParams) + "):" + mp.returnType;
                mp.isOverride = modStr != null && modStr.contains("override");
                currentMethod = mp;
                methods.add(mp);
                return;
            }

            // Override/dispatch shorthand (no def)
            Matcher ovrMatch = Pattern.compile(
                "^((?:(?:override|dispatch)\\s+)+)((?:\\w+(?:<[^>]*>)?(?:\\[\\])?)\\s+)?(\\w+)\\s*\\(([^)]*)\\)"
            ).matcher(raw);
            if (ovrMatch.find()) {
                String modStr = ovrMatch.group(1);
                mp.name = ovrMatch.group(3);
                String rawParams = ovrMatch.group(4);
                String retType = ovrMatch.group(2) != null ? ovrMatch.group(2).trim() : "void";

                Matcher afterRet = Pattern.compile(":\\s*(\\w+(?:\\.\\w+)*(?:<[^>]*>)?)\\s*$").matcher(raw);
                if (afterRet.find()) retType = afterRet.group(1);

                mp.returnType = retType;
                mp.signature = mp.name + "(" + parseParamTypes(rawParams) + "):" + mp.returnType;
                mp.isOverride = modStr != null && modStr.contains("override");
                currentMethod = mp;
                methods.add(mp);
                return;
            }

            // Java-style constructor: ClassName(Params)
            Matcher javaCtor = Pattern.compile("^(?:public|protected|private)?\\s*(\\w+)\\s*\\(([^)]*)\\)").matcher(raw);
            if (javaCtor.find()) {
                String ctorName = javaCtor.group(1);
                if (ctorName.equals(name) || ctorName.equals("new")) {
                    mp.name = name;
                    mp.returnType = name;
                    mp.signature = name + "(" + parseParamTypes(javaCtor.group(2)) + "):" + name;
                    currentMethod = mp;
                    methods.add(mp);
                    return;
                }
            }

            // Fallback
            mp.name = "unknown";
            mp.returnType = "void";
            mp.signature = "unknown():void";
            currentMethod = mp;
            methods.add(mp);
        }

        void endMethod(int bodyEndIdx) {
            if (currentMethod != null) {
                currentMethod.bodyEndLine = Math.max(currentMethod.bodyStartLine, bodyEndIdx);
                currentMethod.hasBody = currentMethod.bodyEndLine > currentMethod.declaredOnLine;
            }
            currentMethod = null;
        }

        private String parseParamTypes(String rawParams) {
            if (rawParams == null || rawParams.trim().isEmpty()) return "";
            StringBuilder types = new StringBuilder();
            String[] params = rawParams.split(",");
            for (int pi = 0; pi < params.length; pi++) {
                String p = params[pi].trim();
                String[] parts = p.split("\\s+");
                if (parts.length > 1) p = parts[0];
                if (pi > 0) types.append(",");
                types.append(p);
            }
            return types.toString();
        }

        IrClasses.IrClass toIrClass() {
            IrClasses.IrClass cls = new IrClasses.IrClass();
            cls.name = name;
            cls.qualifiedName = qualifiedName;
            cls.kind = kind;
            cls.lineStart = lineStart;
            cls.lineEnd = lineEnd;
            cls.superclass = superclass;
            cls.annotations = new ArrayList<>();

            for (MethodParseState mp : methods) {
                IrClasses.IrMethod m = new IrClasses.IrMethod();
                m.name = mp.name != null ? mp.name : "unknown";
                m.signature = mp.signature != null ? mp.signature : m.name + "():void";
                m.returnType = mp.returnType != null ? mp.returnType : "void";
                m.visibility = "public";
                m.lineStart = mp.declaredOnLine + 1;
                m.lineEnd = mp.bodyEndLine + 1;
                m.isOverride = mp.isOverride;

                // Use CfgBuilder results
                m.decisions = mp.analyzerDecisions != null ? mp.analyzerDecisions : new ArrayList<>();
                m.branchCount = mp.analyzerBranchCount;
                m.conditionCount = mp.analyzerConditionCount;
                m.cyclomaticComplexity = mp.analyzerCyclomaticComplexity;
                m.calls = mp.analyzerCalls != null ? mp.analyzerCalls : new ArrayList<>();

                // Build CFG from stored nodes/edges
                IrClasses.IrCfg cfg = new IrClasses.IrCfg();
                cfg.nodes = mp.analyzerCfgNodes != null ? mp.analyzerCfgNodes : new ArrayList<>();
                cfg.edges = mp.analyzerCfgEdges != null ? mp.analyzerCfgEdges : new ArrayList<>();
                m.cfg = cfg;

                cls.methods.add(m);
            }
            return cls;
        }
    }

    static class MethodParseState {
        String name, signature, returnType;
        int declaredOnLine;
        int bodyStartLine;
        int bodyEndLine;
        int braceDepthOnEntry;
        boolean hasBody;
        boolean isOverride;
        List<XtendTemplateMarker> templateDecisions;

        // CfgBuilder results
        List<IrClasses.IrDecision> analyzerDecisions;
        List<Map<String, Object>> analyzerCalls;
        int analyzerBranchCount;
        int analyzerConditionCount;
        int analyzerCyclomaticComplexity;
        List<Map<String, Object>> analyzerCfgNodes;
        List<Map<String, Object>> analyzerCfgEdges;
    }
}
