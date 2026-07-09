package com.codeparse.extractor;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Xtend extractor using line-by-line structural parsing.
 * Collects method body ranges then runs XtendBodyAnalyzer for CFG/decision extraction.
 */
public class XtendAstExtractor {

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

    IrClasses.IrFile extract(Path path) throws IOException {
        String source = Files.readString(path);
        String filePath = path.toString();
        String[] lines = source.split("\n", -1);

        IrClasses.IrFile ir = new IrClasses.IrFile();
        ir.sourceLanguage = "xtend";
        ir.filePath = filePath;

        // Collect template markers across the file
        List<XtendTemplateMarker> templateMarkers = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            Matcher tmplIf = Pattern.compile("^«IF\\s+(.+?)»").matcher(line);
            if (tmplIf.find()) { templateMarkers.add(new XtendTemplateMarker(i, "template_if", tmplIf.group(1))); }
            Matcher tmplElseIf = Pattern.compile("^«ELSEIF\\s+(.+?)»").matcher(line);
            if (tmplElseIf.find()) { templateMarkers.add(new XtendTemplateMarker(i, "template_elseif", tmplElseIf.group(1))); }
            if (line.startsWith("«ELSE»")) templateMarkers.add(new XtendTemplateMarker(i, "template_else", null));
            if (line.startsWith("«ENDIF»")) templateMarkers.add(new XtendTemplateMarker(i, "template_endif", null));
        }

        // Phase 1: structural scan — find classes + methods + body ranges
        List<ClassParseState> classes = new ArrayList<>();
        ClassParseState currentClass = null;
        String pkg = null;

        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty() || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*") || line.startsWith("/**")) continue;

            // Package
            Matcher pkgMatch = Pattern.compile("^package\\s+([\\w.]+)").matcher(line);
            if (pkgMatch.find() && !line.contains(";")) { pkg = pkgMatch.group(1); ir.packageName = pkg; continue; }

            // Import — skip
            if (line.startsWith("import ") && !line.contains(";")) continue;
            if (line.startsWith("@")) continue;
            // Template markers — skip (already collected)
            if (line.contains("«")) continue;

            // Class declaration
            Matcher clsMatch = Pattern.compile(
                    "^((?:public|protected|private|abstract|final|static)\\s+)*(@\\w+\\s+)?(class|interface|enum)\\s+(\\w+)"
            ).matcher(line);
            if (clsMatch.find()) {
                // Finalize previous class body analysis
                if (currentClass != null) analyzeMethods(currentClass);
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
                continue;
            }

            if (currentClass == null) continue;

            // Track brace depth
            for (char c : line.toCharArray()) { if (c == '{') currentClass.braceDepth++; if (c == '}') currentClass.braceDepth--; }

            // End of class
            if (line.equals("}") && currentClass.braceDepth == 0) {
                currentClass.lineEnd = i + 1;
                continue;
            }

            // Inside class, not in method — check for method declaration
            if (currentClass.currentMethod == null && (line.startsWith("def ") || line.startsWith("override ") || line.startsWith("dispatch "))) {
                currentClass.startMethod(i, pkg);
                continue;
            }

            // In method — collect body or end it
            if (currentClass.currentMethod != null) {
                // If brace depth returned to entry level, method body ended
                if (line.startsWith("}") && currentClass.braceDepth <= currentClass.currentMethod.braceDepthOnEntry) {
                    currentClass.endMethod(i);
                    continue;
                }
                // If another method declaration found, previous method ended
                if ((line.startsWith("def ") || line.startsWith("override ") || line.startsWith("dispatch "))
                        && currentClass.braceDepth <= currentClass.currentMethod.braceDepthOnEntry) {
                    currentClass.endMethod(i - 1);
                    currentClass.startMethod(i, pkg);
                    continue;
                }
                // Still in method body
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
     * After structural scan, run body analysis + attach template markers.
     */
    void analyzeMethods(ClassParseState cls) {
        // Attach template markers to methods
        for (MethodParseState mp : cls.methods) {
            int lineStartOneBased = mp.declaredOnLine + 1;
            int lineEndOneBased = mp.bodyEndLine + 1;

            // Attach template markers
            for (XtendTemplateMarker tm : cls.templateMarkers) {
                int tmLine = tm.line + 1;
                if (tmLine >= lineStartOneBased && tmLine <= lineEndOneBased) {
                    if ("template_if".equals(tm.kind) || "template_elseif".equals(tm.kind)) {
                        // Store for adding during body analysis
                        if (mp.templateDecisions == null) mp.templateDecisions = new ArrayList<>();
                        mp.templateDecisions.add(tm);
                    }
                }
            }

            // Extract body lines and run analyzer
            List<String> bodyLines = new ArrayList<>();
            if (mp.hasBody && mp.bodyStartLine <= mp.bodyEndLine && mp.bodyStartLine < cls.sourceLines.length) {
                for (int bi = mp.bodyStartLine; bi <= mp.bodyEndLine && bi < cls.sourceLines.length; bi++) {
                    bodyLines.add(cls.sourceLines[bi]);
                }
            }

            XtendBodyAnalyzer analyzer = new XtendBodyAnalyzer();
            if (!bodyLines.isEmpty()) {
                analyzer.analyze(bodyLines);
            }

            mp.analyzerResult = analyzer;
        }

        // Collect template markers not attached to any method (orphans)
        for (XtendTemplateMarker tm : cls.templateMarkers) {
            boolean attached = false;
            for (MethodParseState mp : cls.methods) {
                int l1 = mp.declaredOnLine + 1;
                int l2 = mp.bodyEndLine + 1;
                int tml = tm.line + 1;
                if (tml >= l1 && tml <= l2) { attached = true; break; }
            }
            if (!attached) {
                // Orphan markers — add to last method or leave
            }
        }
    }

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

