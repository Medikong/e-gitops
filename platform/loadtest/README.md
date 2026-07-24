# DropMong GitOps Load Test

이 디렉터리는 이미 배포된 DropMong dev release를 대상으로 용량과 병목을 측정한다. 서비스 배포, migration, 운영 Secret, 서비스 환경 변수는 만들거나 바꾸지 않는다. 단, 로컬 RUN은 `task loadtest:run` 안에서 Dataset/k6 전용 입력 Secret과 loadtest 전용 이미지를 한 번 준비한다.

## 먼저 보는 책임 경계

| 구성 요소 | 맡는 일 | 맡지 않는 일 |
|---|---|---|
| RUN | 실제 실험 조합 선택 | API 판정과 결과 형식 결정 |
| scenario | 서비스 순서, API 계약, k6 규칙, 판정, 결과 형식 결정 | 환경별 RPS·시간 같은 조건 보관 |
| preset | RPS, 시간, warmup, window, replica, dataset profile 같은 재사용 조건 보관 | 서비스별 endpoint와 판정 의미 결정 |
| dataset | 허용된 테이블의 데이터 규모·seed·fixture 계약 보관 | 서비스 배포, Secret 준비, 이미지 준비 |
| environment | 기존 dev Helm values, namespace, Dataset/k6 입력 참조와 관측성 연결 정보 보관 | 서비스 설정 변경 |
| 공통 실행기 | RUN 해석, 서비스 순차 실행, Job 대기, artifact 전달, replica 적용·원복 | API별 결과 조립, 성능 판정, PromQL 해석 |
| Dataset Job | 서비스가 시작되기 전 데이터 생성 또는 cache 복원 | 운영 메타데이터 삭제 |
| k6 Job | fixture를 사용한 HTTP 요청과 endpoint별 HTTP 원본 생성 | CPU·메모리 판정 |
| 관측성 adapter | k6 종료 뒤 한 번의 읽기 전용 snapshot 조회 | 반복 수집 Job 또는 Kubernetes RBAC 생성 |
| scenario report | k6 원본과 snapshot을 합쳐 해당 scenario의 `result.json` 생성 | 다른 scenario의 결과 규칙 강제 |

간단한 비유로, RUN은 “오늘은 어떤 실험 상자를 열까”를 고르는 목록이고, scenario는 실험 방법이 적힌 설명서이며, preset은 “약하게 10초만 해 보기” 같은 조절 다이얼이다. 공통 실행기는 상자를 순서대로 건네줄 뿐, 점수를 매기지 않는다.

## RUN, scenario, preset, dataset, environment

`values/runs/*.yaml`은 삭제하지 않는 실행 진입점이다. RUN은 아래 다섯 가지를 한 번에 고른다.

```yaml
run:
  scenario: ../scenarios/service-static-replica-capacity-load-test.yaml
  preset: ../presets/service-static-replica-capacity-load-test/local-smoke-1day-low-rps.yaml
  dataset: ../datasets/smoke-1day.yaml
  environment: ../environments/local.yaml
  deployment:
    replicas: 1
```

- `scenario`는 9개 서비스의 순서, `workloads/<service>.js`가 지켜야 할 API/fixture 계약, static 또는 ramp 규칙, endpoint별 SLO와 최종 보고서 형식을 가진다.
- `preset`은 여러 RUN에서 다시 쓸 수 있는 조건 묶음이다. 예를 들어 `local-smoke-1day-low-rps`는 짧은 warmup·duration, 낮은 RPS, 1 replica, `smoke-1day` profile에 맞는 조건을 가진다.
- `dataset`은 데이터 양과 fixture pool의 단일 원본이다. scenario의 데이터 내용을 복제하지 않는다.
- `environment`는 기존 dev Helm layered values와 namespace, 이미 준비된 fixture/관측성 연결을 가리킨다.
- RUN의 `deployment.replicas`는 실제 적용할 replica 수다. preset의 replica 조건과 맞아야 하며, RUN은 어떤 조건을 어느 환경에서 실행할지 고른다.

