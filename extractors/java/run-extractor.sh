#!/bin/bash
# Run Java AST extractor — wraps javac + java with classpath deps
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CP="$SCRIPT_DIR/target/classes:/tmp/javaparser-lib/javaparser-core-3.25.10.jar:/tmp/javaparser-lib/gson-2.10.1.jar"
# Compile if needed
if [ ! -f "$SCRIPT_DIR/target/classes/com/codeparse/extractor/JavaAstExtractor.class" ]; then
  /tmp/jdk-17.0.13+11/bin/javac -cp "$CP" -d "$SCRIPT_DIR/target/classes" "$SCRIPT_DIR/src/main/java/com/codeparse/extractor/"*.java
fi
exec /tmp/jdk-17.0.13+11/bin/java -cp "$CP" com.codeparse.extractor.JavaAstExtractor "$@"
