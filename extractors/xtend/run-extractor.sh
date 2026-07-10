#!/bin/bash
# Run Xtend AST extractor — uses Maven shaded fat JAR
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Build if needed
if [ ! -f "$SCRIPT_DIR/target/xtend-ast-extractor-1.0.0.jar" ]; then
  cd "$SCRIPT_DIR" && /tmp/apache-maven-3.9.8/bin/mvn package -q -Dmaven.repo.local=/tmp/m2-repo
fi
exec java -jar "$SCRIPT_DIR/target/xtend-ast-extractor-1.0.0.jar" "$@"
