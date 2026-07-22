# Quality Contract 작업 인수인계

작성일: 2026-07-16  
저장소: `/Users/hao/workspace/work/personal/gajae-code-canonical`  
Remote: `https://github.com/Yeachan-Heo/gajae-code.git`

## 1. 전체 목표와 맥락

이 작업의 목적은 ISTQB/ISO 기반 실무 테스트 원칙을 에이전틱 프로그래밍에 맞게 확장하여 다음 품질 권위 체계를 정의하고 강제하는 것이다.

```text
immutable snapshot
→ independent verification evidence
→ signed receipt
→ terminal pair
→ deterministic completion authority
```

핵심 원칙은 다음과 같다.

- 모델 출력은 주장일 뿐이며 완료 권위가 아니다.
- snapshot, lease, budget, evidence, receipt, terminal pair, completion authority는 결정적 런타임이 소유한다.
- 검증자는 구현자의 사고과정과 분리된 최소 충분 컨텍스트를 사용한다.
- 개별 `TaskCompleted`, `SubagentStop`, job terminal, `turn_end`, `Stop`, `agent_end` 이벤트만으로 검증을 시작하지 않는다.
- mandatory 검증은 시간 예산 때문에 생략할 수 없다.
- hard timeout은 PASS/CLEAR가 아니다.
- Claude Code와 Codex hook은 최초 단계에서 observation-only ingress로 취급한다.
- 특정 모델을 실측 근거 없이 기본값으로 고정하지 않는다.

공식 자료 우선순위:

- ISTQB/KSTQB, ISO 25010/29119
- `openai/codex` 및 Codex 공식 hooks/App Server 문서
- Claude Code 공식 hooks 문서
- `Yeachan-Heo/gajae-code`

## 2. 단계 구분

### Phase 0

기존 quality-contract 기반 계약, schema, canonicalization, hashing/signature/pin, lifecycle/storage model, SQLite authority, callsite audit를 동결한 단계다.

기존 frozen identity:

- Combined: `1048f17b270b7e354c9813ad817cde357bc3fdba4263fac87945579eb06ab1c2`
- Report: `f17975cfbfa945673d1a7f02bd990a5b5300f542423938ef7e85d8bfe5260402`

### Phase A — 완료

Quiescence & Time-Budget Contract v1의 A0–A6 계약 확장, 증거 결속, 결정적 생성 및 freeze를 완료했다.

- A0: 공식 source evidence와 candidate materialization
- A1: quiescence authority, lifecycle/ingress 계약, semantic negatives
- A2: verification commands, mandatory obligations, risk/profile budgets, acceptance resolution
- A3: reducer/model 및 SQLite durable authority proof
- A4: Phase B evidence protocol의 intent-only 계약
- A5: evidence-bound approval/schema-lock/callsite generation
- A6: acyclic deterministic generated layers와 final index

### Phase B — 미승인·미구현

Phase A에서 동결한 계약을 실제 GajaeCode runtime lifecycle/coordinator/hook/job delivery/SQLite authority에 연결하여 강제하는 단계다.

현재 모든 관련 경계는 다음 상태를 유지한다.

```json
{"phase1Authorized": false}
```

Phase B runtime enforcement는 별도 명시 승인을 받기 전까지 구현하거나 실행하면 안 된다.

## 3. 현재 작업 상태

### 완료된 구현

- closed official-source evidence schema와 공식 자료 records
- candidate materialization policy
- quiescence schema 및 lifecycle/ingress manifests
- exact acceptance resolution과 profile-bound mandatory obligations
- R0–R3 및 surface별 queue/soft/hard/global budget
- reducer의 exact evidence/receipt/terminal relation 검증
- SQLite exact all-profile obligation catalogs
- monotonic fenced lease claim/recovery
- live lease와 exact mandatory evidence 기반 atomic bridge commit
- catalog INSERT/UPDATE/DELETE 불변성
- lease identity 불변성
- direct committed insert 및 direct 0→1 update 차단
- current/superseded lease DELETE 차단과 회귀 proof
- Phase B wrapper의 strict intent-only 동작
- evidence-bound preapproval → generation → approval → final-index 흐름
- JCS canonicalization과 acyclic L0–L5 inventory
- schema lock, callsite manifest, independent callsite audit

### 최종 검증 결과

