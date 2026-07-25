# 서비스 정적 레플리카 용량 실험

`service-static-replica-capacity-load-test`는 고정된 replica 수에서 서비스별 안전 처리량과 첫 성능 저하 후보를 찾는다. 1 Pod와 2 Pod는 서로 다른 RUN으로 측정한다. 같은 조건의 결과만 나중에 비교하며, 실행기가 둘을 자동으로 합치지 않는다.

## 이 scenario가 소유하는 것

- 서비스 순서, endpoint mix, 결정론적 주소 계약, API별 SLO
- `constant-arrival-rate` 후보와 adaptive search, confirmation 규칙
- endpoint별 요청 수, 실제 RPS, 오류율, check, p50/p95/p99의 판정
- stable RPS, 마지막 통과, 첫 실패와 scenario 전용 `result.json` 형식
- 결과에 붙일 서비스/Pod 관측성 metric의 의미

`execute.js`는 RUN·scenario·preset·dataset·environment 조합을 검증한다. `runner.js`는 static search와 confirmation을 실행한다. `report.js`는 raw k6 summary와 관측성 snapshot을 합쳐 결과를 만든다.

공통 실행기는 RUN 해석, 서비스 순차 실행, Dataset/k6 Job 대기, artifact 전달, replica 적용·원복만 한다. API별 결과 필드와 static의 합격·불합격 규칙은 만들지 않는다.

## RUN과 preset

RUN은 scenario, preset, dataset, environment, 실제 replica 수를 연결한다. preset은 재사용 가능한 조건 묶음이다.

```yaml
run:
  scenario: ../scenarios/service-static-replica-capacity-load-test.yaml
  preset: ../presets/service-static-replica-capacity-load-test/local-smoke-1day-low-rps.yaml
  dataset: ../datasets/smoke-1day.yaml
  environment: ../environments/local.yaml
  deployment: { replicas: 1 }
```

예를 들어 preset은 낮은 RPS, 짧은 warmup·측정 시간, 1 replica, `smoke-1day`에 맞는 조건을 가진다. RUN은 그 조건을 실제 local environment에서 선택한다. preset replica 조건과 RUN replica가 맞지 않으면 실행하지 않는다.

## 실행 규칙

1. RUN과 결정론적 주소 계약을 확인한다.
2. 기존 dev Helm chart의 layered values를 사용해 replica만 임시 override한다.
3. 서비스당 Dataset Job을 한 번 준비한다. 후보나 confirmation마다 다시 만들지 않는다.
4. 각 후보를 독립 `constant-arrival-rate` k6 Job으로 실행하고, 필요한 경우 confirmation한다.
5. service 결과를 저장한 뒤 같은 chart와 layered values를 replica override 없이 다시 적용한다.

HPA/KEDA가 replica 수를 바꿀 수 있는 서비스는 1 replica 측정에 필요한 최소 override와 원복 조건이 설정되어 있어야 한다. loadtest는 서비스 image build/push, Secret 생성·복사·회전, migration, 새 dev release 배포를 하지 않는다.

Dataset Job은 허용 테이블만 다룬다. `alembic_version`, `goose_db_version`, `*_goose_db_version`, Auth 정책·설정 테이블, 운영 메타데이터는 보존한다. 직접 DB 입력이 없으면 임의 계정·coupon·기본 Secret 값을 만들지 않고, 민감한 값을 드러내지 않는 `configuration` 실패를 남긴다.

## 관측성과 결과

별도 collector Job, collector 전용 RBAC, start barrier, 반복 resource 수집은 없다. k6가 끝난 뒤 한 번만 GitOps가 이미 수집한 관측성 원본을 읽기 전용으로 조회한다. scenario의 metric specification이 CPU, 메모리, Pod restart 같은 값의 의미를 정하고, 공통 실행기는 PromQL이나 metric 이름을 알지 못한다.

관측성은 자동 첨부 자료다. scenario가 명시하지 않는 한 CPU·메모리 수치가 static의 HTTP 합격·불합격을 바꾸지 않는다. 값이 없거나 조회가 실패하면 숫자 0을 넣지 않고 `null`과 `unavailable`을 기록한다.

```json
{
  "apis": {
    "GET /api/v1/products": {
      "requests": 80,
      "actual_rps": 8,
      "error_rate": 0,
      "checks_rate": 1,
      "p50_ms": 18,
      "p95_ms": 36,
      "p99_ms": 60
    }
  },
  "observability": {
    "status": "available",
    "service": { "cpu_utilization": 22.1, "memory_utilization": 33.4, "pod_restarts": 0 }
  }
}
```

API 성능은 API별 k6 tag로, CPU·메모리·Pod restart는 서비스/Pod 단위로 기록한다. 한 API의 지연이 높다고 해서 CPU가 그 API 하나의 값이라고 적지 않는다.

## 로컬 snapshot cache와 smoke

`tmp/datasets/<cache-key>/`의 binary snapshot cache는 데이터 생성과 COPY 시간을 줄인다. cache는 manifest, checksum, schema와 row 계약이 모두 맞을 때만 복원하며, 서비스 배포나 이미지 준비를 하지 않는다. 비밀번호, token, cookie, Authorization 값, coupon 평문은 cache와 결과물에 기록하지 않는다.

`local-smoke-1day-static-replicas-1`은 1일 데이터와 1~2 RPS로 모든 서비스를 순차 실행하는 구조 검증용 RUN이다. 실제 전체 smoke에는 Kubernetes Dataset Job, k6 Job, 기존 dev release replica 적용·원복이 필요하다. Docker만으로는 이 경로를 실행할 수 없고, Kubernetes 변경이 금지된 환경에서는 실행하지 않는다.