`task loadtest:run`은 로컬 RUN이면 먼저 해당 RUN의 Dataset/k6 입력 Secret과 loadtest 전용 이미지를 준비하고, 검증 뒤 공통 실행기를 호출한다. 사용자는 이 명령 하나만 실행하면 된다. 이 준비 단계는 공통 실행기에 넣지 않으므로 scenario/preset/dataset의 뜻을 Taskfile에 다시 구현하지 않는다.

```bash
task loadtest:run RUN=local-smoke-1day-static-replicas-1 SERVICE=all
task loadtest:run RUN=local-smoke-1day-ramp-replicas-1 SERVICE=all
task loadtest:run RUN=local-bottleneck-ramp-replicas-1 SERVICE=catalog-service
```

## 두 scenario

### Static replica capacity

`service-static-replica-capacity-load-test`는 지정한 replica 수에서 서비스별 안전 처리량을 찾는다. 후보마다 `constant-arrival-rate`를 독립 실행하고, 필요한 경우 confirmation을 거쳐 마지막 통과와 첫 실패를 기록한다. Dataset Job은 후보마다 다시 만들지 않고 서비스 시작 전에 한 번만 준비한다.

### Bottleneck ramp

`service-bottleneck-ramp-load-test`는 replica 1개와 `baseline-90days` 조건에서 서비스당 하나의 `ramping-arrival-rate` k6 Job을 실행한다. 최근 rolling window만 보고 실제 RPS, 오류율, check, p95, p99를 평가한다. RUN이 정한 횟수만큼 연속 위반하면 조기 종료하고 마지막 healthy RPS, 첫 degraded RPS, 중단 이유를 scenario 전용 결과에 남긴다. 이 경우는 실험이 의도대로 병목을 찾은 것이므로 실행 실패가 아니다.

두 scenario 모두 서비스는 순차 실행한다. static의 adaptive search와 ramp의 rolling window는 서로 다른 실험이므로 공통 실행기에서 하나의 큰 분기로 섞지 않는다.

## 서비스 배포와 fixture

서비스 이미지, 환경 변수, 운영 Secret, migration, 기본 dev 설정은 기존 `task dev`와 GitOps dev Helm chart가 책임진다. `task loadtest:run`은 서비스를 전체 배포하지 않는다. 이미 준비된 로컬 dev 서비스가 있는지 확인한 뒤, 기존 layered values로 chart를 다시 적용할 때 `deployment.replicas`만 임시 override하고 종료 때 같은 chart와 layered values를 override 없이 다시 적용한다.

HPA 또는 KEDA가 있는 서비스는 1 replica 측정에 필요한 최소 override와 원복 조건을 environment/service 설정에 명시해야 한다. 명시되지 않은 autoscaler가 replica 측정을 방해하면 `replica_deploy` 실패로 남긴다.

fixture manifest는 이미 준비된 데이터의 ID와 계정 참조를 담은 목록이다. 예를 들어 “이 사용자 ID로 요청을 보낸다”는 힌트이며 비밀번호나 token 자체가 아니다. 반면 Dataset/k6 입력 Secret은 Dataset Job의 DB 접속 정보, 로그인 비밀번호, coupon code 파일처럼 Job이 실제로 쓰는 개발용 입력이다. 로컬 RUN에서는 `task loadtest:run`이 이 입력을 RUN의 profile·seed와 맞춰 만들고 같은 로컬 namespace에서 참조한다. 인증이 필요한 서비스는 Dataset Job이 fixture를 만든 직후 Auth 개발 API에 fixture `userId` 배열을 보내고, 그 응답 token만 별도 read-only k6 Secret 파일로 준비한다. 서비스 운영 Secret을 복사하거나 서비스 설정을 바꾸지는 않는다.

## 관측성과 결과

별도 resource collector Job, collector 전용 RBAC, start barrier, raw resource JSONL은 사용하지 않는다. k6가 끝난 뒤 공통 실행기가 시작·종료 시각, 서비스, namespace, replica, run ID만 observability adapter에 전달한다. adapter는 GitOps가 이미 수집하는 관측성 원본을 읽기 전용으로 한 번 조회해 raw snapshot을 돌려준다.

