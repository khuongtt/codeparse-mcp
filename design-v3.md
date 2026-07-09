# Plan Update: AST Extractor → Normalized Decision IR → Graph DB → MCP Evidence

**Mục tiêu:** nâng cấp `codeparse core` từ mô hình parser/regex hiện tại sang pipeline deterministic, audit-friendly cho ISO 26262/ASIL-D:

```text
Source code Java/Xtend
  → Language-specific AST Extractor
  → Normalized Decision IR
  → Graph DB
  → MCP Evidence Tools
  → AI reads MCP only
  → UT Objective Matrix
  → JUnit Test Generation
```

---

## 1. Executive Summary

Hiện tại `codeparse` đã có nền tảng đủ tốt cho AI đọc MCP để generate UT ở mức method/class:

- `verify_mcdc_evidence`
- `get_mcdc`
- `get_mcdc_for_class`
- `get_decisions`
- `get_cfg`
- `get_method_context`
- `import_test_results`
- `export_evidence_plan`

Tuy nhiên parser hiện tại vẫn có một phần dựa trên regex/line-based traversal, đặc biệt ở Xtend. Điều này đã dẫn tới các miss case như:

```xtend
else if (...)
«IF ...»
return (0 < size) ? "[" + size + "]" : "";
```

Các lỗi `else_if` và `template_if` đã được xử lý ở mức hiện tại, nhưng case ternary cho thấy cần kiến trúc ổn định hơn: **AST extractor → normalized IR → DB → MCP**.

---

## 2. Scope Definition

### 2.1. Scope của `codeparse core`

`codeparse core` nên giữ vai trò deterministic extractor/evidence provider:

```text
parse source
build graph
extract CFG
extract decisions/conditions
compute/generate MC/DC pairs
verify evidence
expose MCP method/class context
import coverage/test results
export evidence
```

### 2.2. Không thuộc scope parser core

Các phần sau không nên nằm trong parser core:

```text
detect existing test file
manage UT generation queue
update status pending/generated/done
decide create/append/update test file
AI generation lifecycle tracking
```

Các phần đó nên thuộc **UT planner/orchestrator layer** riêng.

---

## 3. Target Architecture

```text
┌───────────────────────────┐
│ Java / Xtend source files │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Language AST Extractors   │
│ - Java AST extractor      │
│ - Xtend/Xtext extractor   │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Normalized Decision IR    │
│ JSON schema / validation  │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Graph DB Ingest           │
│ files/classes/methods     │
│ cfg/decisions/conditions  │
│ mcdc_pairs/call_edges     │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ MCP Evidence Layer        │
│ verify_mcdc_evidence      │
│ get_method_context        │
│ get_mcdc                  │
│ get_cfg                   │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ AI UT Generator           │
│ reads MCP only            │
│ creates objective matrix  │
│ generates JUnit tests     │
└───────────────────────────┘
```

---

## 4. Parser / AST Extractor Strategy

## 4.1. Java AST Extractor

### Recommended v1: JavaParser

Use JavaParser for a first production-grade Java AST extractor because it is lightweight and directly exposes Java AST nodes such as method declarations, statements, expressions, and conditional expressions.

JavaParser can parse Java source into an AST and supports analysis/manipulation/generation use cases. It also has symbol solver support if later needed for relationship/declaration resolution.

Target visitor coverage:

```text
CompilationUnit
ClassOrInterfaceDeclaration
ConstructorDeclaration
MethodDeclaration
IfStmt
ConditionalExpr
ForStmt
ForEachStmt
WhileStmt
DoStmt
SwitchStmt
CatchClause
ReturnStmt
MethodCallExpr
BinaryExpr
```

### Alternative v2: Spoon

Use Spoon if later requirements include deeper model-level analysis, transformation, or refactoring. Spoon builds a high-level Java model/AST and is designed for source code analysis/transformation.

### Alternative v3: Eclipse JDT ASTParser

Use Eclipse JDT if compiler-grade AST and binding resolution are required. JDT `ASTParser` can create ASTs from compilation units, expressions, statements, and body declarations.

### Java recommendation

```text
Short term: JavaParser extractor
Medium term: keep Spoon/JDT as optional advanced backend
```

---

## 4.2. Xtend AST Extractor

### Recommended: Xtext/Xtend standalone parser

Xtend should not rely on Java parser or regex long term because Xtend syntax includes:

