# Traceknot 브랜드 시스템

> **코딩 에이전트를 위한 감사 가능한 QA.**

Traceknot(트레이스노트)은 코딩 에이전트 하네스를 위한, ISTQB 원칙에 맞춘 QA 프레임워크입니다. 테스트 기준, 제품 위험, 테스트 조건, 필수 의무, 스냅샷에 연결된 증거, 결함, 잔여 위험을 바탕으로 완료 주장을 결정론적 QA 판정으로 바꿉니다.

[English brand guide](BRAND.md)

## 이름과 이야기

**발음:** TRACE-not, 트레이스노트.

**한 문장 이야기:** 모든 판정은 선언한 기준, 의무, 증거에 연결됩니다.

`Trace`는 기준에서 판정까지 이어지는 양방향 추적성을, `knot`은 증거가 선언된 의무와 스냅샷에 결속되는 구조를 뜻합니다. 매듭은 누락되거나 느슨하거나 끊어질 수 있으므로 이 이름은 결함 부재, 절대적 증명, 완료 권한을 주장하지 않습니다.

**범주:** 코딩 에이전트 하네스를 위한 증거 결속형 QA 프레임워크.

**약속:** 동일한 테스트 기준, 의무, 증거, 결함에는 동일한 판정이 나옵니다.

**경계:** Traceknot은 에이전트, 모델, 작업 그래프, 동시 실행, 재시도, 작업 트리, 수명 주기 또는 하네스 완료를 관리하지 않습니다. 휴대형 코어의 판정에는 하네스 완료 권한이 없습니다. 완료 권한은 기본적으로 비활성화되어 있으며, 호스트별 통합과 별도 승인이 있어야 사용할 수 있습니다.

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

## 이름을 정한 기준

이름 검토에서는 Traceknot이 동작 방식을 설명하면서도 결과를 과장하지 않는지 확인하기 위해 Sigstore, in-toto와 비교했습니다.

이전 이름 **Quality Contract**는 CLI에서 길고 검색 결과에서 구별하기 어려웠습니다. Traceknot은 증거를 판정에 연결한다는 뜻을 유지하면서 더 짧은 공개 이름을 사용합니다.

## 메시지 계층

1. **헤드라인:** 코딩 에이전트를 위한 감사 가능한 QA.
2. **동작 원리:** 기준에서 판정까지 증거에 결속됩니다.
3. **검증 구조:** 기준 → 위험 → 조건 → 의무 → 증거 → 결함 → 판정.
4. **브랜드 이야기:** 모든 판정은 선언한 증거에 연결됩니다.
5. **차별점:** lifecycle event는 관찰이지 증명이 아닙니다.
6. **신뢰 문장:** 결정적이고 호스트 중립적이며 기본값은 비권위적입니다.
7. **확장 문장:** 하네스 완료 권한에는 명시적이고 별도로 승인된 통합이 필요합니다.

## 제품 구조

| 이름 | 역할 |
| --- | --- |
| **Traceknot Skill** | 휴대형 ISTQB 기반 작업 절차와 저장소 탐색 지침 |
| **Traceknot Records** | 요청, 계획, 증거, 결함, 판정, 기능 선언에 사용하는 폐쇄형 JSON Schema 계약 |
| **Traceknot Core** | 호스트 중립적인 결정론적 커버리지·판정 처리기 |
| **Traceknot Protocol** | 표준 호스트 관찰·검증 경계 |
| **Traceknot Adapter — _Host_** | 호스트가 소유하는 기능 선언과 프로토콜 연결 |
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

마크는 두 개의 연속된 선이 주홍색 판정점을 둘러 매듭을 이루는 형태입니다. 여섯 개의 노드는 기준, 위험, 조건, 의무, 증거, 결함을 나타냅니다. 중앙점은 이 연결에서 나온 판정을 뜻하며, 하네스 전체에 대한 권한을 뜻하지 않습니다.

README 공통 Hero는 매듭 앞뒤의 record 흐름까지 확장해 보여 줍니다. 번역 문구는 이미지에 넣지 않고 접근 가능한 Markdown으로 관리합니다. 생성 정보와 canonical asset은 [`assets/readme/`](assets/readme/)에 기록합니다.

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

이름 검토에서는 설명형 이름, 은유형 이름, 조어를 비교하고 기존 소프트웨어와의 직접 충돌을 확인했습니다. GitHub, npm, PyPI의 예비 검색에서는 직접 충돌을 찾지 못했지만, 이는 법률 검토가 아닙니다. 상업적 사용 전에는 관련 상표와 도메인을 별도로 확인해야 합니다.

동결된 completion-authority extension에서는 기존 `quality-contract` v1 식별자와 경로를 유지해야 합니다. 이 식별자와 경로는 공개 브랜드명이 아니라 프로토콜 호환성 계약입니다. 변경하려면 별도 버전의 마이그레이션과 서명 증거 재생성이 필요합니다.