PromQL과 “CPU를 어떤 의미로 볼지”는 scenario의 metric specification에 있고, 공통 실행기에는 들어가지 않는다. 조회가 실패하거나 metric이 없으면 `null`과 `unavailable`, 정제된 이유를 기록한다. 이 경우 k6 HTTP 결과가 성공했다면 자동으로 성능 실패가 되지 않는다.

scenario report는 endpoint tag가 붙은 k6 summary와 raw snapshot을 합친다. API와 서비스 관측성은 서로 다른 층에 둔다. CPU가 특정 API 하나의 수치라고 단정하지 않기 때문이다.

```json
{
  "apis": {
    "GET /api/v1/products": {
      "requests": 120,
      "actual_rps": 12,
      "error_rate": 0,
      "checks_rate": 1,
      "p50_ms": 20,
      "p95_ms": 45,
      "p99_ms": 70
    }
  },
  "observability": {
    "status": "available",
    "service": {
      "cpu_utilization": 31.4,
      "memory_utilization": 42.1,
      "pod_restarts": 0
    }
  }
}
```

위 예에서 `pod_restarts: 0`은 실제로 0번 재시작한 값이다. 반대로 수집하지 못했다면 `pod_restarts: null`과 `status: "unavailable"`로 남긴다. 0과 “모름”을 섞지 않는다.

`result.json`의 전체 형식과 합격·불합격은 각 scenario의 `report.js`가 소유한다. 공통 실행기는 raw k6 summary, artifact 경로, run metadata, observability snapshot을 넘길 뿐이다.

## Dataset Job과 로컬 snapshot cache

Dataset Job은 서비스별로 한 번만 실행하며, `plans.js`가 허용한 테이블만 준비한다. `alembic_version`, `goose_db_version`, `*_goose_db_version`, Auth 정책·설정 테이블, 운영 메타데이터는 truncate하지 않는다.

`tmp/datasets/<cache-key>/`의 로컬 binary snapshot cache는 bulk 데이터 생성과 PostgreSQL COPY 시간을 줄이기 위해 유지한다. cache key는 dataset 조건, generator, 관련 schema/migration 식별자와 PostgreSQL 호환 조건을 묶는다. cache hit라도 manifest, checksum, schema와 row 계약을 확인한 뒤에만 복원한다.

cache는 서비스 배포나 이미지 준비를 대신하지 않으며 Secret을 보관하지 않는다. 비밀번호, token, cookie, Authorization 값, coupon 평문은 cache, manifest, artifact, `result.json`, 로그에 쓰지 않는다.

## 1일 저부하 smoke

다음 파일은 전체 서비스 순차 실행 경로를 빠르게 점검하는 선언 파일이다.

- dataset: `values/datasets/smoke-1day.yaml`
- static preset: `values/presets/service-static-replica-capacity-load-test/local-smoke-1day-low-rps.yaml`
- ramp preset: `values/presets/service-bottleneck-ramp-load-test/local-smoke-1day-low-rps.yaml`
- RUN: `values/runs/local-smoke-1day-static-replicas-1.yaml`, `values/runs/local-smoke-1day-ramp-replicas-1.yaml`

목표는 한계 처리량 탐색이 아니라 Dataset Job, fixture, endpoint별 k6 결과, observability 병합, report 생성을 확인하는 것이다. 1일 데이터와 매우 낮은 RPS, 짧은 warmup·측정 시간을 사용한다.

전체 smoke는 Kubernetes Dataset Job, k6 Job, 기존 dev release의 replica 적용·원복이 필요하다. 따라서 Docker만으로는 전체 서비스를 실행할 수 없다. Kubernetes에 대한 create/apply/delete/scale/patch/exec가 금지된 환경에서는 이 RUN을 실행하지 않고, Docker 기반 데이터셋 테스트와 정적 검증만 수행한다.

## 검증 범위

`npm run check`, 순수 Node 테스트, Docker 기반 `npm test`, Helm lint/template, 모든 workload의 `k6 inspect`는 코드와 선언의 계약을 확인한다. 이 검증은 원격 Kubernetes, 실제 dev/production 서비스, 실제 Secret을 변경하지 않는다. 실제 cluster 실행은 허용된 환경에서 별도로 수행해야 한다.
