package com.codeparse.extractor;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.inject.Injector;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.stmt.BlockStmt;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;

import org.eclipse.emf.common.util.EList;
import org.eclipse.xtext.common.types.JvmTypeReference;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;
import org.eclipse.xtext.nodemodel.INode;
import org.eclipse.emf.ecore.resource.Resource;
import org.eclipse.xtext.resource.XtextResourceSet;
import org.eclipse.xtext.xbase.XBlockExpression;
import org.eclipse.xtext.xbase.XExpression;
import org.eclipse.xtend.core.XtendStandaloneSetup;
import org.eclipse.xtend.core.xtend.*;
import org.eclipse.xtend.core.xtend.RichString;

/**
 * Xtend AST extractor — Xtext for structural + template parsing,
 * Preprocessor + CfgBuilder for method body CFG/decision analysis.
 */
public class XtendAstExtractor {

    private static final XtendPreprocessor preprocessor = new XtendPreprocessor();

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

    // ── Entry point ──

    IrClasses.IrFile extract(Path path) throws Exception {
        String source = Files.readString(path);
        String[] lines = source.split("\n", -1);

        try {
            return extractWithXtext(path, source, lines);
        } catch (Exception e) {
            System.err.println("[xtend-extractor] Xtext parse failed, falling back to regex: " + e.getMessage());
            e.printStackTrace(System.err);
            return extractWithRegex(path, source, lines);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Xtext-based extraction
    // ═══════════════════════════════════════════════════════════════════

    private IrClasses.IrFile extractWithXtext(Path path, String source, String[] lines) throws Exception {
        XtendStandaloneSetup setup = new XtendStandaloneSetup();
        Injector injector = setup.createInjectorAndDoEMFRegistration();
        XtextResourceSet rs = injector.getInstance(XtextResourceSet.class);
        rs.setClasspathURIContext(path.toFile().getParentFile());

        org.eclipse.emf.common.util.URI uri =
            org.eclipse.emf.common.util.URI.createFileURI(path.toString());
        Resource resource = rs.getResource(uri, true);
        if (resource == null || resource.getContents().isEmpty()) {
            throw new RuntimeException("Xtext resource returned no content");
        }
        if (resource.getErrors() != null && !resource.getErrors().isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (var err : resource.getErrors()) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(err.getMessage());
            }
            throw new RuntimeException("Xtext parse errors: " + sb);
        }

        XtendFile xtendFile = (XtendFile) resource.getContents().get(0);
        IrClasses.IrFile ir = new IrClasses.IrFile();
        ir.sourceLanguage = "xtend";
        ir.filePath = path.toString();
        ir.packageName = xtendFile.getPackage();

        for (XtendTypeDeclaration typeDecl : xtendFile.getXtendTypes()) {
            if (typeDecl instanceof XtendClass) {
                ir.classes.add(extractClass((XtendClass) typeDecl, ir.packageName, lines));
            } else if (typeDecl instanceof XtendInterface) {
                ir.classes.add(extractInterface((XtendInterface) typeDecl, ir.packageName, lines));
            }
        }
        return ir;
    }

    // ── Classes ──

    private IrClasses.IrClass extractClass(XtendClass xtendClass, String pkg, String[] lines) {
        IrClasses.IrClass cls = new IrClasses.IrClass();
        cls.name = xtendClass.getName();
        cls.qualifiedName = (pkg != null ? pkg + "." : "") + cls.name;
        cls.kind = "xtend_class";

        INode node = NodeModelUtils.findActualNodeFor(xtendClass);
        if (node != null) { cls.lineStart = node.getStartLine(); cls.lineEnd = node.getEndLine(); }

        if (xtendClass.getExtends() != null) cls.superclass = xtendClass.getExtends().getSimpleName();
        for (JvmTypeReference iface : xtendClass.getImplements()) {
            cls.interfaces.add(iface.getSimpleName());
        }
        extractAnnotations(xtendClass, cls.annotations);
        extractMembers(xtendClass.getMembers(), cls, lines);
        return cls;
    }

    private IrClasses.IrClass extractInterface(XtendInterface iface, String pkg, String[] lines) {
        IrClasses.IrClass cls = new IrClasses.IrClass();
        cls.name = iface.getName();
        cls.qualifiedName = (pkg != null ? pkg + "." : "") + cls.name;
        cls.kind = "xtend_interface";
        cls.isAbstract = true;

        INode node = NodeModelUtils.findActualNodeFor(iface);
        if (node != null) { cls.lineStart = node.getStartLine(); cls.lineEnd = node.getEndLine(); }

        extractAnnotations(iface, cls.annotations);
        extractMembers(iface.getMembers(), cls, lines);
        return cls;
    }

    // ── Members ──

    private void extractMembers(EList<XtendMember> members, IrClasses.IrClass cls, String[] lines) {
        for (XtendMember member : members) {
            if (member instanceof XtendFunction) {
                cls.methods.add(extractFunction((XtendFunction) member, cls.qualifiedName, lines));
            } else if (member instanceof XtendConstructor) {
                cls.methods.add(extractConstructor((XtendConstructor) member, cls.name, lines));
            }
            // XtendField → skip
        }
    }

    // ── Methods ──

    private IrClasses.IrMethod extractFunction(XtendFunction function, String classQName, String[] lines) {
        IrClasses.IrMethod m = new IrClasses.IrMethod();
        m.name = function.getName();

        // Return type — try resolved type first, then fallback to source text
        m.returnType = typeRefName(function.getReturnType());
        if ("void".equals(m.returnType) && lines.length > 0) {
            String srcType = extractReturnTypeFromSource(function, lines);
            if (srcType != null) m.returnType = srcType;
        }

        // Signature — collect param types with source fallback
        List<String> sigParamTypes = new ArrayList<>();
        for (int pi = 0; pi < function.getParameters().size(); pi++) {
            String ptype = typeRefName(function.getParameters().get(pi).getParameterType());
            if ("void".equals(ptype) && lines.length > 0) {
                String srcType = extractParamTypeFromSource(function, pi, lines);
                if (srcType != null) ptype = srcType;
            }
            sigParamTypes.add(ptype);
        }
        StringBuilder sig = new StringBuilder(m.name + "(");
        for (int i = 0; i < sigParamTypes.size(); i++) {
            if (i > 0) sig.append(",");
            sig.append(sigParamTypes.get(i));
        }
        sig.append(")");
        if (!"void".equals(m.returnType)) sig.append(":").append(m.returnType);
        m.signature = sig.toString();

        m.isAbstract = function.isAbstract();
        m.isOverride = function.isOverride();
        m.isStatic = function.isStatic();
        m.isDispatch = function.isDispatch();

        extractAnnotations(function, m.annotations);
        if (m.isDispatch) m.annotations.add("dispatch");

        // Parameters
        for (int pi = 0; pi < function.getParameters().size(); pi++) {
            XtendParameter param = function.getParameters().get(pi);
            Map<String, String> pm = new HashMap<>();
            pm.put("name", param.getName());
            String ptype = typeRefName(param.getParameterType());
            if ("void".equals(ptype) && lines.length > 0) {
                String srcType = extractParamTypeFromSource(function, pi, lines);
                if (srcType != null) ptype = srcType;
            }
            pm.put("type", ptype);
            m.parameters.add(pm);
        }

        // Visibility
        m.visibility = visibilityName(function);

        // Line numbers
        INode node = NodeModelUtils.findActualNodeFor(function);
        if (node != null) { m.lineStart = node.getStartLine(); m.lineEnd = node.getEndLine(); }

        // Body analysis
        analyzeBody(function, m, lines);
        return m;
    }

    private IrClasses.IrMethod extractConstructor(XtendConstructor ctor, String className, String[] lines) {
        IrClasses.IrMethod m = new IrClasses.IrMethod();
        m.name = className;
        m.returnType = className;
        m.signature = className + "(...):" + className;

        INode node = NodeModelUtils.findActualNodeFor(ctor);
        if (node != null) { m.lineStart = node.getStartLine(); m.lineEnd = node.getEndLine(); }

        m.visibility = visibilityName(ctor);
        analyzeBody(ctor, m, lines);
        return m;
    }

    // ── Body analysis (preprocessor + CfgBuilder + RichString) ──

    private void analyzeBody(XtendExecutable exec, IrClasses.IrMethod m, String[] lines) {
        try {
            XExpression bodyExpr = exec.getExpression();
            if (bodyExpr == null) {
                setEmptyResult(m);
                return;
            }

            // Get body source lines using body expression's AST node
            INode bodyNode = NodeModelUtils.findActualNodeFor(bodyExpr);
            if (bodyNode == null) { setEmptyResult(m); return; }
            int bodyStartLine = bodyNode.getStartLine();
            int bodyEndLine = bodyNode.getEndLine();

            // Extract template decisions from RichString BEFORE preprocessor+CFG
            // (so template decisions survive even if JavaParser chokes on template body)
            List<IrClasses.IrDecision> templateDecisions = new ArrayList<>();
            if (bodyExpr instanceof RichString) {
                CfgBuilder cb = new CfgBuilder();
                walkRichString((RichString) bodyExpr, templateDecisions, cb);
            }

            // Try preprocess → JavaParser → CfgBuilder (may fail for template-rich bodies)
            try {
                List<String> bodyLines = new ArrayList<>();
                for (int i = bodyStartLine; i <= bodyEndLine && i <= lines.length; i++) {
                    bodyLines.add(lines[i - 1]);
                }
                if (!bodyLines.isEmpty()) {
                    String bodyText = preprocessor.processMethodBody(bodyLines);
                    String blockSource = "{\n" + bodyText + "\n}";
                    BlockStmt block = StaticJavaParser.parseBlock(blockSource);
                    CfgBuilder cfgBuilder = new CfgBuilder();
                    cfgBuilder.visit(block);

                    m.decisions = cfgBuilder.decisions;
                    m.cyclomaticComplexity = cfgBuilder.cyclomaticComplexity;
                    m.branchCount = cfgBuilder.branchCount;
                    m.conditionCount = cfgBuilder.conditionCount;
                    m.calls = cfgBuilder.calls;
                    m.cfg = cfgBuilder.buildCfg();
                }
            } catch (Exception e) {
                System.err.println("[xtend-extractor] body analysis (CFG) error in " + m.name + ": " + e.getMessage());
                // CFG analysis failed — still keep template decisions below
            }

            // Prepend template decisions before body CFG decisions
            if (!templateDecisions.isEmpty()) {
                List<IrClasses.IrDecision> all = new ArrayList<>();
                all.addAll(templateDecisions);
                if (m.decisions != null) all.addAll(m.decisions);
                m.decisions = all;
                m.cyclomaticComplexity += templateDecisions.size();
                m.branchCount += templateDecisions.size() * 2;
            }
            if (m.decisions == null) m.decisions = new ArrayList<>();
            if (m.calls == null) m.calls = new ArrayList<>();
            if (m.cfg == null) { m.cfg = new IrClasses.IrCfg(); }

        } catch (Exception e) {
            System.err.println("[xtend-extractor] body analysis error in " + m.name + ": " + e.getMessage());
            setEmptyResult(m);
        }
    }

    private void setEmptyResult(IrClasses.IrMethod m) {
        m.decisions = new ArrayList<>();
        m.calls = new ArrayList<>();
        m.branchCount = 0;
        m.conditionCount = 0;
        m.cyclomaticComplexity = 1;
        m.cfg = new IrClasses.IrCfg();
    }

    // ── RichString template decision extraction ──

    private void walkRichString(RichString richString, List<IrClasses.IrDecision> out, CfgBuilder cb) {
        for (XExpression expr : richString.getExpressions()) {
            if (expr instanceof RichStringIf) {
                walkRichStringIf((RichStringIf) expr, out, cb);
            } else if (expr instanceof RichStringForLoop) {
                walkRichStringForLoop((RichStringForLoop) expr, out, cb);
            }
        }
    }

    private void walkRichStringIf(RichStringIf richIf, List<IrClasses.IrDecision> out, CfgBuilder cb) {
        // IF
        String condition = richIf.getIf() != null ? richIf.getIf().toString().trim() : "";
        int line = getLine(richIf);
        IrClasses.IrDecision ifDec = cb.createDecision("template_if", condition, line);
        if (ifDec != null) out.add(ifDec);

        // THEN block — recurse
        if (richIf.getThen() instanceof RichString) {
            walkRichString((RichString) richIf.getThen(), out, cb);
        }

        // ELSEIF
        for (RichStringElseIf elseIf : richIf.getElseIfs()) {
            String elseIfCond = elseIf.getIf() != null ? elseIf.getIf().toString().trim() : "";
            int elseIfLine = getLine(elseIf);
            IrClasses.IrDecision elseIfDec = cb.createDecision("template_elseif", elseIfCond, elseIfLine);
            if (elseIfDec != null) out.add(elseIfDec);

            if (elseIf.getThen() instanceof RichString) {
                walkRichString((RichString) elseIf.getThen(), out, cb);
            }
        }

        // ELSE
        if (richIf.getElse() instanceof RichString) {
            walkRichString((RichString) richIf.getElse(), out, cb);
        }
    }

    private void walkRichStringForLoop(RichStringForLoop forLoop, List<IrClasses.IrDecision> out, CfgBuilder cb) {
        String iterable = forLoop.getForExpression() != null
            ? forLoop.getForExpression().toString().trim()
            : (forLoop.getDeclaredParam() != null ? forLoop.getDeclaredParam().toString().trim() : "");
        int line = getLine(forLoop);
        IrClasses.IrDecision dec = cb.createDecision("foreach", iterable, line);
        if (dec != null) out.add(dec);

        // Recurse into loop body via getEachExpression()
        if (forLoop.getEachExpression() instanceof RichString) {
            walkRichString((RichString) forLoop.getEachExpression(), out, cb);
        }
    }

    private int getLine(Object obj) {
        if (obj instanceof XExpression) {
            INode n = NodeModelUtils.findActualNodeFor((XExpression) obj);
            if (n != null) return n.getStartLine();
        }
        if (obj instanceof RichStringElseIf) {
            INode n = NodeModelUtils.findActualNodeFor((RichStringElseIf) obj);
            if (n != null) return n.getStartLine();
        }
        return 0;
    }

    // ── Helpers ──

    private String typeRefName(JvmTypeReference ref) {
        if (ref == null) return "void";
        try {
            java.lang.reflect.Method m = ref.getClass().getMethod("getSimpleName");
            return (String) m.invoke(ref);
        } catch (Exception e) {
            return ref.getIdentifier();
        }
    }

    private String visibilityName(XtendMember member) {
        String mods = String.join(" ", member.getModifiers());
        if (mods.contains("private")) return "private";
        if (mods.contains("protected")) return "protected";
        if (mods.contains("public")) return "public";
        return "package";
    }

    private void extractAnnotations(XtendAnnotationTarget target, List<String> out) {
        for (var ann : target.getAnnotations()) {
            try {
                out.add(ann.getAnnotationType().getSimpleName());
            } catch (Exception e) {
                out.add(ann.getAnnotationType().getIdentifier());
            }
        }
    }

    // ── Source-based type extraction (fallback when JVM types unresolvable) ──

    private String getDeclarationBlock(XtendFunction function, String[] lines) {
        INode node = NodeModelUtils.findActualNodeFor(function);
        if (node == null) return null;
        int startIdx = node.getStartLine() - 1;
        if (startIdx < 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = startIdx; i < lines.length; i++) {
            String l = lines[i];
            sb.append(' ').append(l.trim());
            if (l.contains(")")) break;
        }
        return sb.toString().trim();
    }

    private String extractReturnTypeFromSource(XtendFunction function, String[] lines) {
        String decl = getDeclarationBlock(function, lines);
        if (decl == null) return null;
        Matcher m = Pattern.compile("def\\s+(\\w+(?:\\.\\w+)*(?:<[^>]*>)?(?:\\[\\])?)\\s+\\w+\\s*\\(").matcher(decl);
        if (m.find()) { String t = m.group(1); if (t != null && !t.equals("def") && !t.equals(function.getName())) return t; }
        Matcher m2 = Pattern.compile(":\\s*(\\w+(?:\\.\\w+)*(?:<[^>]*>)?)\\s*\\(").matcher(decl);
        if (m2.find()) return m2.group(1);
        return null;
    }

    private String extractParamTypeFromSource(XtendFunction function, int paramIdx, String[] lines) {
        String decl = getDeclarationBlock(function, lines);
        if (decl == null) return null;
        int parenStart = decl.indexOf('(');
        int parenEnd = decl.lastIndexOf(')');
        if (parenStart < 0 || parenEnd <= parenStart) return null;
        String paramsStr = decl.substring(parenStart + 1, parenEnd);
        String[] parts = paramsStr.split(",");
        if (paramIdx >= parts.length) return null;
        String part = parts[paramIdx].trim();
        String[] words = part.split("\\s+");
        return words.length >= 2 ? words[0] : null;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Regex fallback
    // ═══════════════════════════════════════════════════════════════════

    private IrClasses.IrFile extractWithRegex(Path path, String source, String[] lines) {
        IrClasses.IrFile ir = new IrClasses.IrFile();
        ir.sourceLanguage = "xtend";
        ir.filePath = path.toString();

        List<TemplateMarker> allTemplateMarkers = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            Matcher tmplIf = Pattern.compile("^«IF\\s+(.+?)»").matcher(line);
            if (tmplIf.find()) allTemplateMarkers.add(new TemplateMarker(i, "template_if", tmplIf.group(1)));
            Matcher tmplElseIf = Pattern.compile("^«ELSEIF\\s+(.+?)»").matcher(line);
            if (tmplElseIf.find()) allTemplateMarkers.add(new TemplateMarker(i, "template_elseif", tmplElseIf.group(1)));
            if (line.startsWith("«ELSE»")) allTemplateMarkers.add(new TemplateMarker(i, "template_else", null));
            if (line.startsWith("«ENDIF»")) allTemplateMarkers.add(new TemplateMarker(i, "template_endif", null));
        }

        ClassParseState currentClass = null;
        String pkg = null;

        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty() || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
            if (line.contains("«") && !line.contains("IF") && !line.contains("ELSE")) continue;

            if (currentClass == null) {
                Matcher pkgMatch = Pattern.compile("^package\\s+([\\w.]+)").matcher(line);
                if (pkgMatch.find() && !line.contains(";")) {
                    pkg = pkgMatch.group(1); ir.packageName = pkg; continue;
                }
                if (line.startsWith("import ") || line.startsWith("@")) continue;

                Matcher clsMatch = Pattern.compile(
                    "^((?:public|protected|private|abstract|final|static)\\s+)*(@\\w+\\s+)?(class|interface|enum)\\s+(\\w+)"
                ).matcher(line);
                if (clsMatch.find()) {
                    currentClass = new ClassParseState();
                    currentClass.name = clsMatch.group(4);
                    currentClass.qualifiedName = (pkg != null ? pkg + "." : "") + currentClass.name;
                    currentClass.kind = "xtend_class";
                    currentClass.lineStart = i + 1;
                    currentClass.braceDepth = 0;
                    currentClass.classStartLine = i;
                    currentClass.sourceLines = lines;
                    currentClass.templateMarkers = allTemplateMarkers;
                    Matcher extMatch = Pattern.compile("extends\\s+(\\w+)").matcher(line);
                    if (extMatch.find()) currentClass.superclass = extMatch.group(1);
                }
                continue;
            }

            int depthBeforeLine = currentClass.braceDepth;
            for (char c : line.toCharArray()) { if (c == '{') currentClass.braceDepth++; if (c == '}') currentClass.braceDepth--; }

            if (depthBeforeLine == 0 && currentClass.braceDepth == -1 && currentClass.currentMethod == null && line.startsWith("}")) {
                currentClass.lineEnd = i + 1;
                analyzeMethodsRegex(currentClass);
                ir.classes.add(currentClass.toIrClass());
                currentClass = null;
                continue;
            }

            if (line.startsWith("@")) {
                String stripped = line.replaceFirst("^@\\w+\\s+", "");
                if (!isMethodDeclaration(stripped)) continue;
            }

            if (currentClass.currentMethod == null || currentClass.braceDepth < currentClass.currentMethod.braceDepthOnEntry) {
                String checkLine = line.replaceFirst("^@\\w+\\s+", "");
                if (isMethodDeclaration(checkLine)) {
                    if (currentClass.currentMethod != null) currentClass.endMethod(i - 1);
                    currentClass.startMethod(i, pkg, depthBeforeLine);
                    continue;
                }
            }

            if (currentClass.currentMethod != null) {
                if (currentClass.braceDepth == currentClass.currentMethod.braceDepthOnEntry && line.startsWith("}")) {
                    currentClass.endMethod(i); continue;
                }
                if (currentClass.currentMethod.bodyEndLine < i) currentClass.currentMethod.bodyEndLine = i;
            }
        }

        if (currentClass != null) {
            if (currentClass.currentMethod != null) currentClass.endMethod(lines.length - 1);
            analyzeMethodsRegex(currentClass);
            ir.classes.add(currentClass.toIrClass());
        }
        return ir;
    }