- Model verifier: `570 passed / 0 failed`
- SQLite verifier: `138 passed / 0 failed`
- Integrated contract verifier: `12 passed / 0 failed`
- Callsite audit: failures `0`
- Strict TypeScript typecheck: 통과
- 전체 `quality-contract/generated` 두 차례 재생성: 변경 파일 `0`
- Phase B intent probe:

```json
{
  "format": "quality-contract.phase-b-intent.v1",
  "futureFilesChecked": false,
  "gateCount": 9,
  "matrixVersion": "phase-b-verification-matrix/v1",
  "phase1Authorized": false,
  "valid": true
}
```

### 독립 검토 결과

- 최종 Architect: `CLEAR / CLEAR / CLEAR`, `APPROVE`
- 최종 Critic: `OKAY`
- Executor QA/red-team: `passed / passed / passed`
- 최종 blocker: `0`

## 4. Durable workflow 상태

Ultragoal 상태는 완료되었다.

Durable 경로:

```text
/Users/hao/workspace/work/personal/gajae-code-canonical/.gjc/_session-019f608e-7c29-7000-80c7-8c84f9da84f2/ultragoal/
```

주요 파일:

- `goals.json`
- `ledger.jsonl`
- `brief.md`

Receipts:

- G008 cumulative implementation receipt: `a3e2a052-0e80-4f2a-8248-1899e9b8e840`
- G009 final aggregate receipt: `8cfd3225-de70-493b-869d-e36fa23a6adf`
- Quality gate hash: `832229ad6bd4727106ab831f9f397dd78d9f203ba5bf0d2ecaa9066a43977c86`

현재 durable counts:

- complete: 2
- superseded: 7
- pending/active/blocked/review_blocked/failed: 0

G001–G007은 누적 blocker-resolution story인 G008에 의해 증거와 함께 superseded 되었고, G009가 final aggregate receipt를 발급했다.

## 5. 승인된 계약과 계획 위치

최종 승인 plan:

```text
/Users/hao/workspace/work/personal/gajae-code-canonical/.gjc/_session-019f608e-7c29-7000-80c7-8c84f9da84f2/plans/ralplan/019f608e-7c29-7000-80c7-8c84f9da84f2/pending-approval.md
```

Plan SHA-256:

```text
f5f82e3f6453cccb06d3530629c8d6005273f7223f9351c28d6a92a38da3d278
```

Planner Stage 5:

```text
/Users/hao/workspace/work/personal/gajae-code-canonical/.gjc/_session-019f68a3-6600-7000-a224-9a58103d778c/plans/ralplan/019f68a3-6600-7000-a224-9a58103d778c/stage-05-revision.md
```

Stage 5 SHA-256:

```text
d4dd6e95999ca2bfef08fc95f3cb63020e2180eed929697fc918a989129d838d
```

## 6. 주요 소스와 산출물

### Schemas

- `quality-contract/schemas/official-source-evidence.schema.json`
- `quality-contract/schemas/quiescence-and-budget.schema.json`
- `quality-contract/schemas/verification-command.schema.json`
- `quality-contract/schemas/phase-b-verification.schema.json`
- `quality-contract/schemas/quiescence-extension-approval.schema.json`

### Manifests

- `quality-contract/manifests/candidate-materialization-policy.json`
- `quality-contract/manifests/harness-ingress-contract.json`
- `quality-contract/manifests/harness-lifecycle-events.json`
- `quality-contract/manifests/verification-commands.json`
- `quality-contract/manifests/verification-obligations.json`
- `quality-contract/manifests/risk-policy.json`
- `quality-contract/manifests/phase-b-verification-matrix.json`

### Models 및 SQL

- `quality-contract/models/quiescence-budget-model.ts`
- `quality-contract/sql/quiescence-authority.sql`

### Verification scripts

- `quality-contract/scripts/verify-models.ts`
- `quality-contract/scripts/verify-sqlite.ts`
- `quality-contract/scripts/verify-sqlite-node.ts`
- `quality-contract/scripts/generate-callsite-manifest.ts`
- `quality-contract/scripts/audit-callsite-coverage.ts`
- `quality-contract/scripts/generate-schema-lock.ts`
- `quality-contract/scripts/verify-contracts.ts`
- `quality-contract/scripts/run-phase-b-verification.ts`

### Final generated evidence