```text
rich string templates: «IF ...», «ELSEIF ...», «FOR ...»
Xbase expressions
extension methods
dispatch methods
closures/lambdas
template expressions
multiline expressions
```

Use Xtext/Xtend standalone parsing to obtain an EMF/Xbase model, then traverse that model and emit normalized Decision IR.

Target coverage:

```text
Xtend class declarations
Xtend methods / def / override / dispatch
Xbase if expressions
Xbase for/while/switch/try/catch
rich string IF/ELSEIF/FOR
ternary or conditional expressions where present
method invocations
return expressions
```

### Xtend recommendation

```text
Short term: balanced scanner hotfix for urgent misses
Long term: Xtext/Xtend AST extractor
```

---

## 5. Normalized Decision IR

The normalized IR is the contract between language-specific extractors and graph DB ingest. Graph DB and MCP should not care whether the data came from JavaParser, Spoon, JDT, Xtext, or fallback parser.

### 5.1. IR top-level schema

```json
{
  "irVersion": "1.0",
  "sourceLanguage": "xtend",
  "filePath": "org.xtext.example.mydsl/src/org/xtext/example/mydsl/generator/CppContentBuilder.xtend",
  "packageName": "org.xtext.example.mydsl.generator",
  "classes": [
    {
      "name": "CppContentBuilder",
      "qualifiedName": "org.xtext.example.mydsl.generator.CppContentBuilder",
      "kind": "xtend_class",
      "lineStart": 1,
      "lineEnd": 200,
      "methods": []
    }
  ]
}
```

### 5.2. Method IR

```json
{
  "name": "getIncludes",
  "signature": "getIncludes():CharSequence",
  "returnType": "CharSequence",
  "visibility": "public",
  "lineStart": 100,
  "lineEnd": 160,
  "cyclomaticComplexity": 12,
  "branchCount": 22,
  "conditionCount": 14,
  "decisions": [],
  "cfg": {
    "nodes": [],
    "edges": []
  },
  "calls": []
}
```

### 5.3. Decision IR

```json
{
  "kind": "ternary",
  "expression": "0 < size",
  "normalized": "0 < size",
  "lineStart": 123,
  "lineEnd": 123,
  "branchCount": 2,
  "mcdcRequired": false,
  "parseStatus": "ok",
  "conditions": [
    {
      "position": 1,
      "text": "0 < size",
      "normalizedText": "0 < size",
      "conditionType": "atomic",
      "parseStatus": "ok"
    }
  ]
}
```

### 5.4. Required `decision.kind` values

```text
if
else_if
template_if
template_elseif
ternary
for
foreach
while
do_while
switch
case
catch
```

### 5.5. MC/DC rule

```text
mcdcRequired = true if conditions.length >= 2
mcdcRequired = false if conditions.length < 2
```

For example:

```java
return (a && b) ? x : y;
```

should produce:

```json
{
  "kind": "ternary",
  "expression": "a && b",
  "normalized": "C1 && C2",
  "branchCount": 2,
  "mcdcRequired": true,
  "conditions": [
    { "position": 1, "text": "a", "normalizedText": "a" },
    { "position": 2, "text": "b", "normalizedText": "b" }
  ]
}
```

---

## 6. Graph DB Mapping

Graph DB ingest should consume only normalized IR.

```text
IR file      → files
IR package   → packages
IR class     → classes
IR method    → methods
IR CFG node  → cfg_nodes
IR CFG edge  → cfg_edges
IR call      → call_edges
IR decision  → decisions
IR condition → conditions
MC/DC output → mcdc_pairs
```

### 6.1. Centralized MC/DC generation

Extractors should emit expressions and atomic conditions, but truth table and MC/DC pair generation should be centralized in graph ingest or a common IR utility.

```text
Extractor responsibility:
  find decision expressions
  find condition boundaries
  preserve source location

Common IR/DB responsibility:
  normalize boolean expression
  compute truth table
  compute MC/DC independence pairs
  insert decisions/conditions/mcdc_pairs
```

This avoids duplicated MC/DC logic across Java and Xtend extractors.

---

## 7. MCP Evidence Layer

MCP API should remain stable. AI should not know or care which parser/extractor produced the graph DB.

### Keep stable MCP tools

```text
verify_mcdc_evidence
get_method_context
get_mcdc
get_mcdc_for_class
get_cfg
get_decisions
codeparse_status
import_test_results
export_evidence_plan
```

### AI minimum workflow

