package com.codeparse.extractor;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/**
 * JavaParser-based AST extractor that emits Decision IR JSON.
 * CLI: java -jar java-ast-extractor.jar <file.java>
 */
public class JavaAstExtractor {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("Usage: java-ast-extractor <file.java>");
            System.exit(1);
        }
        Path path = Path.of(args[0]);
        if (!Files.exists(path)) {
            System.err.println("File not found: " + args[0]);
            System.exit(1);
        }

        CompilationUnit cu = StaticJavaParser.parse(path);

        JavaAstExtractor ext = new JavaAstExtractor();
        IrClasses.IrFile ir = ext.extract(cu, path.toString());

        Gson gson = new GsonBuilder().setPrettyPrinting().serializeNulls().create();
        System.out.println(gson.toJson(ir));
    }

    IrClasses.IrFile extract(CompilationUnit cu, String filePath) {
        IrClasses.IrFile ir = new IrClasses.IrFile();
        ir.filePath = filePath;
        cu.getPackageDeclaration().ifPresent(pd -> ir.packageName = pd.getNameAsString());

        cu.findAll(ClassOrInterfaceDeclaration.class).forEach(cld -> {
            ir.classes.add(extractClass(cld, ir.packageName));
        });
        cu.findAll(EnumDeclaration.class).forEach(ed -> {
            ir.classes.add(extractEnum(ed, ir.packageName));
        });

        return ir;
    }

    IrClasses.IrClass extractClass(ClassOrInterfaceDeclaration cld, String pkg) {
        IrClasses.IrClass cls = new IrClasses.IrClass();
        cls.name = cld.getNameAsString();
        cls.qualifiedName = (pkg != null ? pkg + "." : "") + cls.name;
        cls.kind = cld.isInterface() ? "interface" : "class";
        cls.lineStart = cld.getBegin().map(p -> p.line).orElse(null);
        cls.lineEnd = cld.getEnd().map(p -> p.line).orElse(null);
        cls.isAbstract = cld.isAbstract();
        cls.superclass = cld.getExtendedTypes().isEmpty() ? null : cld.getExtendedTypes().get(0).getNameAsString();
        cld.getImplementedTypes().forEach(it -> cls.interfaces.add(it.getNameAsString()));
        cld.getAnnotations().forEach(a -> cls.annotations.add(a.getNameAsString()));
        if (cld.isPublic()) cls.visibility = "public";
        else if (cld.isProtected()) cls.visibility = "protected";
        else if (cld.isPrivate()) cls.visibility = "private";

        cld.getMethods().forEach(md -> cls.methods.add(extractMethod(md, cls.qualifiedName)));
        return cls;
    }

    IrClasses.IrClass extractEnum(EnumDeclaration ed, String pkg) {
        IrClasses.IrClass cls = new IrClasses.IrClass();
        cls.name = ed.getNameAsString();
        cls.qualifiedName = (pkg != null ? pkg + "." : "") + cls.name;
        cls.kind = "enum";
        cls.lineStart = ed.getBegin().map(p -> p.line).orElse(null);
        cls.lineEnd = ed.getEnd().map(p -> p.line).orElse(null);
        ed.getAnnotations().forEach(a -> cls.annotations.add(a.getNameAsString()));
        ed.getMethods().forEach(md -> cls.methods.add(extractMethod(md, cls.qualifiedName)));
        return cls;
    }

    IrClasses.IrMethod extractMethod(MethodDeclaration md, String classQName) {
        IrClasses.IrMethod m = new IrClasses.IrMethod();
        m.name = md.getNameAsString();
        m.returnType = md.getType().toString();
        StringBuilder sig = new StringBuilder(m.name + "(");
        for (int i = 0; i < md.getParameters().size(); i++) {
            if (i > 0) sig.append(",");
            sig.append(md.getParameter(i).getType().toString());
        }
        sig.append(")");
        if (!md.getType().isVoidType()) sig.append(":").append(md.getType().toString());
        m.signature = sig.toString();
        m.lineStart = md.getBegin().map(p -> p.line).orElse(null);
        m.lineEnd = md.getEnd().map(p -> p.line).orElse(null);
        m.isStatic = md.isStatic();
        m.isAbstract = md.isAbstract();
        m.isOverride = md.getAnnotations().stream().anyMatch(a -> a.getNameAsString().equals("Override"));
        if (md.isPublic()) m.visibility = "public";
        else if (md.isProtected()) m.visibility = "protected";
        else if (md.isPrivate()) m.visibility = "private";
        else m.visibility = "package";
        md.getAnnotations().forEach(a -> m.annotations.add(a.getNameAsString()));
        md.getParameters().forEach(p -> {
            Map<String, String> pm = new HashMap<>();
            pm.put("name", p.getNameAsString());
            pm.put("type", p.getType().toString());
            m.parameters.add(pm);
        });

        md.getBody().ifPresent(body -> {
            CfgBuilder cfgBuilder = new CfgBuilder();
            cfgBuilder.visit(body);
            m.decisions = cfgBuilder.decisions;
            m.branchCount = cfgBuilder.branchCount;
            m.conditionCount = cfgBuilder.conditionCount;
            m.cyclomaticComplexity = cfgBuilder.cyclomaticComplexity;
            m.cfg = cfgBuilder.buildCfg();
            m.calls = cfgBuilder.calls;
        });

        return m;
    }
}