- `quality-contract/generated/model-report.json`
- `quality-contract/generated/sqlite-report.json`
- `quality-contract/generated/phase0-verification-report.json`
- `quality-contract/generated/quiescence-extension-source-inventory.json`
- `quality-contract/generated/quiescence-extension-lock.payload.json`
- `quality-contract/generated/quiescence-extension-lock.signatures.json`
- `quality-contract/generated/quiescence-extension-lock.pin.sha256`
- `quality-contract/generated/quiescence-extension-verification-report.json`
- `quality-contract/generated/quiescence-extension-approval.payload.json`
- `quality-contract/generated/quiescence-extension-approval-receipt.json`
- `quality-contract/generated/quiescence-extension-final-index.json`

## 7. 현재 Phase B 계약

### Quiescence 조건

검증은 다음 조건의 합성으로만 시작한다.

- root objective completion candidate
- main agent settled
- active work = 0
- queued work = 0
- pending delivery = 0
- incomplete required task = 0
- stable mutation epoch
- quiet window 충족
  - single agent: 2초
  - multi-agent/background: 5초
- candidate TTL: 30분

개별 terminal event는 advisory signal일 뿐 seal/lease/completion authority가 아니다.

### Lease identity

동일 다음 튜플에는 하나의 current verification lease만 허용한다.

```text
(projectRootIdentity,
 rootObjectiveId,
 candidateGeneration,
 mutationEpoch,
 verificationProfile)
```

- one current monotonic fence
- pre-expiry takeover 금지
- at/after-expiry fenced recovery
- stale owner commit 금지
- immutable lease history
- matching authoritative bridge만 one-way commit 가능

### Hook budget

- soft: 500ms
- hard: 2초
- hook 내부 test/browser/compile/model 호출 금지
- hook은 authenticated ingress enqueue만 수행

### Verification budgets

Risk budgets:

- R0: soft 30초 / hard 60초
- R1 non-browser: soft 2분 / hard 4분
- R1 browser: soft 5분 / hard 8분
- R2 non-browser: soft 6분 / hard 12분
- R2 browser: soft 10분 / hard 18분
- R2 Rust cold-required: soft 12분 / hard 20분
- R3 local precheck: soft 10분 / hard 20분; 초과 시 `MANAGED_VERIFICATION_REQUIRED`

Surface budgets:

- JS/TS unit: 90초 / 210초
- Python: 135초 / 360초
- Rust incremental: 240초 / 600초
- Rust cold: 10분 / 20분
- Playwright: 약 6분 / 약 12분

### Phase B quality gates

Required trace gates:

- `b1-unit`
- `b2-gjc-integration`
- `b3-hook-integration`
- `b4-enforcement-e2e`

Trace가 금지된 gates:

- `coding-agent-types`
- `coding-agent-check`
- `coding-agent-regression`
- `root-check-ts`
- `root-test-ts`

Required trace path:

```text
<artifact-root>/runs/<runId>/<gateId>/artifacts/trace.json
```

Required timing source:

```json
{"timingSource":"quality-trace"}
```

## 8. 남은 작업

현재 승인 범위 내 남은 구현 작업은 없다. 다음 작업은 모두 별도 승인 또는 별도 조사 단계다.

### 우선순위 1: Phase B 별도 승인 및 구현 계획

승인을 받으면 다음 순서로 진행한다.

1. GajaeCode durable coordinator integration point 확정
2. authenticated lifecycle ingress adapter 구현
3. root candidate와 global quiescence reducer 연결
4. immutable candidate materialization과 SQLite lease 연결
5. exact mandatory obligation scheduler 연결
6. Evidence → Receipt → TerminalPair bridge 구현
7. completion authority를 기존 agent/turn lifecycle에 연결
8. Claude/Codex observation-only adapter 검증
9. `b1-unit` → `b4-enforcement-e2e` 실행
10. 별도 Phase B approval receipt 발급

Phase B는 architecture/sequence risk가 높으므로 새 세션에서는 기존 Phase A 승인을 실행 승인으로 오해하지 말고, 별도 `ralplan --deliberate` 또는 명시 승인 경계를 사용해야 한다.

### 우선순위 2: 별도 연구 항목

Phase B 계약 이후 다음 순서로 조사한다.

1. verification cache reuse
2. parallel verification scheduling
3. managed asynchronous R3
4. model routing/default selection