```text
1. codeparse_status
2. verify_mcdc_evidence(methodId)
3. get_method_context(method_id)
4. generate UT objective matrix
5. generate JUnit tests
6. import test/coverage results
```

### Method context must continue to expose

```text
method
method.source
method.source_ref
state.fields_read
calls
cfg
decisions
mcdc_evidence_summary
coverage_requirements
parse_quality
```

---

## 8. Current Baseline to Freeze

Before modifying parser architecture, freeze current known-good baselines.

### 8.1. `CppContentBuilder.getIncludes`

```text
methodId                  = 115
decisionCount             = 11
branch_count              = 22
mcdcRequiredDecisionCount = 3
pairCount                 = 6
invalidPairCount          = 0
else_if_count             = 3
template_if_count         = 2
cfg_nodes                 = 42
cfg_edges                 = 52
```

### 8.2. Ternary return miss case

Source:

```xtend
return (0 < size) ? "[" + size + "]" : "";
```

Expected new decision:

```text
kind              = ternary
expression        = 0 < size
condition_count   = 1
mcdc_required     = false
branch_count      = +2
decisionCount     = +1
pairCount         = unchanged
```

### 8.3. Compound ternary case

Source:

```java
return (a && b) ? x : y;
```

Expected:

```text
kind              = ternary
expression        = a && b
condition_count   = 2
mcdc_required     = true
branch_count      = +2
pairCount         = +2
```

---

## 9. Implementation Phases

## Phase 0 — Freeze regression baseline

### Deliverables

```text
tests/parser-regression/getIncludes.expected.json
tests/parser-regression/ternary-return.expected.json
tests/parser-regression/compound-ternary.expected.json
```

### Acceptance

```text
Existing getIncludes baseline remains unchanged.
Ternary test initially fails with current parser, establishing regression target.
```

---

## Phase 1 — Define Decision IR schema

### Add files

```text
src/ir/decision-ir.schema.json
src/ir/decision-ir.js
src/ir/validate-ir.js
```

### Include validation rules

```text
irVersion is required
sourceLanguage is required
filePath is required
classes[].qualifiedName is required
methods[].name is required
decisions[].kind is required
decisions[].lineStart should exist when available
decisions[].branchCount >= 2 for branch decisions
conditions[].position starts at 1
mcdcRequired must match condition count unless explicitly overridden with reason
```

---

## Phase 2 — Refactor current parser output to IR

Current fallback parsers should emit the same IR shape.

```text
parseJava(source)  → Java Decision IR
parseXtend(source) → Xtend Decision IR
GraphBuilder       → ingest IR
```

This step should preserve current behavior and pass current MCP smoke tests.

### Acceptance

```text
getIncludes decisionCount remains 11
branch_count remains 22
verify_mcdc_evidence remains pass
get_method_context remains ok
```

---

## Phase 3 — Add ternary support to fallback parser

Even before full AST extractor, add balanced-scan ternary support as a short-term patch.

Support patterns:

```text
return condition ? a : b
val x = condition ? a : b
var x = condition ? a : b
assignment = condition ? a : b
```

### Acceptance

```text
return (0 < size) ? "[" + size + "]" : "";
```

must emit:

```text
kind = ternary
expression = 0 < size
branch_count += 2
decisionCount += 1
```

---

## Phase 4 — Java AST extractor POC

### Recommended implementation

```text
tools/java-ast-extractor/
  pom.xml
  src/main/java/.../JavaAstExtractor.java
```

### Traversal targets

```text
ClassOrInterfaceDeclaration
ConstructorDeclaration
MethodDeclaration
IfStmt
ConditionalExpr
ForStmt
ForEachStmt
WhileStmt
DoStmt
SwitchStmt
CatchClause
MethodCallExpr
ReturnStmt
```

### Output

```text
Decision IR JSON to stdout
```

### Acceptance

```text
Java files produce valid Decision IR.
Ternary expressions are detected as kind=ternary.
Compound ternary conditions produce MC/DC-required decisions.
Output can be ingested into graph DB.
```

---

## Phase 5 — Xtend/Xtext AST extractor POC

### Recommended implementation

```text
tools/xtend-ast-extractor/
  pom.xml
  src/main/java/.../XtendAstExtractor.java
```

### Parser foundation

Use Xtext/Xtend standalone setup to parse `.xtend` files and traverse EMF/Xbase model.

### Traversal targets

