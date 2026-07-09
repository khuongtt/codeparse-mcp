package com.codeparse.extractor;

import java.util.*;

/**
 * Shared IR data classes used by JavaAstExtractor, XtendAstExtractor, and CfgBuilder.
 * These mirror the JSON schema in src/ir/schemas/method-ir.schema.json.
 */
public class IrClasses {

    public static class IrFile {
        public String irVersion = "1.0";
        public String sourceLanguage = "java";
        public String filePath;
        public String packageName;
        public List<IrClass> classes = new ArrayList<>();
    }

    public static class IrClass {
        public String name, qualifiedName, kind;
        public Integer lineStart, lineEnd;
        public String visibility = "public";
        public boolean isAbstract = false;
        public String superclass;
        public List<String> interfaces = new ArrayList<>();
        public List<String> annotations = new ArrayList<>();
        public List<IrMethod> methods = new ArrayList<>();
    }

    public static class IrMethod {
        public String name, signature, returnType, visibility = "public";
        public Integer lineStart, lineEnd;
        public int cyclomaticComplexity = 1, branchCount = 0, conditionCount = 0;
        public boolean isStatic = false, isAbstract = false, isOverride = false;
        public List<String> annotations = new ArrayList<>();
        public List<Map<String, String>> parameters = new ArrayList<>();
        public List<IrDecision> decisions = new ArrayList<>();
        public IrCfg cfg;
        public List<Map<String, Object>> calls = new ArrayList<>();
    }

    public static class IrDecision {
        public String kind, expression, normalized, operator, parseStatus = "ok";
        public Integer lineStart, lineEnd;
        public int branchCount = 2;
        public boolean mcdcRequired = false;
        public List<IrCondition> conditions = new ArrayList<>();
    }

    public static class IrCondition {
        public int position;
        public String text, normalizedText, conditionType = "atomic", parseStatus = "ok";
    }

    public static class IrCfg {
        public List<Map<String, Object>> nodes = new ArrayList<>();
        public List<Map<String, Object>> edges = new ArrayList<>();
    }
}
