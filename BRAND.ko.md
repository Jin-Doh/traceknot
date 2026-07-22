# Quality Contract 브랜드 시스템

> **코딩 에이전트를 위한 증거 결속형 QA.**

Quality Contract는 설명적인 프로젝트 이름이자 제품 범주입니다. 코딩 에이전트의 완료 주장을 테스트 기준, 제품 위험, 테스트 조건, 필수 검증 의무, 스냅샷 결속 증거, 결함, 잔여 위험에 연결하고 결정적 QA 판정으로 변환합니다.

[English brand guide](BRAND.md)

## 포지셔닝

**범주:** 코딩 에이전트 하네스를 위한 ISTQB 정렬 QA 프레임워크.

**한 문장 소개:** Quality Contract는 코딩 에이전트의 완료 주장을 증거에 결속된 판정으로 바꾸며, 수명주기 이벤트를 검증 증명으로 취급하지 않습니다.

**약속:** 동일한 테스트 기준, 검증 의무, 증거, 결함에는 동일한 판정이 나옵니다.

**경계:** Quality Contract는 에이전트, 모델, 작업 그래프, 동시성, 재시도, worktree, 수명주기, 하네스 완료를 소유하지 않습니다. portable core는 비권위적입니다. 완료 권한은 별도로 승인해야 하는 비활성 기본값의 호스트 통합입니다.

## 이 프로젝트가 필요한 이유

네이티브 코딩 에이전트 하네스는 오케스트레이션에 강합니다. 에이전트를 만들고, 도구를 실행하고, 작업을 조정하고, 재시도하고, 수명주기 이벤트를 방출합니다. 그러나 이것만으로 “선언한 변경이 위험과 인수 기준에 비추어 충분히 검증되었는가?”라는 QA 질문에는 답할 수 없습니다.

| 네이티브 하네스 신호 | 입증하는 것 | 입증하지 못하는 것 |
| --- | --- | --- |
| turn, task, subagent 종료 | 수명주기 전이가 발생함 | 필수 검증 통과 |
| 명령 성공 종료 | 해당 명령이 허용된 상태를 반환함 | 테스트 기준과 위험 커버리지의 충분성 |
| 에이전트의 “완료” 선언 | 완료 주장이 존재함 | 증거의 독립성, 최신성, 스냅샷 결속 |
| 관찰된 job이 모두 idle | 관찰된 큐가 조용함 | 전역 quiescence 또는 미관찰 작업의 부재 |
| hook/app-server 이벤트 | 호스트 관찰이 발생함 | 결정적 QA 판정 또는 완료 권한 |

Quality Contract는 누락된 테스트 프로세스 계층을 제공합니다. 추적성, 증거 요건, 결함·잔여 위험 처리, 결정적 판정 우선순위, QA 판정과 하네스 완료의 명시적 경계입니다.

## 메시지 계층

1. **헤드라인:** 코딩 에이전트를 위한 증거 결속형 QA.
2. **증명 구조:** 테스트 기준 → 위험 → 조건 → 의무 → 증거 → 결함 → 판정.
3. **차별점:** 수명주기 이벤트는 관찰이지 증명이 아닙니다.
4. **신뢰 문장:** 결정적이고 호스트 중립적이며 기본값은 비권위적입니다.
5. **확장 문장:** 하네스 완료 권한에는 명시적이고 별도로 승인된 통합이 필요합니다.

## 제품 구조

| 이름 | 역할 |
| --- | --- |
| **Quality Contract Skill** | portable ISTQB 정렬 workflow와 저장소 탐색 가이드 |
| **Quality Contract Records** | 요청, 계획, 증거, 결함, 판정, capability용 closed JSON Schema 계약 |
| **Quality Contract Core** | 호스트 중립 결정적 coverage·판정 resolver |
| **Quality Contract Protocol** | 표준 호스트 관찰·검증 경계 |
| **Quality Contract Adapter — _Host_** | 호스트 소유 capability 선언과 protocol mapping |
| **Quality Contract Completion-Authority Extension** | 선택적 lifecycle, quiescence, lease, receipt, 완료 권한; 기본 비활성 |

`QC`는 코드, CLI 예시, 좁은 레이블에서 사용할 수 있습니다. 공개 헤드라인과 첫 언급에는 **Quality Contract**를 풀어 씁니다. `QC`가 흔히 quality control을 뜻해 QA 포지셔닝을 흐릴 수 있기 때문입니다. portable core를 gate, seal, authority, orchestrator라고 부르지 않습니다.

## 목소리

- 정확하고 차분하며 반증 가능하게 씁니다.
- 증거가 입증하는 것과 입증하지 못하는 것을 함께 밝힙니다.
- *verdict*, *obligation*, *basis*, *risk*, *evidence*를 사용하고 *trustless*, *unbreakable*, *AI judge* 같은 과장 표현은 피합니다.
- **PASS**는 선언한 테스트 기준과 필수 검증 의무에만 사용합니다. 모든 하네스 작업이나 delivery가 끝났다는 뜻으로 확장하지 않습니다.
- 추론은 추론으로 표시하고 잔여 위험을 숨기지 않습니다.

## 시각 정체성

![Quality Contract mark](assets/quality-contract-mark.svg)

마크는 계약 문서, 6개 노드의 추적성 체인, 판정 인장을 결합합니다. 인장은 시각 마크와 선택적 completion-authority 서사에만 속하며 portable 판정의 권위를 주장하지 않습니다.

| 토큰 | 색상 | 용도 |
| --- | --- | --- |
| Ink | `#1A1917` | 기본 텍스트와 구조 |
| Parchment | `#F4F1EA` | 따뜻한 배경 |
| Paper | `#FFFEFA` | record 표면 |
| Vermillion | `#B33A2B` | 브랜드 accent와 FAIL |
| Verdigris | `#3E7C6F` | PASS |
| Ochre | `#C08A2E` | BLOCKED |
| Graphite | `#5A5750` | INCOMPLETE와 보조 텍스트 |

평면 색상, 높은 대비, 줄이 잡힌 구조, 넉넉한 여백을 사용합니다. gradient, glass effect, neon AI motif, robot head, shield, 일반적인 checkmark-only logo는 사용하지 않습니다.

본문은 읽기 좋은 절제된 serif 또는 humanist sans를, record와 identifier에는 tabular numeral을 지원하는 monospace를 사용합니다. 문장형 대소문자를 기본으로 하고 `PASS`, `FAIL`, `BLOCKED`, `INCOMPLETE` 같은 실제 판정 값만 대문자로 씁니다.

## 이름 결정

기존 이름은 의도적으로 설명적입니다. Qwen 3.8 Max Preview 디자인 리뷰에서 처음에는 조어 후보를 제안했지만, 충돌 조사 결과 AI 테스트·증거·판정 도구와 직접 겹쳤습니다. 명확한 tagline을 결합한 설명적 이름이 이미 사용 중이거나 권위를 과장하는 조어보다 이 오픈소스 프레임워크에 더 정직하고 검색하기 쉽습니다.

이는 제품 포지셔닝 결정이며 법률 검토가 아닙니다. 상업적으로 사용하기 전에 관련 관할권과 상품류의 상표·도메인을 별도로 조사해야 합니다.