    private static boolean isMethodDeclaration(String raw) {
        if (Pattern.compile("^(?:public|protected|private)?\\s*new\\s*\\(").matcher(raw).find()) return true;
        if (Pattern.compile("\\bdef\\s+").matcher(raw).find()) return true;
        if (Pattern.compile("\\b(?:override|dispatch)\\b").matcher(raw).find() && raw.contains("(") && raw.contains(")")) return true;
        if (Pattern.compile("^(?:public|protected|private|static|final|abstract)\\s+").matcher(raw).find())
            return raw.contains("(") && raw.contains(")");
        return false;
    }

    private void analyzeMethodsRegex(ClassParseState cls) {
        for (MethodParseState mp : cls.methods) {
            List<String> bodyLines = new ArrayList<>();
            if (mp.hasBody && mp.bodyStartLine <= mp.bodyEndLine) {
                for (int bi = mp.bodyStartLine; bi <= mp.bodyEndLine && bi < cls.sourceLines.length; bi++)
                    bodyLines.add(cls.sourceLines[bi]);
            }

            for (TemplateMarker tm : cls.templateMarkers) {
                int tmLine = tm.line + 1;
                if (tmLine >= mp.declaredOnLine + 1 && tmLine <= mp.bodyEndLine + 1) {
                    if ("template_if".equals(tm.kind) || "template_elseif".equals(tm.kind)) {
                        if (mp.templateDecisions == null) mp.templateDecisions = new ArrayList<>();
                        mp.templateDecisions.add(tm);
                    }
                }
            }

            if (bodyLines.isEmpty()) { mp.analyzerDecisions = new ArrayList<>(); mp.analyzerCalls = new ArrayList<>(); continue; }

            try {
                String bodyText = preprocessor.processMethodBody(bodyLines);
                bodyText = bodyText.replaceFirst("\\s*}\\s*$", "");
                BlockStmt block = StaticJavaParser.parseBlock("{\n" + bodyText + "\n}");
                CfgBuilder cfgBuilder = new CfgBuilder();
                cfgBuilder.visit(block);

                if (mp.templateDecisions != null && !mp.templateDecisions.isEmpty()) {
                    int markerIdx = 0;
                    for (int di = 0; di < cfgBuilder.decisions.size() && markerIdx < mp.templateDecisions.size(); di++) {
                        IrClasses.IrDecision d = cfgBuilder.decisions.get(di);
                        TemplateMarker tm = mp.templateDecisions.get(markerIdx);
                        if (d.kind.equals("if") && tm.kind.equals("template_if")) { d.kind = "template_if"; markerIdx++; }
                        else if (d.kind.equals("else_if") && tm.kind.equals("template_elseif")) { d.kind = "template_elseif"; markerIdx++; }
                    }
                }

                mp.analyzerDecisions = cfgBuilder.decisions;
                mp.analyzerCalls = cfgBuilder.calls;
                mp.analyzerBranchCount = cfgBuilder.branchCount;
                mp.analyzerConditionCount = cfgBuilder.conditionCount;
                mp.analyzerCyclomaticComplexity = cfgBuilder.cyclomaticComplexity;
                IrClasses.IrCfg cfg = cfgBuilder.buildCfg();
                mp.analyzerCfgNodes = cfg.nodes;
                mp.analyzerCfgEdges = cfg.edges;
            } catch (Exception e) {
                System.err.println("[xtend-extractor] parse error in " + mp.name + ": " + e.getMessage());
                mp.analyzerDecisions = new ArrayList<>(); mp.analyzerCalls = new ArrayList<>();
                if (mp.templateDecisions != null) {
                    CfgBuilder cb = new CfgBuilder();
                    for (TemplateMarker tm : mp.templateDecisions) {
                        IrClasses.IrDecision dec = cb.createDecision(tm.kind, tm.expression, tm.line + 1);
                        if (dec != null) mp.analyzerDecisions.add(dec);
                    }
                }
            }
        }
    }

