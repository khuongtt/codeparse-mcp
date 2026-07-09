package com.codeparse.extractor;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Line-by-line Xtend body analyzer — port of JS analyzeXtendBody() from
 * src/parser/xtend-parser.js lines 430–671.
 *
 * Processes method body text and produces decisions, CFG nodes/edges, call sites,
 * CC/BC/CC counts. Uses CfgBuilder's createDecision for decision creation.
 */
public class XtendBodyAnalyzer {

    public final List<IrClasses.IrDecision> decisions = new ArrayList<>();
    public final List<Map<String, Object>> calls = new ArrayList<>();
    public int cyclomaticComplexity = 1;
    public int branchCount = 0;
    public int conditionCount = 0;

    private final List<Map<String, Object>> cfgNodes = new ArrayList<>();
    private final List<Map<String, Object>> cfgEdges = new ArrayList<>();
    private int nodeIdx = 0;

    private static final Set<String> KEYWORDS = new HashSet<>(Arrays.asList(
            "if", "else", "for", "while", "switch", "case", "return", "throw", "try", "catch"));

    public IrClasses.IrCfg getCfg() {
        IrClasses.IrCfg cfg = new IrClasses.IrCfg();
        cfg.nodes = cfgNodes;
        cfg.edges = cfgEdges;
        return cfg;
    }

    private int addNode(String type, String label, Integer line, String cond) {
        int id = ++nodeIdx;
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("id", id);
        n.put("nodeType", type);
        n.put("label", label != null ? label : "");
        if (line != null) n.put("line", line);
        if (cond != null) n.put("condition", cond);
        n.put("orderIdx", id);
        cfgNodes.add(n);
        return id;
    }