```text
Xtend class
Xtend method/def
Xbase if expression
Xbase loop/switch/try/catch expressions
rich string IF/ELSEIF/FOR
return expressions
conditional/ternary-like expressions when present
method invocations
```

### Acceptance

For `CppContentBuilder.xtend`:

```text
if detected
else_if detected
template_if detected
template_elseif detected if present
ternary return detected
method calls detected
Decision IR validates
DB ingest succeeds
MCP evidence remains consistent
```

---

## Phase 6 — GraphBuilder IR ingest

Add:

```text
src/graph/ir-ingest.js
```

### Responsibilities

```text
validate Decision IR
insert file/class/method
insert call edges
insert CFG nodes/edges
insert decisions
insert conditions
compute/insert MC/DC pairs
record parse quality/errors
```

### Fallback policy

```text
AST extractor success → use AST IR
AST extractor failure → fallback parser IR with parse_quality warning
```

---

## Phase 7 — MCP regression

Run full MCP regression after IR ingest.

### Required checks

```text
codeparse_status
verify_mcdc_evidence
get_mcdc(methodId=115)
get_method_context(method_id=115)
get_cfg(methodId=115)
get_mcdc_for_class(CppContentBuilder)
```

### Expected for `getIncludes`

```text
status = ok/pass
decisionCount = 11
branch_count = 22
pairCount = 6
cfg_nodes = 42
cfg_edges = 52
```

After ternary extractor is enabled for the target method containing ternary:

```text
decisionCount increases by 1
branch_count increases by 2
```

---

## 10. Repository Layout Proposal

```text
src/
  ir/
    decision-ir.schema.json
    decision-ir.js
    validate-ir.js
    normalize-decision.js

  parser/
    java-parser.js          # fallback/current
    xtend-parser.js         # fallback/current

  graph/
    builder.js
    ir-ingest.js

  mcp/
    server.js

extractors/
  java/
    pom.xml
    src/main/java/.../JavaAstExtractor.java

  xtend/
    pom.xml
    src/main/java/.../XtendAstExtractor.java

tests/
  parser-regression/
    getIncludes.expected.json
    ternary-return.expected.json
    compound-ternary.expected.json
```

---

## 11. Acceptance Criteria

### Parser/Extractor acceptance

```text
All supported methods produce valid Decision IR.
All if/else_if/template_if/template_elseif decisions are detected.
Ternary decisions are detected.
Compound boolean expressions are decomposed into atomic conditions.
branchCount is consistent with decisions.
MC/DC-required decisions have pairs.
```

### DB acceptance

```text
classes/methods inserted correctly
cfg_nodes/cfg_edges inserted correctly
decisions/conditions inserted correctly
mcdc_pairs generated correctly
no invalid pairs
```

### MCP acceptance

```text
verify_mcdc_evidence = pass
get_mcdc returns normalized decisions/pairs
get_method_context returns source/cfg/decisions/coverage_requirements
AI can generate UT using MCP only
```

### Audit acceptance

```text
Each generated test can map to:
method_id
decision_uid
condition_uid
pair_uid when MC/DC applies
coverage objective
execution result
coverage result
```

---

## 12. Risks and Mitigations

### Risk: Xtend AST setup complexity

Mitigation:

```text
Start with standalone extractor POC on one file.
Keep current parser as fallback.
Emit parse_quality warning when fallback is used.
```

### Risk: JavaParser/Spoon output differs from current DB baseline

Mitigation:

```text
Freeze regression JSON before migration.
Compare old parser IR vs AST extractor IR.
Only switch default after parity acceptance.
```

### Risk: MC/DC pair generation duplicated across extractors

Mitigation:

```text
Extractor emits decisions/conditions only.
Central IR ingest computes truth table and MC/DC pairs.
```

### Risk: AI reads raw source instead of MCP

Mitigation:

```text
Agent prompt must enforce MCP-only reads.
get_method_context remains the primary context pack.
```

---

## 13. Final Recommended Roadmap

```text
M0: Freeze current baseline and regression cases.
M1: Define Decision IR schema.
M2: Refactor existing parsers to emit IR.
M3: Add ternary support to fallback parser.
M4: Implement JavaParser extractor POC.
M5: Implement Xtend/Xtext extractor POC.
M6: Implement GraphBuilder IR ingest.
M7: Run MCP regression and evidence validation.
M8: Update AI agent prompt to enforce MCP-only generation.
M9: Use MCP evidence to generate UT objective matrix and JUnit tests.
```

