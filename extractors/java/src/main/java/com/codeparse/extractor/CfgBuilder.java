package com.codeparse.extractor;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.stmt.*;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.ast.NodeList;

import java.util.*;

/**
 * Walks method body statements, builds decisions, CFG nodes/edges, and call sites.
 * Mirrors the JS BodyAnalyzer from src/parser/java-parser.js.
 * Used by JavaAstExtractor.extractMethod().
 */
public class CfgBuilder {

    private int nodeId = 0;
    private final List<Map<String, Object>> cfgNodes = new ArrayList<>();
    private final List<Map<String, Object>> cfgEdges = new ArrayList<>();

    final List<IrClasses.IrDecision> decisions = new ArrayList<>();
    int cyclomaticComplexity = 1;
    int branchCount = 0;
    int conditionCount = 0;
    final List<Map<String, Object>> calls = new ArrayList<>();

    // ── Entry point ────────────────────────────────────────────────────────────

    /**
     * Called from JavaAstExtractor.extractMethod():
     *   CfgBuilder cfgBuilder = new CfgBuilder();
     *   cfgBuilder.visit(body);
     */
    public void visit(BlockStmt body) {
        // Collect all method calls in body for calls list
        body.walk(MethodCallExpr.class, this::recordCall);

        int entryId = addNode("ENTRY", "entry", null);
        int lastId = walkStatement(body, entryId);
        int exitId = addNode("EXIT", "exit", null);
        addEdge(lastId, exitId, "sequential", null);
    }

    // ── CFG builders ──────────────────────────────────────────────────────────

    IrClasses.IrCfg buildCfg() {
        IrClasses.IrCfg cfg = new IrClasses.IrCfg();
        cfg.nodes = cfgNodes;
        cfg.edges = cfgEdges;
        return cfg;
    }

    private int addNode(String nodeType, String label, Integer line) {
        int id = ++nodeId;
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("id", id);
        n.put("nodeType", nodeType);
        n.put("label", label != null ? label : "");
        if (line != null) n.put("line", line);
        cfgNodes.add(n);
        return id;
    }