    // ── Internal state classes (regex fallback) ──

    static class TemplateMarker {
        int line; String kind; String expression;
        TemplateMarker(int line, String kind, String expression) {
            this.line = line; this.kind = kind; this.expression = expression;
        }
    }

    static class ClassParseState {
        String name, qualifiedName, kind, superclass;
        int lineStart, lineEnd, braceDepth = 0, classStartLine;
        String[] sourceLines;
        MethodParseState currentMethod;
        List<MethodParseState> methods = new ArrayList<>();
        List<TemplateMarker> templateMarkers = new ArrayList<>();

        void startMethod(int lineIdx, String pkg, int depthBeforeLine) {
            if (currentMethod != null) endMethod(lineIdx - 1);
            MethodParseState mp = new MethodParseState();
            mp.declaredOnLine = lineIdx; mp.bodyStartLine = lineIdx + 1; mp.bodyEndLine = lineIdx; mp.braceDepthOnEntry = depthBeforeLine;
            String raw = sourceLines[lineIdx].trim().replaceFirst("^@\\w+\\s+", "");

            Matcher ctorMatch = Pattern.compile("^(?:public|protected|private)?\\s*new\\s*\\(([^)]*)\\)").matcher(raw);
            if (ctorMatch.find()) {
                mp.name = qualifiedName != null ? qualifiedName.substring(qualifiedName.lastIndexOf('.') + 1) : "Constructor";
                mp.signature = mp.name + "():void";
                currentMethod = mp; methods.add(mp); return;
            }
            Matcher defMatch = Pattern.compile(
                "^(?:(?:public|protected|private|abstract|final|static|override|dispatch)\\s+)*def\\s+(?:(\\w+(?:<[^>]*>)?(?:\\[\\])?)\\s+)?(\\w+)\\s*\\(([^)]*)\\)"
            ).matcher(raw);
            if (defMatch.find()) {
                mp.name = defMatch.group(2); mp.returnType = defMatch.group(1) != null ? defMatch.group(1) : "void";
                mp.signature = mp.name + "()" + (mp.returnType.equals("void") ? "" : ":" + mp.returnType);
                currentMethod = mp; methods.add(mp); return;
            }
            mp.name = "unknown"; mp.signature = "unknown():void"; currentMethod = mp; methods.add(mp);
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
            cls.name = name; cls.qualifiedName = qualifiedName; cls.kind = kind;
            cls.lineStart = lineStart; cls.lineEnd = lineEnd; cls.superclass = superclass; cls.annotations = new ArrayList<>();
            for (MethodParseState mp : methods) {
                IrClasses.IrMethod m = new IrClasses.IrMethod();
                m.name = mp.name != null ? mp.name : "unknown";
                m.signature = mp.signature != null ? mp.signature : m.name + "():void";
                m.returnType = mp.returnType != null ? mp.returnType : "void";
                m.visibility = "public";
                m.lineStart = mp.declaredOnLine + 1; m.lineEnd = mp.bodyEndLine + 1;
                m.decisions = mp.analyzerDecisions != null ? mp.analyzerDecisions : new ArrayList<>();
                m.branchCount = mp.analyzerBranchCount; m.conditionCount = mp.analyzerConditionCount;
                m.cyclomaticComplexity = mp.analyzerCyclomaticComplexity;
                m.calls = mp.analyzerCalls != null ? mp.analyzerCalls : new ArrayList<>();
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
        String name, signature, returnType = "void";
        int declaredOnLine, bodyStartLine, bodyEndLine, braceDepthOnEntry;
        boolean hasBody, isOverride;
        List<TemplateMarker> templateDecisions;
        List<IrClasses.IrDecision> analyzerDecisions;
        List<Map<String, Object>> analyzerCalls;
        int analyzerBranchCount, analyzerConditionCount, analyzerCyclomaticComplexity;
        List<Map<String, Object>> analyzerCfgNodes, analyzerCfgEdges;
    }
}