    private void addEdge(int from, int to, String edgeType, String condition) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("fromNode", from);
        e.put("toNode", to);
        e.put("edgeType", edgeType != null ? edgeType : "sequential");
        if (condition != null) e.put("condition", condition);
        cfgEdges.add(e);
    }

    private void registerDecision(String kind, String expr, Integer line) {
        if (expr == null || expr.isEmpty()) return;
        CfgBuilder builder = new CfgBuilder();
        IrClasses.IrDecision dec = builder.createDecision(kind, expr, line);
        if (dec != null) {
            decisions.add(dec);
            branchCount += 2;
            conditionCount += dec.conditions.size();
        }
    }

    /**
     * Analyze Xtend method body lines.
     * @param bodyLines list of raw source lines that form the method body
     */
    public void analyze(List<String> bodyLines) {
        int prev = addNode("ENTRY", "entry", null, null);

        for (int i = 0; i < bodyLines.size(); i++) {
            String line = bodyLines.get(i).trim();
            if (line.isEmpty()) continue;

            // template IF
            Matcher tmplIf = Pattern.compile("^«IF\\s+(.+?)»").matcher(line);
            if (tmplIf.find()) {
                cyclomaticComplexity++;
                registerDecision("template_if", tmplIf.group(1), i + 1);
                int n = addNode("BRANCH", "«IF " + tmplIf.group(1) + "»", i + 1, tmplIf.group(1));
                addEdge(prev, n, "sequential", null);
                int merge = addNode("STATEMENT", "tmpl_if_merge", null, null);
                addEdge(n, merge, "true_branch", "true");
                addEdge(n, merge, "false_branch", "false");
                prev = merge;
                continue;
            }

            // template ELSEIF
            Matcher tmplElseIf = Pattern.compile("^«ELSEIF\\s+(.+?)»").matcher(line);
            if (tmplElseIf.find()) {
                cyclomaticComplexity++;
                registerDecision("template_elseif", tmplElseIf.group(1), i + 1);
                int n = addNode("BRANCH", "«ELSEIF " + tmplElseIf.group(1) + "»", i + 1, tmplElseIf.group(1));
                addEdge(prev, n, "sequential", null);
                int merge = addNode("STATEMENT", "tmpl_elseif_merge", null, null);
                addEdge(n, merge, "true_branch", "true");
                addEdge(n, merge, "false_branch", "false");
                prev = merge;
                continue;
            }

            // template ELSE
            if (line.startsWith("«ELSE»")) {
                int n = addNode("STATEMENT", "«ELSE»", i + 1, null);
                addEdge(prev, n, "sequential", null);
                prev = n;
                continue;
            }

            // template ENDIF
            if (line.startsWith("«ENDIF»")) {
                int n = addNode("STATEMENT", "«ENDIF»", i + 1, null);
                addEdge(prev, n, "sequential", null);
                prev = n;
                continue;
            }

            // else_if expression
            Matcher elseIf = Pattern.compile("^else\\s+if\\s*\\((.+?)\\)").matcher(line);
            if (elseIf.find()) {
                cyclomaticComplexity++;
                registerDecision("else_if", elseIf.group(1), i + 1);
                int n = addNode("BRANCH", "else if (" + elseIf.group(1) + ")", i + 1, elseIf.group(1));
                addEdge(prev, n, "sequential", null);
                int merge = addNode("STATEMENT", "else_if_merge", null, null);
                addEdge(n, merge, "true_branch", "true");
                addEdge(n, merge, "false_branch", "false");
                prev = merge;
                continue;
            }

            // if expression
            Matcher ifMatch = Pattern.compile("^if\\s*\\((.+?)\\)").matcher(line);
            if (ifMatch.find()) {
                String cond = ifMatch.group(1);
                cyclomaticComplexity++;
                registerDecision("if", cond, i + 1);
                int n = addNode("BRANCH", "if (" + cond + ")", i + 1, cond);
                addEdge(prev, n, "sequential", null);
                int merge = addNode("STATEMENT", "if_merge", null, null);
                addEdge(n, merge, "true_branch", "true");
                addEdge(n, merge, "false_branch", "false");
                prev = merge;
                continue;
            }

            // for/forEach iteration
            if (Pattern.compile("^(?:for|forEach)\\s*[\\(\\[]").matcher(line).find()) {
                cyclomaticComplexity++;
                Matcher varMatch = Pattern.compile("^for\\s*\\((\\w+)\\s*:").matcher(line);
                String loopVar = varMatch.find() ? "iterate:" + varMatch.group(1) : "for-each";
                registerDecision("foreach", loopVar, i + 1);
                int n = addNode("LOOP", line.length() > 60 ? line.substring(0, 60) : line, i + 1, loopVar);
                addEdge(prev, n, "sequential", null);
                int exit = addNode("STATEMENT", "loop_exit", null, null);
                addEdge(n, exit, "false_branch", "false");
                prev = exit;
                continue;
            }

            // while
            Matcher whileMatch = Pattern.compile("^while\\s*\\((.+?)\\)").matcher(line);
            if (whileMatch.find()) {
                String cond = whileMatch.group(1);
                cyclomaticComplexity++;
                registerDecision("while", cond, i + 1);
                int n = addNode("LOOP", "while (" + cond + ")", i + 1, cond);
                addEdge(prev, n, "sequential", null);
                int exit = addNode("STATEMENT", "while_exit", null, null);
                addEdge(n, exit, "false_branch", "false");
                prev = exit;
                continue;
            }

            // ternary (balanced-scanner)
            Matcher ternMatch = Pattern.compile("(?:return|val|var|\\w+\\s*=)\\s*(.*?)\\s*\\?\\s").matcher(line);
            if (ternMatch.find()) {
                String condCandidate = ternMatch.group(1);
                int depth = 0, condEnd = -1;
                for (int c = condCandidate.length() - 1; c >= 0; c--) {
                    if (condCandidate.charAt(c) == ')') depth++;
                    if (condCandidate.charAt(c) == '(') depth--;
                    if (depth == 0 && (condCandidate.charAt(c) == '(' || Character.isLetterOrDigit(condCandidate.charAt(c)))) {
                        condEnd = c;
                        break;
                    }
                }
                String cond = condEnd >= 0 ? condCandidate.substring(condEnd).trim() : condCandidate.trim();
                if (!cond.isEmpty()) {
                    cyclomaticComplexity++;
                    registerDecision("ternary", cond, i + 1);
                    int n = addNode("BRANCH", "ternary: " + cond, i + 1, cond);
                    addEdge(prev, n, "sequential", null);
                    int merge = addNode("STATEMENT", "ternary_merge", null, null);
                    addEdge(n, merge, "true_branch", "true");
                    addEdge(n, merge, "false_branch", "false");
                    prev = merge;
                    continue;
                }
            }

            // switch
            if (line.startsWith("switch") && Pattern.compile("^switch\\s*\\(").matcher(line).find()) {
                cyclomaticComplexity++;
                int n = addNode("SWITCH", line.length() > 60 ? line.substring(0, 60) : line, i + 1, null);
                addEdge(prev, n, "sequential", null);
                int merge = addNode("STATEMENT", "switch_merge", null, null);
                addEdge(n, merge, "sequential", null);
                prev = merge;
                continue;
            }

            // try
            if (line.startsWith("try")) {
                int n = addNode("TRY", "try", i + 1, null);
                addEdge(prev, n, "sequential", null);
                prev = n;
                continue;
            }

            // catch
            if (line.startsWith("catch") && line.contains(")")) {
                cyclomaticComplexity++;
                int n = addNode("CATCH", line.length() > 60 ? line.substring(0, 60) : line, i + 1, null);
                addEdge(prev, n, "exception", null);
                prev = n;
                continue;
            }

            // return
            if (line.startsWith("return")) {
                int n = addNode("RETURN", line.length() > 60 ? line.substring(0, 60) : line, i + 1, null);
                addEdge(prev, n, "sequential", null);
                prev = n;
                continue;
            }

            // throw
            if (line.startsWith("throw")) {
                int n = addNode("THROW", line.length() > 60 ? line.substring(0, 60) : line, i + 1, null);
                addEdge(prev, n, "exception", null);
                prev = n;
                continue;
            }

            // method call — skip declaration keywords and method decl lines
            if (line.startsWith("def ") || line.startsWith("override ") || line.startsWith("dispatch ")) continue;
            if (!line.startsWith("//") && line.contains("(")) {
                Matcher callMatch = Pattern.compile("(\\w+(?:\\.\\w+)*)\\s*\\(").matcher(line);
                if (callMatch.find() && !KEYWORDS.contains(callMatch.group(1))) {
                    String callee = callMatch.group(1);
                    Map<String, Object> call = new LinkedHashMap<>();
                    call.put("calleeName", callee);
                    call.put("line", i + 1);
                    boolean dup = false;
                    for (Map<String, Object> c : calls) {
                        if (c.get("calleeName").equals(callee)) { dup = true; break; }
                    }
                    if (!dup) calls.add(call);
                    int n = addNode("STATEMENT", "call: " + callee, i + 1, null);
                    addEdge(prev, n, "sequential", null);
                    prev = n;
                }
            }
        }

        int exit = addNode("EXIT", "exit", null, null);
        addEdge(prev, exit, "sequential", null);
    }
}
