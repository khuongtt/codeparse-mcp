package com.codeparse.extractor;

import java.util.*;
import java.util.regex.*;

/**
 * Transforms method body text from Xtend syntax to Java-compatible AST source.
 *
 * Used by XtendAstExtractor: given raw method body lines, returns Java source
 * that CfgBuilder can process via StaticJavaParser.parseBlock().
 *
 * Transforms:
 *   1. Template «IF»/«ELSEIF»/«ELSE»/«ENDIF» -> if/else blocks
 *   2. template content lines: replace with placeholder comment
 *   3. val/var -> Object/final
 *   4. for (x : iterable) -> for (Object x : iterable)
 *   5. Expression-body if-elseif-else chains -> { return ...; }
 *   6. Standalone if/else with brace-less body -> { body; } (no return)
 *   7. Implicit returns -> explicit return
 *   8. Missing semicolons -> appended
 */
public class XtendPreprocessor {

    public static final Set<String> XTEND_KEYWORDS = new HashSet<>(Arrays.asList(
        "if", "else", "for", "while", "switch", "case", "return", "throw", "try", "catch"));

    /**
     * Preprocess method body lines.
     * @param bodyLines raw lines from inside a method body
     * @return preprocessed Java-compatible body text
     */
    public String processMethodBody(List<String> bodyLines) {
        // Phase 1: detect and merge expression-body if-else chains
        // Chain: if (cond) exprBody [+ else if (cond) exprBody]* [+ else exprBody]?
        // Each part has NO braces — that's how we distinguish expression body from statement body
        bodyLines = mergeIfElseExpressionChain(bodyLines);

        // Phase 2: per-line transforms
        List<String> out = new ArrayList<>(bodyLines.size());
        for (String raw : bodyLines) {
            String trimmed = raw.trim();
            if (trimmed.isEmpty()) { out.add(raw); continue; }

            // Template markers
            String t = transformTemplate(trimmed, raw);
            if (t != null) { out.add(t); continue; }

            // val/var
            String vv = transformValVar(trimmed);
            if (vv != null) { out.add(indentLine(raw, vv + ";")); continue; }

            // for (x : iterable)
            Matcher fc = Pattern.compile("^for\\s*\\((\\w+)\\s*:\\s*(.*)\\)(.*)$").matcher(trimmed);
            if (fc.find()) {
                out.add(indentLine(raw, "for (Object " + fc.group(1) + " : " + fc.group(2).trim() + ")" + fc.group(3)));
                continue;
            }

            // Standalone if/else expression body (no braces) — wrap with { body; }
            // This is NOT a return expression — just adds braces + semicolon.
            // The if-else chain merger already handles expression-body returns above.
            if (!trimmed.contains("{") && !trimmed.contains("}")) {
                String s = wrapBareIfElse(trimmed);
                if (s != null) { out.add(indentLine(raw, s)); continue; }
            }

            // Semicolons
            if (needsSemicolon(trimmed)) {
                out.add(raw + ";");
                continue;
            }

            out.add(raw);
        }

        // Phase 3: fix implicit returns (last expression before method's })
        fixImplicitReturns(out);

        return String.join("\n", out);
    }

    // ── Template ──

    static String transformTemplate(String trimmed, String raw) {
        Matcher m = Pattern.compile("^«(IF|ELSEIF)\\s+(.+?)»").matcher(trimmed);
        if (m.find()) {
            if ("IF".equals(m.group(1))) return indentLine(raw, "if (" + m.group(2) + ") {");
            return indentLine(raw, "} else if (" + m.group(2) + ") {");
        }
        if (trimmed.startsWith("«ELSE»")) return indentLine(raw, "} else {");
        if (trimmed.startsWith("«ENDIF»")) return indentLine(raw, "}");
        if (trimmed.contains("«") && trimmed.contains("»")) return indentLine(raw, "/* template */ ;");
        return null;
    }

    // ── Expression-body if-else chain ──