---



---

---

## 14. Summary

The target architecture remains:

```text
AST extractor
  -> normalized Decision IR
  -> graph DB
  -> MCP evidence
  -> AI reads MCP only
  -> UT objective matrix
  -> JUnit generation
```

This keeps `codeparse core` deterministic and audit-friendly while avoiding regex-based misses such as ternary return decisions. Parser implementations can evolve behind the IR boundary without changing MCP contracts or AI workflows.


---

## 15. IR Size and Context Management Rules

This section defines mandatory rules for keeping the AST extractor / IR / MCP / AI pipeline scalable and safe for large modules.

### 15.1. Core rules

- **Full IR is not an AI input.** The AI agent must not read or request full module-level IR JSON for unit test generation.
- **Full IR is extractor-to-DB ingest input.** Full IR exists as a deterministic machine-to-machine contract between the AST extractor and Graph DB ingest.
- **MCP exposes filtered method-level context only.** AI generation must consume scoped MCP views such as `get_method_context(method_id)`, `get_mcdc(methodId)`, `get_cfg(methodId)`, and `verify_mcdc_evidence(methodId)`.
- **Large IR must be split by method.** Module-level or file-level IR must be indexed through a manifest and split into per-method IR chunks for ingestion, regression, and debugging.
- **MCP responses must support summary, truncation, and pagination.** Large MCP responses must return summaries first, mark partial/truncated responses explicitly, and provide follow-up calls for detailed data.
- **AI must not request full module IR for UT generation.** The UT generation workflow must remain method-scoped or small batch-scoped.

### 15.2. Correct data flow

```text
AST Extractor
  -> full IR / streamed IR / per-method IR
  -> Graph DB ingest
  -> MCP scoped evidence views
  -> AI method-level UT generation
```

AI-visible path:

```text
verify_mcdc_evidence(methodId)
get_method_context(method_id)
optional get_mcdc(methodId)
optional get_cfg(methodId)
```

AI-invisible path:

```text
full module IR
full file IR
large intermediate extractor JSON
raw extractor debug dump
```

### 15.3. AI agent rule

```text
Never ask for full module IR.
Never read raw full IR files for UT generation.
Always ask MCP for scoped method evidence.
Generate tests method-by-method.
```

This keeps token usage bounded and preserves the intended architecture:

```text
Full IR = deterministic ingestion artifact
MCP = filtered evidence API
AI = consumer of scoped evidence only
```


---

## 16. IR JSON Template Files

The detailed IR JSON structures are intentionally **not embedded in this plan document**. They are maintained as separate template/schema files so the plan stays readable and the JSON contracts can be versioned, validated, and reused by extractor/ingest tests.

### 16.1. Template artifact set

Use these separate files:

```text
ir-manifest.template.json
file-ir.template.json
method-ir.template.json
method-ir.schema.json
```

Recommended repository layout:

```text
src/
  ir/
    schemas/
      method-ir.schema.json
    templates/
      ir-manifest.template.json
      file-ir.template.json
      method-ir.template.json

.codeparse/
  ir/
    manifest.json
    files/
      CppContentBuilder.ir.json
    methods/
      org.xtext.example.mydsl.generator.CppContentBuilder.getIncludes.ir.json
```

### 16.2. Artifact responsibilities

#### `ir-manifest.template.json`

Project/module/file-level index and summary. It should contain only compact metadata such as file count, method count, decision count, branch count, MC/DC pair count, parse error count, and references to file/method IR artifacts.

#### `file-ir.template.json`

File-level debug and review artifact. It should contain file metadata, extractor metadata, package/class list, and references to per-method IR. It should not duplicate full method-level decision payloads when `method-ir` files exist.

#### `method-ir.template.json`

Primary unit of IR ingestion, parser regression, and method-level evidence validation. It should contain one method's metadata, state usage, calls, CFG, decisions, conditions, MC/DC pair candidates or persisted pairs, evidence summary, and parse quality.

#### `method-ir.schema.json`

JSON Schema validation contract for method-level IR. It should enforce required fields, valid `sourceLanguage`, valid `decision.kind`, method identity, line ranges, branch count constraints, decision/condition structure, and evidence summary presence.

### 16.3. Naming convention

