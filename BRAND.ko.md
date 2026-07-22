# Traceknot 브랜드 시스템

> **코딩 에이전트를 위한 증거 결속형 QA.**

Traceknot(트레이스노트)은 코딩 에이전트 하네스를 위한 ISTQB 정렬 QA 프레임워크입니다. 완료 주장을 테스트 기준, 제품 위험, 테스트 조건, 필수 의무, 스냅샷 결속 증거, 결함, 잔여 위험에 묶어 결정적 QA 판정으로 변환합니다.

[English brand guide](BRAND.md)

## 이름과 이야기

**발음:** TRACE-not, 트레이스노트.

**한 문장 이야기:** 모든 판정은 증거에 매듭지어집니다. 매듭을 추적하면 전체 검증 체인이 드러납니다.

`Trace`는 기준에서 판정까지 이어지는 양방향 추적성을, `knot`은 증거가 선언된 의무와 스냅샷에 결속되는 구조를 뜻합니다. 매듭은 누락되거나 느슨하거나 끊어질 수 있으므로 이 이름은 결함 부재, 절대적 증명, 완료 권한을 주장하지 않습니다.

**범주:** 코딩 에이전트 하네스를 위한 증거 결속형 QA 프레임워크.

**약속:** 동일한 테스트 기준, 의무, 증거, 결함에는 동일한 판정이 나옵니다.

**경계:** Traceknot은 에이전트, 모델, 작업 그래프, 동시성, 재시도, worktree, lifecycle, 하네스 완료를 소유하지 않습니다. portable core는 비권위적입니다. 완료 권한은 별도로 승인해야 하는 비활성 기본값의 호스트 통합입니다.

## 이 프로젝트가 필요한 이유

네이티브 코딩 에이전트 하네스는 에이전트, 도구, job, retry, lifecycle event를 조정하지만 “선언한 변경이 위험과 인수 기준에 비추어 충분히 검증되었는가?”라는 QA 질문에는 답하지 못합니다.

| 네이티브 하네스 신호 | 입증하는 것 | 입증하지 못하는 것 |
| --- | --- | --- |
| turn, task, subagent 종료 | lifecycle 전이가 발생함 | 필수 검증 통과 |
| 명령 성공 종료 | 해당 명령이 허용된 상태를 반환함 | 테스트 기준과 위험 coverage의 충분성 |
| 에이전트의 “완료” 선언 | 완료 주장이 존재함 | 증거의 독립성, 최신성, snapshot 결속 |
| 관찰된 job이 모두 idle | 관찰된 queue가 조용함 | 전역 quiescence 또는 미관찰 작업의 부재 |
| hook/app-server 이벤트 | 호스트 관찰이 발생함 | 결정적 QA 판정 또는 완료 권한 |

Traceknot은 추적성, 증거 요건, 결함·잔여 위험 처리, 결정적 판정 우선순위, QA 판정과 하네스 완료의 명시적 경계를 제공합니다.

## 유명 오픈소스 브랜드 비교

| 프로젝트 | 가져온 브랜드 원칙 |
| --- | --- |
| Open Policy Agent / OPA | 설명적인 범주명과 짧은 실행 이름의 결합 |
| Sigstore | 하나의 강한 mechanism metaphor, 직설적 tagline, 조합 가능한 subproject |
| in-toto | 결과를 과장하지 않고 end-to-end 범위를 이름에 반영 |
| SLSA | 명시적 모델을 뒷받침하는 발음 가능한 기술 이름 |
| OpenSSF Scorecard | 사용자가 받는 결과물과 프로젝트 이름의 직접 연결 |
| Trivy | 짧고 구별되는 이름과 category-defining tagline |
| Semgrep | 익숙한 개발자 용어를 결합한 기억하기 쉬운 compound |
| Testkube | 테스트 범주와 ecosystem context의 결합 |

이전 이름 **Quality Contract**는 명확했지만 일반적이고, CLI에서 길며, 검색 구별성이 낮고, 문서/checkmark라는 흔한 시각 motif에 의존했습니다. Traceknot은 계약의 결속 의미를 유지하면서 구별되는 compound, 한 문장 이야기, wordmark 없이도 인식 가능한 mark를 제공합니다.

## 메시지 계층