    /**
     * Holds per-class parse state during structural scan.
     */
    static class ClassParseState {
        String name, qualifiedName, kind, superclass;
        int lineStart, lineEnd;
        int braceDepth = 0;
        int classStartLine;
        String[] sourceLines;
        MethodParseState currentMethod;
        List<MethodParseState> methods = new ArrayList<>();
        List<XtendTemplateMarker> templateMarkers = new ArrayList<>();

        void setTemplateMarkers(List<XtendTemplateMarker> all) {
            this.templateMarkers = all;
        }

        void startMethod(int lineIdx, String pkg) {
            if (currentMethod != null) endMethod(lineIdx - 1);
            MethodParseState mp = new MethodParseState();
            mp.declaredOnLine = lineIdx;
            mp.bodyStartLine = lineIdx + 1; // skip declaration line
            mp.bodyEndLine = lineIdx;
            mp.braceDepthOnEntry = braceDepth;

            String raw = sourceLines[lineIdx].trim()
                    .replaceAll("^def\\s+", "")
                    .replaceAll("^override\\s+", "")
                    .replaceAll("^dispatch\\s+", "");

            Matcher mm = Pattern.compile(
                    "(?:(\\w+(?:\\.\\w+)*(?:<[^>]*>)?)\\s+)?(\\w++)\\s*\\(([^)]*)\\)\\s*(?::\\s*(\\w+(?:\\.\\w+)*(?:<[^>]*>)?))?"
            ).matcher(raw);
            if (mm.find()) {
                String retBefore = mm.group(1);
                mp.name = mm.group(2);
                String rawParams = mm.group(3);
                String retAfter = mm.group(4);

                StringBuilder paramTypes = new StringBuilder();
                if (rawParams != null && !rawParams.trim().isEmpty()) {
                    String[] params = rawParams.split(",");
                    for (int pi = 0; pi < params.length; pi++) {
                        String p = params[pi].trim();
                        String[] parts = p.split("\\s+");
                        if (parts.length > 1) p = parts[0];
                        if (pi > 0) paramTypes.append(",");
                        paramTypes.append(p);
                    }
                }
                mp.returnType = retAfter != null ? retAfter : (retBefore != null ? retBefore : "void");
                mp.signature = mp.name + "(" + paramTypes + "):" + mp.returnType;
            }
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

        IrClasses.IrClass toIrClass() {
            IrClasses.IrClass cls = new IrClasses.IrClass();
            cls.name = name;
            cls.qualifiedName = qualifiedName;
            cls.kind = kind;
            cls.lineStart = lineStart;
            cls.lineEnd = lineEnd;
            cls.superclass = superclass;

            for (MethodParseState mp : methods) {
                IrClasses.IrMethod m = new IrClasses.IrMethod();
                m.name = mp.name != null ? mp.name : "unknown";
                m.signature = mp.signature != null ? mp.signature : m.name + "():void";
                m.returnType = mp.returnType != null ? mp.returnType : "void";
                m.visibility = "public";
                m.lineStart = mp.declaredOnLine + 1;
                m.lineEnd = mp.bodyEndLine + 1;

                XtendBodyAnalyzer r = mp.analyzerResult;
                if (r != null) {
                    m.decisions = r.decisions;
                    m.calls = r.calls;
                    m.branchCount = r.branchCount;
                    m.conditionCount = r.conditionCount;
                    m.cyclomaticComplexity = r.cyclomaticComplexity;
                    m.cfg = r.getCfg();
                }

                // Add template decisions on top of body-analyzed decisions
                if (mp.templateDecisions != null) {
                    for (XtendTemplateMarker tm : mp.templateDecisions) {
                        CfgBuilder builder = new CfgBuilder();
                        IrClasses.IrDecision dec = builder.createDecision(tm.kind, tm.expression, tm.line + 1);
                        if (dec != null) {
                            m.decisions.add(dec);
                            m.cyclomaticComplexity++;
                            m.branchCount += 2;
                            if (dec.conditions != null) m.conditionCount += dec.conditions.size();
                        }
                    }
                }

                cls.methods.add(m);
            }
            return cls;
        }
    }

    /**
     * Per-method parse state.
     */
    static class MethodParseState {
        String name, signature, returnType;
        int declaredOnLine;
        int bodyStartLine;
        int bodyEndLine;
        int braceDepthOnEntry;
        boolean hasBody;
        XtendBodyAnalyzer analyzerResult;
        List<XtendTemplateMarker> templateDecisions;
    }
}
