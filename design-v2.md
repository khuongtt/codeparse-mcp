# Codeparse-MCP Version Update Plan
**Project:** `codeparse-mcp`  **Current baseline:** v1 README – Java/Xtend Code Parser → Graph DB → MCP Server  **Target direction:** Java/Xtend parser + deterministic graph DB + MCP context provider for AI-assisted ISO 26262 ASIL-D unit test generation and MC/DC evidence preparation.
---
## 1. Executive Summary
`codeparse-mcp` v1 đã có nền tảng tốt:
- CLI: `init`, `sync`, `status`, `sync-file`, `serve`.- SQLite graph DB.- Java/Xtend parser.- CFG, call graph, dependency graph.- MCP server cho GitHub Copilot, Claude Desktop và MCP clients khác.- Prompt workflows cho unit test generation và review.- Incremental sync dựa trên SHA-256.
Tuy nhiên, từ lỗi thực tế khi AI gọi MCP:
```textThe methods data is also in a file.Since I can't easily access those large JSON files through the tools available...Actually, I should just read the .xtend file from disk...But I don't have a direct file read tool available.```
Có thể kết luận vấn đề chính không phải AI yếu, mà là **MCP interface hiện tại chưa trả context đúng dạng để AI sử dụng**.
Tool cần được nâng cấp từ:
```textParser + raw graph query```
thành:
```textParser + graph DB + parser quality gate + task-centric MCP context + UT/MC/DC evidence workflow```
---
## 2. Nguyên tắc thiết kế cho version mới
### 2.1. Không rewrite toàn bộ
Không nên viết lại từ đầu. Nên tận dụng v1 hiện có:
- CLI wrapper.- SQLite DB.- Parser pipeline.- MCP server.- Existing tools như `get_methods`, `get_cfg`, `get_mcdc`, `get_ut_context`.- Prompt workflows trong `.github/prompts/` và `.vscode/*.agent.md`.
Version mới nên update theo hướng incremental.
---
### 2.2. MCP phải task-centric, không DB-centric
Hiện tại MCP trả data kiểu:
```json[  {    "id": 7397,    "name": "getIncludes",    "line_start": 422,    "line_end": 467,    "booleanConditions": [      "item.contains("&lt;"",      "!p1List.empty && !p2List.empty"    ]  }]```
Data này giúp biết method nào tồn tại, nhưng không đủ để AI viết UT hoặc lập MC/DC evidence.
MCP mới phải trả:
```textClass summary → Method context → Decisions → MC/DC plan → UT context pack```
AI không được tự đọc JSON lớn hoặc tự dựng absolute path.
---
### 2.3. Parser/graph là source of truth, AI chỉ hỗ trợ
AI không nên tự quyết định:
- Condition nào tồn tại.- Decision nào cần MC/DC.- MC/DC đã pass hay chưa.- Coverage đã đạt hay chưa.
AI chỉ nên hỗ trợ:
- Viết JUnit skeleton.- Đề xuất input combinations.- Giải thích coverage gap.- Tạo remediation plan.
Final acceptance phải dựa trên:
- Parser output đã validate.- JUnit execution result.- JaCoCo coverage evidence.- MC/DC matrix.- Human technical review.- Process/safety review.
---
## 3. Các vấn đề v1 cần xử lý
| Nhóm | Vấn đề hiện tại | Hậu quả | Hướng xử lý ||---|---|---|---|| MCP contract | `get_methods` trả method summary nhưng thiếu source body | AI không đủ context viết UT | Thêm `get_method_context` || Source access | Có `file_id`, `line_start`, `line_end` nhưng thiếu `file_path` hoặc source snippet | AI tự đoán absolute path | Join `files` table, trả `file.path` và source snippet || Large JSON | AI nhận hoặc được trỏ tới JSON lớn | Agent không đọc được hoặc tốn token | Thêm `get_ut_context_pack` có token budget || Data shape | Có field duplicate `throws_list`/`throwsList`, `boolean_conditions`/`booleanConditions` | Agent dùng sai field | Chuẩn hóa `snake_case` || Serialization | `boolean_conditions` là string JSON | Khó parse, dễ lỗi | Trả array JSON thật || Encoding | Expression chứa `&lt;`, `&gt;` | Sinh test sai | Decode HTML entity || Parser correctness | Condition bị cắt cụt như `Util.isNotNullOrBlank(type.headed` | MC/DC sai | Expression validator || Decision model | Condition bị flatten theo method | Không biết condition thuộc decision nào | Thêm bảng `decisions` và `conditions` || Compound condition | `!p1List.empty && !p2List.empty` chưa tách atomic | Không đủ MC/DC | Condition decomposer || Duplicate condition | `build()` có `isHeader`, `isHeader` | Mất decision identity | Decision-level UID || Xtend template | `branch_count > 0` nhưng `condition_count = 0` | Parser miss `«IF»` | Xtend rich string parser || Evidence | Chưa có evidence lifecycle | Chưa audit-ready | Evidence exporter + review workflow |
---
## 4. Target Architecture
```textJava/Xtend Sources       │       ▼Parser Layer  ├─ Java CST Parser  ├─ Xtend Parser  ├─ Xtend Rich String / Template Parser  └─ Generated Source Mapper       │       ▼Normalization + Parser Quality Gates  ├─ HTML entity decoder  ├─ balanced expression checker  ├─ compound condition decomposer  ├─ branch/condition consistency checker  └─ parser warning classifier       │       ▼SQLite Graph DB  ├─ files/classes/methods/fields  ├─ cfg_nodes/cfg_edges  ├─ decisions/conditions  ├─ call_edges/dependencies  ├─ mcdc_pairs  ├─ test_cases/test_results  └─ coverage/review/evidence       │       ▼MCP Server  ├─ lifecycle tools  ├─ class/method query tools  ├─ source/context tools  ├─ CFG/MC/DC tools  ├─ UT context pack tools  └─ evidence tools       │       ▼AI Agent / GitHub Copilot / Claude       │       ▼JUnit + Coverage + Evidence Package```
---
## 5. Proposed Roadmap
```textv1.1.0  Clean MCP data contractv1.2.0  Add method source/context APIv1.3.0  Add parser quality gatesv2.0.0  Add decision/condition graph modelv2.1.0  Add Xtend rich string/template parserv2.2.0  Add MC/DC planner v2v2.3.0  Add UT context pack v2v2.4.0  Add JUnit/JaCoCo result importv2.5.0  Add ISO evidence export package```
Recommended next build:
```textBuild v1.2.0 first```
Reason: v1.2.0 xử lý trực tiếp lỗi AI đang gặp: không đọc được JSON lớn, không đọc được source file, phải tự đoán path.
---
# Phase A — Stabilize v1
## 6. v1.1.0 — MCP Contract Cleanup
### 6.1. Goal
Làm sạch output MCP để AI dễ sử dụng và không bị sai context.
### 6.2. Scope
- Chuẩn hóa field naming về `snake_case`.- Bỏ duplicate fields:  - bỏ `throwsList`, giữ `throws_list`.  - bỏ `booleanConditions`, giữ `boolean_conditions`.- Không serialize array thành string.- Decode HTML entity:  - `&lt;` → `<`  - `&gt;` → `>`  - `&amp;` → `&`  - `&quot;` → `"`- Join `files` table để mọi method có `file.path`.- Thêm `parse_quality` vào method/condition.- Thêm `recommended_next_actions`.
### 6.3. Current Output Problem
```json{  "file_id": 423,  "boolean_conditions": "["index &gt;= 0"]",  "booleanConditions": [    "index &gt;= 0"  ]}```
### 6.4. Target Output
```json{  "file": {    "id": 423,    "path": "src/org/xtext/example/mydsl/generator/CppContentBuilder.xtend",    "language": "xtend"  },  "boolean_conditions": [    "index >= 0"  ],  "parse_quality": {    "status": "ok",    "warnings": []  },  "recommended_next_actions": [    {      "tool": "get_method_context",      "input": {        "method_id": 7394      }    }  ]}```
### 6.5. Acceptance Criteria
- Không còn `&lt;`, `&gt;` trong MCP output.- Không còn duplicate field camelCase/snake_case.- `boolean_conditions` luôn là JSON array thật.- Method nào cũng có `file.path`.- Response có `recommended_next_actions`.- Existing clients vẫn chạy được nếu compatibility mode bật.
---
## 7. v1.2.0 — Method Source Context API
### 7.1. Goal
Xử lý lỗi AI không có direct file read tool.
MCP server phải tự đọc source file dựa trên:
```textfile.path + line_start + line_end```
AI chỉ gọi tool và nhận source snippet.
---
### 7.2. New MCP Tool: `get_method_context`
Input:
```json{  "method_id": 7397,  "include_source": true,  "include_fields": true,  "include_calls": true,  "include_decisions": true}```
Output:
```json{  "status": "ok",  "method": {    "id": 7397,    "class_name": "CppContentBuilder",    "name": "getIncludes",    "signature": "getIncludes():CharSequence",    "source_ref": {      "file": "src/org/xtext/example/mydsl/generator/CppContentBuilder.xtend",      "line_start": 422,      "line_end": 467    },    "source": "def getIncludes() ..."  },  "state": {    "fields_read": [      "includes"    ],    "fields_written": []  },  "calls": [],  "parse_quality": {    "status": "ok",    "warnings": []  }}```
---
### 7.3. Security Requirements
- Chỉ đọc file trong configured `projectRoot`.- Reject path traversal như `../../`.- Không expose file ngoài workspace.- Có giới hạn:  - `max_source_lines_per_method`, ví dụ 300 lines.  - `max_context_tokens`, ví dụ 1800 tokens.- Nếu vượt budget:
```json{  "status": "partial",  "truncated": true,  "reason": "TOKEN_BUDGET_EXCEEDED",  "recommended_next_actions": [    {      "tool": "get_method_context",      "input": {        "method_id": 7397,        "include_source": true,        "source_range": "focused"      }    }  ]}```
---
### 7.4. Acceptance Criteria
- AI lấy được method body bằng `method_id`.- Không cần dựng absolute path.- MCP không trả path JSON lớn.- Có source snippet trong response.- Có `source_ref` để trace evidence.- Có `status: partial` nếu bị truncate.
---
## 8. v1.3.0 — Parser Quality Gates
### 8.1. Goal
Không đưa parser output lỗi vào MC/DC hoặc UT context.
---
### 8.2. Quality Checks
Các lỗi cần detect:
```textHTML_ENTITY_DETECTEDUNBALANCED_PARENTHESISUNBALANCED_QUOTEPOSSIBLY_TRUNCATED_EXPRESSIONBRANCH_WITHOUT_EXTRACTED_CONDITIONDUPLICATE_CONDITION_WITHOUT_DECISIONCOMPOUND_CONDITION_NOT_DECOMPOSEDXTEND_TEMPLATE_BRANCH_NOT_PARSED```
---
### 8.3. Example Error Handling
Input lỗi:
```json{  "text": "Util.isNotNullOrBlank(type.headed"}```
Output mới:
```json{  "text": "Util.isNotNullOrBlank(type.headed",  "parse_status": "error",  "warnings": [    "UNBALANCED_PARENTHESIS",    "POSSIBLY_TRUNCATED_EXPRESSION"  ],  "mcdc_eligible": false}```
---
### 8.4. CLI Command
```bashcodeparse validate --report reports/parser-quality.json```
---
### 8.5. Acceptance Criteria
- Parser issue có report riêng.- Expression lỗi không được dùng trong `get_mcdc`.- Nếu `branch_count > 0` nhưng `condition_count = 0`, phải có warning.- `codeparse status --errors` hiển thị parser warnings/errors.- UT context pack phải ghi rõ parse warning nếu có.
---
# Phase B — MC/DC Correctness Model
## 9. v2.0.0 — Decision/Condition Graph Model
### 9.1. Goal
Chuyển từ model:
```textmethod.booleanConditions[]```
sang model:
```textmethod → decisions → atomic conditions```
Đây là thay đổi quan trọng nhất để hỗ trợ MC/DC đúng cách.
---
### 9.2. New Tables
```sqlCREATE TABLE decisions (  id INTEGER PRIMARY KEY,  method_id INTEGER NOT NULL,  decision_uid TEXT NOT NULL,  kind TEXT,  line_start INTEGER,  line_end INTEGER,  expression TEXT,  normalized_expression TEXT,  operator TEXT,  branch_count INTEGER,  parse_status TEXT,  mcdc_required INTEGER DEFAULT 0,  FOREIGN KEY(method_id) REFERENCES methods(id) ON DELETE CASCADE);
CREATE TABLE conditions (  id INTEGER PRIMARY KEY,  decision_id INTEGER NOT NULL,  condition_uid TEXT NOT NULL,  text TEXT,  normalized_text TEXT,  position INTEGER,  condition_type TEXT,  parse_status TEXT,  FOREIGN KEY(decision_id) REFERENCES decisions(id) ON DELETE CASCADE);```
---
### 9.3. New MCP Tool: `get_decisions`
Input:
```json{  "method_id": 7397}```
Output:
```json{  "status": "ok",  "method_id": 7397,  "decisions": [    {      "decision_id": "D-7397-007",      "line": 458,      "kind": "if",      "expression": "!p1List.empty && !p2List.empty",      "normalized_expression": "C1 && C2",      "conditions": [        {          "condition_id": "C1",          "text": "!p1List.empty",          "parse_status": "ok"        },        {          "condition_id": "C2",          "text": "!p2List.empty",          "parse_status": "ok"        }      ],      "mcdc_required": true,      "parse_status": "ok"    }  ]}```
---
### 9.4. Rules
- Mỗi `if`, `while`, `for`, `switch`, ternary, boolean return, boolean assignment là một `decision`.- Mỗi atomic boolean expression là một `condition`.- Duplicate condition ở nhiều vị trí phải có `decision_uid` khác nhau.- Compound expression phải được decomposed:
```text!p1List.empty && !p2List.empty```
thành:
```textC1 = !p1List.emptyC2 = !p2List.empty```
---
### 9.5. Acceptance Criteria
- `build()` có 2 decision riêng nếu `isHeader` xuất hiện 2 lần.- Compound condition được tách atomic.- MC/DC chỉ chạy trên `decision.mcdc_required = true`.- `methods.condition_count` tính từ bảng `conditions`, không từ regex flat list.- `get_methods` có thể vẫn trả summary, nhưng không dùng làm nguồn MC/DC chính.
---
## 10. v2.1.0 — Xtend Rich String / Template Parser
### 10.1. Goal
Fix parser miss branch trong Xtend generator.
Xtend generator thường chứa logic trong rich string:
```xtend«IF condition»...«ELSE»...«ENDIF»```
Pattern parser v1 dễ miss loại branch này.
---
### 10.2. Required Syntax Support
```xtend«IF condition»«ELSE»«ENDIF»
«FOR item : items»«ENDFOR»
«IF !p1List.empty && !p2List.empty»...«ENDIF»```
---
### 10.3. New Decision Kinds
```texttemplate_iftemplate_fortemplate_switch```
---
### 10.4. Acceptance Criteria
- Condition trong `«IF ...»` được extract.- `getNamespace()` nếu có template IF thì không còn `branch_count > 0` nhưng `condition_count = 0`.- Source line trace về `.xtend`.- Template block không balanced thì parser warning.- Rich string decision được đưa vào `decisions` table.
---
## 11. v2.2.0 — MC/DC Planner v2
### 11.1. Goal
`get_mcdc` phải trả MC/DC plan theo decision, không chỉ condition list.
---
### 11.2. New Table: `mcdc_pairs`
```sqlCREATE TABLE mcdc_pairs (  id INTEGER PRIMARY KEY,  decision_id INTEGER NOT NULL,  condition_id INTEGER NOT NULL,  pair_uid TEXT,  test_vector_a TEXT,  test_vector_b TEXT,  outcome_a INTEGER,  outcome_b INTEGER,  independence_status TEXT,  review_status TEXT DEFAULT 'draft',  FOREIGN KEY(decision_id) REFERENCES decisions(id) ON DELETE CASCADE,  FOREIGN KEY(condition_id) REFERENCES conditions(id) ON DELETE CASCADE);```
---
### 11.3. Target `get_mcdc` Output
```json{  "status": "ok",  "method_id": 7397,  "decisions": [    {      "decision_id": "D-7397-007",      "expression": "C1 && C2",      "conditions": [        {          "condition_id": "C1",          "text": "!p1List.empty"        },        {          "condition_id": "C2",          "text": "!p2List.empty"        }      ],      "suggested_pairs": [        {          "proves_condition": "C1",          "test_a": {            "C1": true,            "C2": true,            "decision": true          },          "test_b": {            "C1": false,            "C2": true,            "decision": false          },          "status": "suggested_requires_review"        }      ]    }  ]}```
---
### 11.4. Important Rule
Tool chỉ tạo **draft MC/DC plan**.
Không claim final MC/DC pass nếu chưa có:
- Test method mapping.- JUnit execution result.- Reviewer approval.- Evidence matrix.
---
## 12. v2.3.0 — UT Context Pack v2
### 12.1. Goal
Thay vì để AI dùng raw `get_methods`, `get_cfg`, `get_mcdc` riêng lẻ, cung cấp một context pack compact, đúng budget, chuyên cho UT generation.
---
### 12.2. Backward Compatibility
Giữ tool cũ:
```textget_ut_context```
Thêm tool mới:
```textget_ut_context_pack```
---
### 12.3. Input
```json{  "qualified_name": "org.xtext.example.mydsl.generator.CppContentBuilder",  "method_id": 7397,  "token_budget": 1800,  "include_source": true,  "include_mcdc": true,  "include_cfg": "summary",  "include_callees": true}```
---
### 12.4. Output
```markdown# UT Context Pack
## TargetClass: CppContentBuilderMethod: getIncludes():CharSequenceSource: src/.../CppContentBuilder.xtend:422-467
## Source```xtend...```
## State Used- includes
## DecisionsD-7397-001: item.contains("<")D-7397-007: !p1List.empty && !p2List.empty  - C1: !p1List.empty  - C2: !p2List.empty
## MC/DC Targets- D-7397-007: prove C1, C2 independence
## Test Guidance- Use JUnit 5- Assert generated CharSequence content- Cover normal include, angle-bracket include, quoted include, duplicate include- Do not claim MC/DC pass until execution and review```
---
### 12.5. Acceptance Criteria
- Context pack không vượt `token_budget`.- Nếu thiếu source/decision thì trả `status: partial`.- AI không cần gọi raw `get_methods` để viết UT.- `get_ut_context` cũ có thể gọi nội bộ sang `get_ut_context_pack`.- Prompt workflow phải ưu tiên `get_ut_context_pack`.
---
# Phase C — Evidence Ready
## 13. v2.4.0 — JUnit/JaCoCo Import
### 13.1. Goal
Gom execution evidence vào DB.
---
### 13.2. CLI Command
```bashcodeparse import-results   --junit target/surefire-reports   --jacoco target/site/jacoco/jacoco.xml```
---
### 13.3. New Tables
```sqlCREATE TABLE test_cases (  id INTEGER PRIMARY KEY,  test_class TEXT,  test_method TEXT,  target_method_id INTEGER,  objective TEXT,  status TEXT);
CREATE TABLE test_results (  id INTEGER PRIMARY KEY,  test_case_id INTEGER,  result TEXT,  duration_ms INTEGER,  report_file TEXT,  failure_message TEXT);
CREATE TABLE coverage_records (  id INTEGER PRIMARY KEY,  file_id INTEGER,  method_id INTEGER,  line_coverage REAL,  branch_coverage REAL,  instruction_coverage REAL,  source TEXT);```
---
### 13.4. Acceptance Criteria
- Parse Surefire XML.- Parse JaCoCo XML.- Map coverage về Java/Xtend source nếu có mapping.- Nếu Xtend mapping chưa đầy đủ, status là `partial`, không silently pass.- Coverage không được dùng để claim MC/DC pass nếu thiếu matrix/review.
---
## 14. v2.5.0 — ISO Evidence Export
### 14.1. Goal
Sinh evidence package phục vụ review/audit.
---
### 14.2. CLI Command
```bashcodeparse evidence   --asil D   --class org.xtext.example.mydsl.generator.CppContentBuilder   --output evidence/MCDC_Evidence_Package```
---
### 14.3. Output Package
```textMCDC_Evidence_Package/├── 01_Decision_List.xlsx├── 02_MCDC_Matrix.xlsx├── 03_Test_Mapping.xlsx├── 04_JUnit_Execution_Result.xml├── 05_JaCoCo_C0_C1_Report.html├── 06_Requirement_Traceability.xlsx├── 07_Technical_Review_Checklist.xlsx├── 08_Process_Safety_Review_Checklist.xlsx├── 09_Audit_Summary.xlsx└── 10_Tool_Limitation_Statement.md```
---
### 14.4. Tool Limitation Statement
```textcodeparse-mcp is used as an analysis and evidence preparation aid.
The tool extracts candidate decisions and conditions, generates draft MC/DCindependence pairs, and prepares context for AI-assisted JUnit generation.
Final MC/DC acceptance, requirement adequacy, and safety compliance approvalremain the responsibility of independent human reviewers.
JaCoCo coverage is used for C0/C1/branch evidence only and is not claimed asstandalone proof of MC/DC.```
---
# 15. Updated MCP Tool List
## 15.1. Lifecycle
```textcodeparse_initcodeparse_synccodeparse_statussync_filecodeparse_validate```
## 15.2. Class / Method / Source Context
```textsearch_classesget_classget_methodssearch_methodsget_method_contextread_source_range```
Note: `read_source_range` nếu expose public thì phải enforce workspace whitelist. Nếu không, chỉ nên dùng internal trong `get_method_context`.
## 15.3. CFG / MC/DC
```textget_cfgget_decisionsget_mcdcget_mcdc_for_class```
## 15.4. Call Graph / Dependencies
```textget_calleesget_callersget_dependencies```
## 15.5. UT Generation
```textget_ut_contextget_ut_context_packget_testability_report```
## 15.6. Evidence
```textimport_test_resultsget_coverage_summaryexport_evidence_plan```
---
# 16. Updated Agent Workflow
## 16.1. Old Workflow
```text1. codeparse_status2. search_classes3. get_ut_context4. optional get_cfg/get_mcdc5. write tests```
## 16.2. New Workflow
```text1. codeparse_status2. search_classes3. get_class4. get_methods5. choose target methods by UT priority6. get_method_context7. get_decisions8. get_mcdc9. get_ut_context_pack10. generate JUnit test11. run tests externally12. import-results13. export/generate evidence```
---
# 17. Agent Rules
Add these rules to `.vscode/codeparse-ut.agent.md` and `.github/prompts/codeparse-test*.md`:
```textRules:1. Do not generate unit tests from get_methods alone.2. Do not infer absolute file paths.3. Do not read large JSON files directly.4. Always call get_method_context or get_ut_context_pack before writing tests.5. Use get_decisions and get_mcdc before discussing MC/DC.6. If parse_status is warning/error, report parser issue and request source-backed context.7. Do not claim MC/DC pass without executed tests and reviewer-approved independence pairs.8. JaCoCo C0/C1/branch coverage is not standalone proof of MC/DC.```
---
# 18. README Wording Updates
## 18.1. Current Wording
```textKnowledge base for AI-driven ISO 26262 ASIL-D unit test generation with 100% MC/DC + C0 + C1 coverage.```
## 18.2. Recommended Wording
```textKnowledge base for AI-assisted ISO 26262 ASIL-D unit test generation,targeting 100% C0/C1/MC/DC with deterministic code graph context,draft MC/DC evidence, and human-reviewable traceability.```
---
## 18.3. Current MC/DC Wording
```textMC/DC: boolean condition decomposition, truth tables, independence pairs```
## 18.4. Recommended MC/DC Wording
```textMC/DC: decision-level condition decomposition, truth tables,draft independence pairs, and review-ready evidence mapping.Final acceptance requires executed tests and reviewer approval.```
---
# 19. Branch Plan
```textdevelop├── feature/v1.1-mcp-contract-cleanup├── feature/v1.2-method-context-api├── feature/v1.3-parser-quality-gates├── feature/v2.0-decision-condition-graph├── feature/v2.1-xtend-template-parser├── feature/v2.2-mcdc-planner-v2├── feature/v2.3-ut-context-pack├── feature/v2.4-junit-jacoco-import└── feature/v2.5-evidence-export```
---
# 20. Release Tags
```textcodeparse-mcp-v1.1.0codeparse-mcp-v1.2.0codeparse-mcp-v1.3.0codeparse-mcp-v2.0.0codeparse-mcp-v2.1.0codeparse-mcp-v2.2.0codeparse-mcp-v2.3.0codeparse-mcp-v2.4.0codeparse-mcp-v2.5.0```
---
# 21. Definition of Done
## 21.1. v1.2.0 DoD
- `get_methods` output sạch, không duplicate fields.- `boolean_conditions` là array thật.- HTML entities được decode.- Method có `file.path`.- Có `get_method_context`.- AI lấy được source body từ MCP.- Không còn cần tự đọc file hoặc dựng absolute path.
---
## 21.2. v2.0.0 DoD
- Có tables `decisions` và `conditions`.- Compound condition được decomposed.- Duplicate condition được tách theo decision UID.- `get_decisions` trả decision-level output.- `get_mcdc` dùng decision/condition graph mới.
---
## 21.3. v2.5.0 DoD
- Import được JUnit result.- Import được JaCoCo report.- Export được evidence package.- Có Decision List.- Có MC/DC Matrix.- Có Test Mapping.- Có Technical Review Checklist.- Có Process/Safety Review Checklist.- Có Audit Summary.- Có Tool Limitation Statement.
---
# 22. Recommended Next Action
Nếu chỉ chọn một version tiếp theo để build ngay:
```textBuild codeparse-mcp v1.2.0```
Scope nên bao gồm:
```textv1.1.0 MCP cleanup+ get_method_context+ file.path in method responses+ source snippet by line range+ parser quality warnings cơ bản+ agent instruction update```
Lý do:
```textv1.2.0 xử lý trực tiếp lỗi AI đang gặp:- Không đọc được JSON lớn.- Không đọc được source file.- Phải tự đoán absolute path.- Chỉ có method summary nhưng không đủ context viết UT.```
Sau đó mới tiếp tục:
```textv1.3.0 → parser quality gatesv2.0.0 → decision/condition graphv2.1.0 → Xtend template parserv2.2.0 → MC/DC plannerv2.3.0 → UT context packv2.4/v2.5 → evidence automation```
---
# 23. Final Recommendation
`codeparse-mcp` v1 đã có foundation tốt, nhưng version mới cần chuyển trọng tâm từ:
```textraw graph data exposure```
sang:
```texttask-ready, source-backed, audit-aware MCP context```
Thiết kế mới nên đảm bảo:
- MCP không trả raw JSON lớn.- AI không tự đoán file path.- Context viết UT luôn có source body.- MC/DC dựa trên decision/condition graph, không dựa trên flat boolean strings.- Parser lỗi phải được flag trước khi dùng cho evidence.- Final MC/DC acceptance cần execution result và human review.
Đây là hướng phù hợp để biến `codeparse-mcp` thành tool thực tế cho Java/Xtend unit test generation trong môi trường ISO 26262 ASIL-D.