    /**
     * Merge if-else expression chains into single lines with { return ...; }.
     *
     * A chain is: if (cond) exprBody (no braces)
     *            [else if (cond) exprBody]*
     *            [else exprBody]?
     *
     * Each entry has no { } — that's how we distinguish expression body.
     * The branches are wrapped with { return exprBody; }.
     */
    static List<String> mergeIfElseExpressionChain(List<String> lines) {
        List<String> result = new ArrayList<>();
        int i = 0;
        while (i < lines.size()) {
            String trimmed = lines.get(i).trim();

            // Detect start of expression-body if chain
            if ((trimmed.startsWith("if ") || trimmed.startsWith("if("))
                && !trimmed.contains("{") && !trimmed.contains("}")) {

                int chainStart = i;
                List<String> chain = new ArrayList<>();
                chain.add(trimmed);
                i++;

                while (i < lines.size()) {
                    String next = lines.get(i).trim();
                    if (next.startsWith("else if")) {
                        chain.add(next); i++;
                    } else if (next.matches("^else\\s+(?!if)\\S.*") && !next.contains("{")) {
                        chain.add(next); i++;
                    } else if (next.startsWith("elseif")) {
                        chain.add(next.replaceFirst("elseif", "else if")); i++;
                    } else {
                        break;
                    }
                }

                if (chain.size() > 1) {
                    // Merge with { return ...; } in each branch
                    StringBuilder merged = new StringBuilder();
                    for (String part : chain) {
                        if (merged.length() > 0) merged.append(" ");
                        String wrapped = wrapChainPart(part);
                        merged.append(wrapped != null ? wrapped : part);
                    }
                    result.add(indentLine(lines.get(chainStart), merged.toString()));
                } else {
                    // Single if — not a chain, will be handled by wrapBareIfElse later
                    result.add(lines.get(chainStart));
                }
            } else {
                result.add(lines.get(i));
                i++;
            }
        }
        return result;
    }

    /** Wrap one branch of an if-else expression chain with { return ...; } */
    static String wrapChainPart(String part) {
        // if (cond) expr -> if (cond) { return expr; }
        Matcher ifP = Pattern.compile("^(if\\s*\\(.*?\\))\\s+(\\S.*)$").matcher(part);
        if (ifP.find()) return ifP.group(1) + " { return " + ifP.group(2) + "; }";
        // else if (cond) expr -> } else if (cond) { return expr; }
        Matcher eiP = Pattern.compile("^(else\\s+if\\s*\\(.*?\\))\\s+(\\S.*)$").matcher(part);
        if (eiP.find()) return eiP.group(1) + " { return " + eiP.group(2) + "; }";
        // else expr -> } else { return expr; }
        Matcher elP = Pattern.compile("^else\\s+(\\S.*)$").matcher(part);
        if (elP.find() && !part.contains("if")) return "else { return " + elP.group(1) + "; }";
        return null;
    }

    // ── Standalone if/else wrapping (no chain, no braces) ──

    /** Wrap brace-less if/else body with { body; } — NOT adding return */
    static String wrapBareIfElse(String trimmed) {
        // if (cond) exprNoBrace -> if (cond) { expr; }
        Matcher ifB = Pattern.compile("^(if\\s*\\(.*?\\))\\s+(\\S.*)$").matcher(trimmed);
        if (ifB.find()) return ifB.group(1) + " { " + ifB.group(2) + "; }";
        return null;
    }

    // ── val/var ──

    static String transformValVar(String trimmed) {
        Matcher valTyped = Pattern.compile("^val\\s+(\\w+(?:\\.\\w+)*(?:<[^>]*>)?(?:\\[\\])?)\\s+(\\w+)(.*)$").matcher(trimmed);
        if (valTyped.find()) return "final " + valTyped.group(1) + " " + valTyped.group(2) + valTyped.group(3);
        Matcher valPlain = Pattern.compile("^val\\s+(\\w+)(.*)$").matcher(trimmed);
        if (valPlain.find()) return "final Object " + valPlain.group(1) + valPlain.group(2);
        Matcher varTyped = Pattern.compile("^var\\s+(\\w+(?:\\.\\w+)*(?:<[^>]*>)?(?:\\[\\])?)\\s+(\\w+)(.*)$").matcher(trimmed);
        if (varTyped.find()) return varTyped.group(1) + " " + varTyped.group(2) + varTyped.group(3);
        Matcher varPlain = Pattern.compile("^var\\s+(\\w+)(.*)$").matcher(trimmed);
        if (varPlain.find()) return "Object " + varPlain.group(1) + varPlain.group(2);
        return null;
    }