1. **헤드라인:** 코딩 에이전트를 위한 증거 결속형 QA.
2. **검증 구조:** 기준 → 위험 → 조건 → 의무 → 증거 → 결함 → 판정.
3. **브랜드 이야기:** 모든 판정은 증거에 매듭지어집니다.
4. **차별점:** lifecycle event는 관찰이지 증명이 아닙니다.
5. **신뢰 문장:** 결정적이고 호스트 중립적이며 기본값은 비권위적입니다.
6. **확장 문장:** 하네스 완료 권한에는 명시적이고 별도로 승인된 통합이 필요합니다.

## 제품 구조

| 이름 | 역할 |
| --- | --- |
| **Traceknot Skill** | portable ISTQB 정렬 workflow와 저장소 탐색 가이드 |
| **Traceknot Records** | 요청, 계획, 증거, 결함, 판정, capability용 closed JSON Schema 계약 |
| **Traceknot Core** | 호스트 중립 결정적 coverage·판정 resolver |
| **Traceknot Protocol** | 표준 호스트 관찰·검증 경계 |
| **Traceknot Adapter — _Host_** | 호스트 소유 capability 선언과 protocol mapping |
| **Traceknot Completion-Authority Extension** | 선택적 lifecycle, quiescence, lease, receipt, 완료 권한; 기본 비활성 |

CLI와 package에는 `traceknot`을 사용합니다. 공개 이름을 `TK`로 줄이지 않습니다. portable core를 gate, seal, authority, orchestrator라고 부르지 않습니다.

## 목소리

- 정확하고 차분하며 반증 가능하게 씁니다.
- 증거가 입증하는 것과 입증하지 못하는 것을 함께 밝힙니다.
- *verdict*, *obligation*, *basis*, *risk*, *trace*, *evidence*를 사용하고 *trustless*, *unbreakable*, *AI judge* 같은 과장은 피합니다.
- **PASS**는 선언한 테스트 기준과 필수 의무에만 사용합니다. 모든 하네스 작업이나 delivery가 끝났다는 뜻으로 확장하지 않습니다.
- 추론은 추론으로 표시하고 잔여 위험을 숨기지 않습니다.

## 시각 정체성

![Traceknot mark](assets/traceknot-mark.svg)

마크는 두 개의 연속 trace를 vermillion 판정점 주위의 매듭으로 조입니다. 6개 노드는 기준, 위험, 조건, 의무, 증거, 결함을 뜻합니다. 중앙 판정은 체인의 결과이지 전역 권위 주장이 아닙니다.

| 토큰 | 색상 | 용도 |
| --- | --- | --- |
| Ink | `#1A1917` | 기본 텍스트와 trace 구조 |
| Parchment | `#F4F1EA` | 따뜻한 배경 |
| Paper | `#FFFEFA` | record 표면과 node fill |
| Vermillion | `#B33A2B` | 브랜드 중심과 FAIL |
| Verdigris | `#3E7C6F` | PASS |
| Ochre | `#C08A2E` | BLOCKED |
| Graphite | `#5A5750` | INCOMPLETE와 보조 trace |

평면 색상, 높은 대비, 기하학적 path, 넉넉한 여백을 사용합니다. gradient, glass effect, neon AI motif, robot head, shield, document/checkmark-only logo는 사용하지 않습니다.

## 이름 결정과 충돌 조사

Designer role과 함께 설명형, metaphor형, 조어형 후보를 검토했습니다. Basanos, Veridict, Proofrail, Qualt, Assay, Assayer, AgentAssay, TieOut, Obligo, Qontract, Plumbline은 직접 또는 인접 software 충돌로 제외했습니다. `Proofset`은 테스트가 결함의 부재를 증명할 수 없다는 ISTQB 원칙과 충돌해 제외했습니다.

검토 시점의 GitHub, npm, PyPI exact-name 검색에서는 확립된 Traceknot 프로젝트, package, company를 찾지 못했습니다. 이는 제품 포지셔닝 검토이며 법률 검토가 아닙니다. 상업적 사용 전에 관련 관할권과 상품류의 상표·도메인을 별도로 조사해야 합니다.

동결된 completion-authority extension은 기존 `quality-contract` v1 wire identifier와 path를 유지합니다. 이는 공개 masterbrand가 아니라 protocol compatibility surface입니다. 변경하려면 별도 version migration과 signed evidence 재생성이 필요합니다.