```text
manifest:
  .codeparse/ir/manifest.json

file IR:
  .codeparse/ir/files/<SourceFileBaseName>.ir.json

method IR:
  .codeparse/ir/methods/<classQualifiedName>.<methodName>.ir.json

schema:
  src/ir/schemas/method-ir.schema.json
```

Example:

```text
.codeparse/ir/methods/org.xtext.example.mydsl.generator.CppContentBuilder.getIncludes.ir.json
```

### 16.4. Operational rule

```text
Extractor may emit full IR.
GraphBuilder may consume full IR or streamed IR.
Graph DB stores normalized evidence.
MCP returns filtered method-level views.
AI never reads full IR for UT generation.
```

Detailed template files are maintained separately in the IR template bundle.


---

## 17. Where IR Files Sit in the Flow

This section clarifies the exact position of IR files in the `codeparse` architecture when the user input is a source file that needs unit tests.

### 17.1. Final flow position

IR files are **intermediate generated artifacts** between the language-specific AST extractor and Graph DB ingest.

```text
Source file (.java / .xtend)
  -> AST Extractor
  -> IR files under .codeparse/ir/
  -> GraphBuilder / IR ingest
  -> .codeparse/graph.db
  -> MCP evidence tools
  -> AI reads MCP responses
  -> UT objective matrix
  -> JUnit test generation
```

The important boundary is:

```text
IR files are machine-ingest artifacts.
MCP responses are AI-facing evidence views.
```

### 17.2. Recommended IR artifact location

Recommended generated artifact layout:

```text
.codeparse/
  graph.db
  ir/
    manifest.json
    files/
      CppContentBuilder.ir.json
    methods/
      org.xtext.example.mydsl.generator.CppContentBuilder.getIncludes.ir.json
      org.xtext.example.mydsl.generator.CppContentBuilder.classifyGenerationWindow.ir.json
```

Alternative layout for local debugging:

```text
.ir/
  manifest.json
  files/
    CppContentBuilder.ir.json
  methods/
    org.xtext.example.mydsl.generator.CppContentBuilder.getIncludes.ir.json
```

Default recommendation:

```text
Use .codeparse/ir/ for generated production artifacts.
Use .ir/ only for temporary debug or exported review bundles.
```

### 17.3. Flow when the input is a source file

Example user input:

```text
org.xtext.example.mydsl.parent/org.xtext.example.mydsl/src/org/xtext/example/mydsl/generator/CppContentBuilder.xtend
```

Core extraction flow:

```text
CppContentBuilder.xtend
  -> Xtend/Xtext AST extractor
  -> .codeparse/ir/files/CppContentBuilder.ir.json
  -> .codeparse/ir/methods/org.xtext.example.mydsl.generator.CppContentBuilder.getIncludes.ir.json
  -> GraphBuilder ingest
  -> .codeparse/graph.db
```

AI generation flow:

```text
AI does not read .codeparse/ir/*.json.
AI calls MCP tools:
  - codeparse_status
  - search_classes / get_file_context when available
  - get_methods
  - get_mcdc_for_class
  - verify_mcdc_evidence(methodId)
  - get_method_context(method_id)
  - optional get_mcdc(methodId)
  - optional get_cfg(methodId)
```

### 17.4. Responsibilities by layer

```text
AST Extractor:
  Parses source using language-specific parser.
  Emits full, file-level, and method-level IR artifacts.

IR Files:
  Provide deterministic extractor-to-DB contract.
  Provide regression fixtures for parser/extractor behavior.
  Provide debug/review artifacts for developers.

GraphBuilder / IR Ingest:
  Reads IR artifacts.
  Inserts file/class/method/cfg/decision/condition data.
  Computes or persists MC/DC pairs.
  Writes normalized graph evidence to graph.db.

Graph DB:
  Stores normalized source graph and evidence.

MCP Evidence Layer:
  Exposes filtered, method-level, bounded context.
  Hides full IR from AI.

AI Agent:
  Reads MCP evidence only.
  Generates UT objective matrix.
  Writes or patches JUnit test files.
```

### 17.5. Hard rule

```text
Never place full IR in the AI prompt.
Never ask the AI agent to read full IR files for UT generation.
Always ingest IR into graph.db first, then expose bounded MCP evidence views.
```

### 17.6. Why this matters

This separation prevents large-context failures and keeps the architecture audit-friendly:

```text
Full IR can be large and machine-oriented.
Graph DB stores normalized deterministic evidence.
MCP provides small, scoped context packs.
AI remains a consumer of verified evidence, not a parser.
```