    // ── Implicit returns ──

    /**
     * Find the last expression at depth 0 (method body level) before each `}`,
     * prepend `return `. Skips if-else chains (already have return inside branches).
     */
    static void fixImplicitReturns(List<String> lines) {
        int depth = 0;
        int lastExprIdx = -1;

        for (int i = 0; i < lines.size(); i++) {
            String raw = lines.get(i);
            String trimmed = raw.trim();

            int depthBefore = depth;
            for (char c : raw.toCharArray()) {
                if (c == '{') depth++;
                if (c == '}') depth--;
            }

            if (depthBefore == 0 && trimmed.equals("}")) {
                // About to close method body
                if (lastExprIdx >= 0 && lastExprIdx < i) {
                    String prevLine = lines.get(lastExprIdx);
                    String pt = prevLine.trim().replaceAll(";$", "");
                    // Don't add return if line already starts with return, if, else, for, while, etc.
                    if (!pt.startsWith("return") && !pt.startsWith("if ") && !pt.startsWith("if(")
                        && !pt.startsWith("else") && !pt.startsWith("/* template */")
                        && !pt.startsWith("for ") && !pt.startsWith("while")
                        && !pt.startsWith("try") && !pt.startsWith("switch")
                        && !pt.startsWith("{") && !pt.startsWith("}")
                        && pt.length() > 0) {
                        lines.set(lastExprIdx, indentLine(prevLine, "return " + pt + ";"));
                    }
                }
                lastExprIdx = -1;
            } else if (depthBefore == 0 && !trimmed.isEmpty()) {
                // At method body level — track expression candidates
                if (isImplicitReturnCandidate(trimmed)) {
                    lastExprIdx = i;
                } else {
                    lastExprIdx = -1;
                }
            }
        }
    }

    static boolean isImplicitReturnCandidate(String trimmed) {
        if (trimmed.isEmpty() || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
        if (trimmed.equals("{") || trimmed.equals("}")) return false;
        String first = trimmed.split("\\s")[0];
        if (XTEND_KEYWORDS.contains(first)) return false;
        if (first.equals("val") || first.equals("var")) return false;
        if (first.equals("public") || first.equals("private") || first.equals("protected")) return false;
        if (first.equals("static") || first.equals("final") || first.equals("abstract")) return false;
        if (first.equals("class") || first.equals("interface") || first.equals("enum") || first.equals("@")) return false;
        if (trimmed.startsWith("«") || trimmed.startsWith("/* template */")) return false;
        if (trimmed.contains("=") && !trimmed.contains("==") && !trimmed.contains("?")) return false;
        // Has to be a simple expression
        return true;
    }

    // ── Semicolons ──

    static boolean needsSemicolon(String trimmed) {
        if (trimmed.isEmpty() || trimmed.endsWith(";")) return false;
        if (trimmed.endsWith("{") || trimmed.equals("}") || trimmed.endsWith("};")) return false;
        if (trimmed.endsWith(":") || trimmed.endsWith(",")) return false;
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
        if (trimmed.startsWith("if ") || trimmed.startsWith("if(")
            || trimmed.startsWith("else") || trimmed.startsWith("for ")
            || trimmed.startsWith("while") || trimmed.startsWith("switch")
            || trimmed.startsWith("try ") || trimmed.startsWith("catch")) return false;
        if (trimmed.startsWith("/* template */") || trimmed.startsWith("@")) return false;
        if (trimmed.startsWith("public") || trimmed.startsWith("private") || trimmed.startsWith("protected")
            || trimmed.startsWith("static") || trimmed.startsWith("final")) return false;
        return true;
    }

    // ── Utility ──

    static String indentLine(String original, String newContent) {
        String ws = original.replaceFirst("^(\\s*).*", "$1");
        return ws + newContent;
    }
}