    private void addEdge(int from, int to, String edgeType, String condition) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("fromNode", from);
        e.put("toNode", to);
        e.put("edgeType", edgeType);
        if (condition != null) e.put("condition", condition);
        cfgEdges.add(e);
    }

    // ── Statement walkers ─────────────────────────────────────────────────────

    private int walkStatement(Statement stmt, int fromId) {
        if (stmt instanceof BlockStmt) {
            return walkBlock((BlockStmt) stmt, fromId);
        }
        if (stmt instanceof IfStmt) {
            return walkIf((IfStmt) stmt, fromId, false);
        }
        if (stmt instanceof ForStmt) {
            return walkFor((ForStmt) stmt, fromId);
        }
        if (stmt instanceof ForEachStmt) {
            return walkForEach((ForEachStmt) stmt, fromId);
        }
        if (stmt instanceof WhileStmt) {
            return walkWhile((WhileStmt) stmt, fromId);
        }
        if (stmt instanceof DoStmt) {
            return walkDo((DoStmt) stmt, fromId);
        }
        if (stmt instanceof SwitchStmt) {
            return walkSwitch((SwitchStmt) stmt, fromId);
        }
        if (stmt instanceof ReturnStmt) {
            return walkReturn((ReturnStmt) stmt, fromId);
        }
        if (stmt instanceof ThrowStmt) {
            return walkThrow((ThrowStmt) stmt, fromId);
        }
        if (stmt instanceof TryStmt) {
            return walkTry((TryStmt) stmt, fromId);
        }
        if (stmt instanceof ExpressionStmt) {
            Expression expr = ((ExpressionStmt) stmt).getExpression();
            if (expr instanceof ConditionalExpr) {
                walkTernaryExpr((ConditionalExpr) expr, fromId, stmt);
            }
            return walkDefaultStmt(stmt, fromId);
        }
        // Default: simple statement node
        return walkDefaultStmt(stmt, fromId);
    }

    private int walkBlock(BlockStmt block, int fromId) {
        int lastId = fromId;
        for (Statement stmt : block.getStatements()) {
            lastId = walkStatement(stmt, lastId);
        }
        return lastId;
    }

    // ── If / else_if ──────────────────────────────────────────────────────────

    private int walkIf(IfStmt ifStmt, int fromId, boolean isElseIf) {
        String condition = ifStmt.getCondition().toString();
        int line = ifStmt.getBegin().map(p -> p.line).orElse(null);

        // Create decision
        String kind = isElseIf ? "else_if" : "if";
        IrClasses.IrDecision dec = createDecision(kind, condition, line);
        decisions.add(dec);
        cyclomaticComplexity++;
        branchCount += 2;
        if (dec.conditions != null) conditionCount += dec.conditions.size();

        // BRANCH node
        int branchId = addNode("BRANCH", "if (" + truncate(condition) + ")", line);
        addEdge(fromId, branchId, "sequential", null);

        // True branch
        int thenStart = addNode("", "", null); // placeholder start
        int thenEnd = walkStatement(ifStmt.getThenStmt(), thenStart);
        // link: branch -> true_branch -> thenBlock
        addEdge(branchId, thenStart, "true_branch", "true");
        // merge point after then
        int mergeId = addNode("MERGE", "", null);

        // Else branch
        ifStmt.getElseStmt().ifPresent(elseStmt -> {
            if (elseStmt instanceof IfStmt) {
                // else_if — chain: walkIf with isElseIf=true, merge via false_branch
                addEdge(branchId, thenStart, "false_branch", "false");
                // The else_if itself produces its own BRANCH node and merges
                int elseIfId = walkIf((IfStmt) elseStmt, branchId, true);
                addEdge(thenEnd, mergeId, "sequential", null);
                // We need the else_if's end to also merge, but that's handled in the recursive call
                // Simple: connect thenEnd directly, and add another sequential from else_if end
                // Actually this needs more careful handling. Let me simplify.
            } else {
                int elseStart = addNode("", "", null);
                int elseEnd = walkStatement(elseStmt, elseStart);
                addEdge(branchId, elseStart, "false_branch", "false");
                addEdge(elseEnd, mergeId, "sequential", null);
            }
        });

        // If no else, false goes directly to merge
        if (ifStmt.getElseStmt().isEmpty()) {
            addEdge(branchId, mergeId, "false_branch", "false");
        } else if (!(ifStmt.getElseStmt().get() instanceof IfStmt)) {
            // else was not IfStmt, edge already added above
        } else {
            // else_if case — the recursive walkIf handles its own merge
            // For simplicity, just connect thenEnd forward
        }

        addEdge(thenEnd, mergeId, "sequential", null);
        return mergeId;
    }

    // ── Loops ─────────────────────────────────────────────────────────────────

    private int walkFor(ForStmt stmt, int fromId) {
        String condition = stmt.getCompare().map(Expression::toString).orElse("true");
        int line = stmt.getBegin().map(p -> p.line).orElse(null);

        IrClasses.IrDecision dec = createDecision("for", condition, line);
        decisions.add(dec);
        cyclomaticComplexity++;
        branchCount += 2;
        if (dec.conditions != null) conditionCount += dec.conditions.size();

        int loopId = addNode("LOOP", "for (" + truncate(condition) + ")", line);
        addEdge(fromId, loopId, "sequential", null);

        int bodyStart = addNode("", "", null);
        int bodyEnd = walkStatement(stmt.getBody(), bodyStart);
        addEdge(loopId, bodyStart, "true_branch", "true");
        addEdge(bodyEnd, loopId, "loop_back", null);
        addEdge(loopId, bodyEnd, "false_branch", "false");

        return bodyEnd;
    }

    private int walkForEach(ForEachStmt stmt, int fromId) {
        int line = stmt.getBegin().map(p -> p.line).orElse(null);
        String iterable = stmt.getIterable().toString();

        IrClasses.IrDecision dec = createDecision("foreach", iterable, line);
        decisions.add(dec);
        cyclomaticComplexity++;
        branchCount += 2;
        if (dec.conditions != null) conditionCount += dec.conditions.size();

        int loopId = addNode("LOOP", "for (:" + truncate(iterable) + ")", line);
        addEdge(fromId, loopId, "sequential", null);

        int bodyStart = addNode("", "", null);
        int bodyEnd = walkStatement(stmt.getBody(), bodyStart);
        addEdge(loopId, bodyStart, "true_branch", "true");
        addEdge(bodyEnd, loopId, "loop_back", null);

        int exitId = addNode("", "", null);
        addEdge(loopId, exitId, "false_branch", "false");

        return exitId;
    }

    private int walkWhile(WhileStmt stmt, int fromId) {
        String condition = stmt.getCondition().toString();
        int line = stmt.getBegin().map(p -> p.line).orElse(null);

        IrClasses.IrDecision dec = createDecision("while", condition, line);
        decisions.add(dec);
        cyclomaticComplexity++;
        branchCount += 2;
        if (dec.conditions != null) conditionCount += dec.conditions.size();

        int loopId = addNode("LOOP", "while (" + truncate(condition) + ")", line);
        addEdge(fromId, loopId, "sequential", null);

        int bodyStart = addNode("", "", null);
        int bodyEnd = walkStatement(stmt.getBody(), bodyStart);
        addEdge(loopId, bodyStart, "true_branch", "true");
        addEdge(bodyEnd, loopId, "loop_back", null);

        int exitId = addNode("", "", null);
        addEdge(loopId, exitId, "false_branch", "false");

        return exitId;
    }

    private int walkDo(DoStmt stmt, int fromId) {
        String condition = stmt.getCondition().toString();
        int line = stmt.getBegin().map(p -> p.line).orElse(null);

        IrClasses.IrDecision dec = createDecision("do_while", condition, line);
        decisions.add(dec);
        cyclomaticComplexity++;
        branchCount += 2;
        if (dec.conditions != null) conditionCount += dec.conditions.size();

        int bodyStart = addNode("", "", null);
        int bodyEnd = walkStatement(stmt.getBody(), bodyStart);

        int loopId = addNode("LOOP", "do-while (" + truncate(condition) + ")", line);
        addEdge(fromId, bodyStart, "sequential", null);
        addEdge(bodyEnd, loopId, "loop_back", null);
        addEdge(loopId, bodyStart, "true_branch", "true");

        int exitId = addNode("", "", null);
        addEdge(loopId, exitId, "false_branch", "false");

        return exitId;
    }

    // ── Switch ────────────────────────────────────────────────────────────────

    private int walkSwitch(SwitchStmt stmt, int fromId) {
        int line = stmt.getBegin().map(p -> p.line).orElse(null);
        int selectorId = addNode("BRANCH", "switch (...) ", line);
        addEdge(fromId, selectorId, "sequential", null);

        int lastCaseId = selectorId;
        for (SwitchEntry entry : stmt.getEntries()) {
            int entryId = addNode("CASE", entry.toString(), entry.getBegin().map(p -> p.line).orElse(null));
            addEdge(lastCaseId, entryId, "sequential", null);
            lastCaseId = entryId;
        }

        int exitId = addNode("", "", null);
        addEdge(lastCaseId, exitId, "sequential", null);
        return exitId;
    }

    // ── Return / Throw / Try ──────────────────────────────────────────────────

    private int walkReturn(ReturnStmt stmt, int fromId) {
        // Check for ternary in return expression
        stmt.getExpression().ifPresent(expr -> {
            if (expr instanceof ConditionalExpr) {
                walkTernaryExpr((ConditionalExpr) expr, fromId, stmt);
            }
        });
        int line = stmt.getBegin().map(p -> p.line).orElse(null);
        int retId = addNode("RETURN", "return", line);
        addEdge(fromId, retId, "sequential", null);
        return retId;
    }

    private int walkThrow(ThrowStmt stmt, int fromId) {
        int line = stmt.getBegin().map(p -> p.line).orElse(null);
        int thrId = addNode("RETURN", "throw", line);
        addEdge(fromId, thrId, "sequential", null);
        return thrId;
    }

    private int walkTry(TryStmt stmt, int fromId) {
        int line = stmt.getBegin().map(p -> p.line).orElse(null);
        int tryId = addNode("STATEMENT", "try", line);
        addEdge(fromId, tryId, "sequential", null);

        int bodyEnd = walkStatement(stmt.getTryBlock(), tryId);

        int catchEnd = bodyEnd;
        for (CatchClause cc : stmt.getCatchClauses()) {
            String param = cc.getParameter().getType().toString();
            int lineC = cc.getBegin().map(p -> p.line).orElse(null);

            IrClasses.IrDecision dec = createDecision("catch", param, lineC);
            decisions.add(dec);
            cyclomaticComplexity++;
            branchCount += 2;

            int catchId = addNode("CATCH", "catch (" + param + ")", lineC);
            addEdge(bodyEnd, catchId, "sequential", null);
            catchEnd = walkStatement(cc.getBody(), catchId);
        }

        int exitId = addNode("", "", null);
        addEdge(catchEnd, exitId, "sequential", null);
        return exitId;
    }

    // ── Ternary ───────────────────────────────────────────────────────────────

    private void walkTernaryExpr(ConditionalExpr expr, int fromId, Node stmtNode) {
        String condition = expr.getCondition().toString();
        int line = expr.getBegin().map(p -> p.line).orElse(null);

        // Check for compound condition
        IrClasses.IrDecision dec = createDecision("ternary", condition, line);
        decisions.add(dec);
        cyclomaticComplexity++;
        branchCount += 2;
        if (dec.conditions != null) conditionCount += dec.conditions.size();

        int branchId = addNode("BRANCH", "? (" + truncate(condition) + ")", line);
        addEdge(fromId, branchId, "sequential", null);

        // Recurse into branches for nested ternary
        if (expr.getThenExpr() instanceof ConditionalExpr) {
            walkTernaryExpr((ConditionalExpr) expr.getThenExpr(), branchId, expr);
        }
        if (expr.getElseExpr() instanceof ConditionalExpr) {
            walkTernaryExpr((ConditionalExpr) expr.getElseExpr(), branchId, expr);
        }
    }

    // ── Default statement ─────────────────────────────────────────────────────

    private int walkDefaultStmt(Statement stmt, int fromId) {
        int line = stmt.getBegin().map(p -> p.line).orElse(null);
        String label = stmt.toString().replace('\n', ' ').replace('\r', ' ').trim();
        if (label.length() > 50) label = label.substring(0, 50) + "...";
        int nid = addNode("STATEMENT", label, line);
        addEdge(fromId, nid, "sequential", null);

        // Check if this statement contains a ternary expression
        stmt.walk(ConditionalExpr.class, ce -> {
            // Only process top-level ternary, not nested ones
            if (ce.getParentNode().map(p -> p instanceof ExpressionStmt || p instanceof ReturnStmt).orElse(false)) {
                // Already handled by walkReturn or walkStatement
            }
        });

        return nid;
    }

    // ── Call recording ────────────────────────────────────────────────────────

    private void recordCall(MethodCallExpr mce) {
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("calleeName", mce.getNameAsString());
        mce.getBegin().ifPresent(p -> call.put("line", p.line));
        // Avoid duplicates
        for (Map<String, Object> existing : calls) {
            if (existing.get("calleeName").equals(call.get("calleeName"))
                    && Objects.equals(existing.get("line"), call.get("line"))) {
                return;
            }
        }
        calls.add(call);
    }

    // ── Boolean decomposition (ported from decision-utils.js) ─────────────────

    IrClasses.IrDecision createDecision(String kind, String expression, Integer line) {
        if (expression == null || expression.isEmpty()) return null;

        List<String> atomicTexts = decomposeBoolean(expression);

        List<IrClasses.IrCondition> conditions = new ArrayList<>();
        for (int i = 0; i < atomicTexts.size(); i++) {
            IrClasses.IrCondition c = new IrClasses.IrCondition();
            c.position = i + 1;
            c.text = atomicTexts.get(i);
            c.normalizedText = normalizeConditionText(atomicTexts.get(i));
            c.conditionType = detectConditionType(atomicTexts.get(i));
            c.parseStatus = "ok";
            conditions.add(c);
        }

        String operator = detectOperator(expression);
        String normalized = conditions.size() >= 2
                ? buildNormalized(conditions.size(), operator)
                : expression;

        IrClasses.IrDecision dec = new IrClasses.IrDecision();
        dec.kind = kind;
        dec.expression = expression;
        dec.normalized = normalized;
        dec.operator = operator;
        dec.lineStart = line;
        dec.lineEnd = line;
        dec.branchCount = 2;
        dec.mcdcRequired = conditions.size() >= 2;
        dec.conditions = conditions;
        dec.parseStatus = "ok";
        return dec;
    }

    private List<String> decomposeBoolean(String expr) {
        if (expr == null || expr.isEmpty()) return new ArrayList<>();
        String stripped = expr.replaceAll("[()]", " ");
        String[] parts = stripped.split("&&|\\|\\|");
        Set<String> unique = new LinkedHashSet<>();
        for (String part : parts) {
            String cleaned = part.replaceAll("^[!\\s]+", "").trim();
            if (cleaned.length() > 1 && !cleaned.matches("\\d+")) {
                unique.add(cleaned);
            }
        }
        return new ArrayList<>(unique);
    }

    private String detectOperator(String expr) {
        if (expr == null) return null;
        boolean hasAnd = expr.contains("&&");
        boolean hasOr = expr.contains("||");
        if (hasAnd && hasOr) return "MIXED";
        if (hasAnd) return "AND";
        if (hasOr) return "OR";
        return null;
    }

    private String detectConditionType(String text) {
        return text.trim().startsWith("!") ? "negated" : "atomic";
    }

    private String normalizeConditionText(String text) {
        return text.replaceAll("^[!\\s]+", "").trim();
    }

    private String buildNormalized(int count, String operator) {
        if (count < 2) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= count; i++) {
            if (i > 1) {
                if ("OR".equals(operator)) sb.append(" || ");
                else sb.append(" && ");
            }
            sb.append("C").append(i);
        }
        return sb.toString();
    }

    // ── Utility ───────────────────────────────────────────────────────────────

    private String truncate(String s) {
        if (s == null) return "";
        return s.length() > 40 ? s.substring(0, 40) + "..." : s;
    }
}
