#!/bin/bash
# Run Xtend AST extractor — wraps javac + java with classpath deps
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
M2_REPO="$HOME/.m2/repository"
JDK_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
JAVAPARSER_JAR="$M2_REPO/com/github/javaparser/javaparser-core/3.26.4/javaparser-core-3.26.4.jar"
GSON_JAR="$M2_REPO/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar"
# Also include java extractor classes (CfgBuilder, IrClasses)
JAVA_CLASSES="$SCRIPT_DIR/../java/target/classes"
CP="$SCRIPT_DIR/target/classes:$JAVA_CLASSES:$JAVAPARSER_JAR:$GSON_JAR"
# Compile if needed
if [ ! -f "$SCRIPT_DIR/target/classes/com/codeparse/extractor/XtendAstExtractor.class" ]; then
  mkdir -p "$SCRIPT_DIR/target/classes"
  $JDK_HOME/bin/javac -cp "$CP" -d "$SCRIPT_DIR/target/classes" "$SCRIPT_DIR/src/main/java/com/codeparse/extractor/"*.java
fi
exec $JDK_HOME/bin/java -cp "$CP" com.codeparse.extractor.XtendAstExtractor "$@"