각 항목은 공식 자료, 실측 benchmark, 비용/시간 효율 자료를 확보한 뒤 결정한다.

## 9. 금지 사항과 안전 경계

별도 승인 전에는 다음을 하지 않는다.

- Phase B product runtime 구현 또는 실행
- `phase1Authorized:true` 생성
- Phase B gate completion artifact 생성
- cache reuse 구현
- parallel verification 구현
- managed async R3 구현
- model routing/default 변경
- 특정 모델을 근거 없이 기본값으로 지정
- `.gjc/` durable state를 직접 파일 편집
- commit, push, PR 생성

`.gjc/` 상태 변경이 필요하면 반드시 지원되는 `gjc` 명령을 사용한다.

## 10. 재검증 명령

Phase A current-state 검증 순서:

```bash
bun quality-contract/scripts/verify-models.ts
bun quality-contract/scripts/verify-sqlite.ts
bun quality-contract/scripts/generate-callsite-manifest.ts
bun quality-contract/scripts/audit-callsite-coverage.ts
bun quality-contract/scripts/verify-contracts.ts --preapprove-extension
bun quality-contract/scripts/generate-schema-lock.ts
bun quality-contract/scripts/verify-contracts.ts
bun quality-contract/scripts/verify-contracts.ts --verify-quiescence-final-index
bun quality-contract/scripts/run-phase-b-verification.ts --intent
bun x tsc --ignoreConfig --noEmit --strict \
  --target ES2022 --module ESNext --moduleResolution Bundler \
  quality-contract/models/lifecycle-model.ts \
  quality-contract/models/storage-model.ts \
  quality-contract/models/quiescence-budget-model.ts
git diff --check
```

중요: source 또는 verifier report가 바뀌면 생성 순서상 preapproval evidence가 stale할 수 있다. 일반적인 재동결 순서는 다음과 같다.

1. model/SQLite/callsite reports 갱신
2. `generate-schema-lock.ts`를 한 번 호출하여 source inventory를 갱신할 수 있으나 stale preapproval로 실패할 수 있음
3. `verify-contracts.ts --preapprove-extension`
4. `generate-schema-lock.ts`
5. full verifier와 final-index verifier

결정성 확인은 동일 전체 생성 흐름을 두 번 실행하고 `quality-contract/generated`의 모든 파일 SHA-256이 동일한지 비교한다.

## 11. Git 상태와 전달 시 주의점

Phase A 변경은 저장소 working tree에 존재하며 아직 commit/push하지 않았다. 최종 확인 당시 tracked modifications와 다수의 새 `quality-contract` 파일이 있었다.

- 사용자 요청 전 push 금지
- 예상하지 못한 변경은 다른 작업자의 변경일 수 있으므로 revert/stash/delete 금지
- 새 세션 시작 즉시 다음을 확인할 것:

```bash
git status --short
git diff --check
gjc ultragoal status --json
```

이 인수인계 파일 자체도 새 파일이므로 이후 commit 범위를 구성할 때 명시적으로 포함하거나 제외해야 한다.

## 12. 새 세션 시작 체크리스트

1. 저장소 cwd를 `/Users/hao/workspace/work/personal/gajae-code-canonical`로 설정
2. `git status --short`와 `git diff --check` 확인
3. 이 파일과 최종 pending approval plan 읽기
4. `gjc ultragoal status --json`에서 final aggregate receipt 확인
5. `phase1Authorized:false` 유지 확인
6. 사용자가 Phase B 실행을 명시적으로 승인했는지 확인
7. 승인 전에는 정보 조사나 새 계획 작성만 수행
8. 승인되면 Phase B runtime 통합 대상을 다시 최신 source 기준으로 매핑
9. 전체 gate와 independent review를 새 snapshot 기준으로 다시 수행

## 13. 최종 요약

Phase A는 구현·검증·독립 리뷰·durable aggregate checkpoint까지 완료됐다. 현재 제품 runtime에는 Phase B enforcement가 연결되지 않았다. 다음 세션의 핵심 선택지는 두 가지다.

- Phase B 구현 전에 최신 GajaeCode runtime integration map과 별도 승인 계획을 수립한다.
- 또는 cache/parallel/R3/model-routing 중 하나를 공식 자료와 benchmark 중심으로 별도 조사한다.

어느 경우에도 기존 Phase A freeze와 `phase1Authorized:false` 경계를 약화하면 안 된다.
