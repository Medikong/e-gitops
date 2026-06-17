# Read API loadtest

`platform/loadtest`는 Medikong 공개 조회 API 기준선을 k6로 측정하는 별도 runner다.
`platform/synthetic`은 낮은 트래픽의 해피패스 검증만 맡고, 이 chart는 VU, duration, threshold를 조절하는 부하테스트만 맡는다.

## Scenario

`read-api-baseline`은 read-only 요청만 실행한다.

```text
GET /concerts
GET /concerts/{id}/performances
GET /performances/{id}/seats
```

목록 응답은 `items` 배열을 기준으로 읽고, VU/iteration 값으로 concert와 performance를 고른다.
좌석 예약, 결제, 티켓 발급 같은 write path는 실행하지 않는다.

`reservation-journey-load-test`는 write path를 포함하는 별도 시나리오다.
synthetic E2E처럼 해피패스를 확인하지만 목적은 낮은 트래픽 생존성 확인이 아니라 VU를 단계적으로 올려 예매 과정의 첫 병목을 찾는 것이다.
실행 전 `setup()`에서 customer pool 계정을 미리 로그인해 customer별 access token을 준비하고, 측정 구간은 앱 안에서 이미 로그인된 사용자가 예매를 진행하는 모델로 본다.
auth-service access token 기본 TTL은 900초이므로, 현재 구현은 15분 이내 실행을 전제로 한다.
더 긴 실험은 setup 토큰 재사용이 아니라 별도 refresh 설계가 필요하다.

```text
setup/pre-login: POST /auth/login
measure: GET /concerts
measure: GET /concerts/{id}/performances
measure: GET /performances/{id}/seats
measure: POST /reservations
measure: POST /payments
measure: GET /tickets/me
```

기본 좌석 선택은 dataset concert 안에서 run id 기반으로 분산한다.
좌석 경쟁 자체를 확인하는 실험은 별도 시나리오로 둔다.
`reservation_id`, `payment_id`, `ticket_id` 같은 동적 ID는 metric label/tag가 아니라 JSON 로그 필드에만 남긴다.
단계별 latency는 본 실행 step tag가 붙은 `http_req_duration`으로 보고, setup/pre-login은 step-level threshold와 `loadtest_api_summary` 대상에서 제외한다.
예매 성공률, 409 비율, 티켓 발급률은 custom metric threshold로 본다.

`setup-read-dataset`은 부하테스트용 fake read dataset을 준비한다.
이 시나리오는 provider/admin write API를 사용하므로 read baseline 결과와 섞지 않는다.
생성 대상은 `dataset.profile`, `dataset.revision`, 수량 값으로 조절한다.
`flows/dataset.js`는 profile registry만 담당하고, 실제 데이터셋 구성은 `flows/datasets/<profile>.js`가 소유한다.
새 케이스가 필요하면 profile 파일을 추가하고 registry에 등록한다.

`reservation-journey` profile은 예매 과정 부하테스트 전용 dataset이다.
`POST /auth/signup` 제품 API로 fresh customer pool을 먼저 만들고, 이미 존재하는 계정은 409를 허용한 뒤 login으로 검증한다.
계정 email은 `loadtest-<revision>-000001@loadtest.medikong.local`처럼 결정적으로 만들며, 같은 revision 재실행은 같은 계정을 검증하고 새 revision은 fresh pool을 만든다.
공연/회차/좌석은 read baseline과 같은 생성 패턴을 쓰지만 `dataset.profile=reservation-journey` prefix로 분리된다.

예를 들어 공연 수를 넓게 퍼뜨리는 `read-api-wide`, 좌석 맵이 큰 `large-seat-map`, 공연 회차가 많은 `many-performances` 같은 profile을 추가할 수 있다.
이때 `setup-read-dataset` scenario, Helm template, CronJob, GitOps manualRuns는 바꾸지 않고 `dataset.profile` 값만 바꿔 실행한다.

```text
provider/admin login
customer pool signup 또는 login 검증
venue 생성
concert N개 생성 또는 기존 공개 dataset 재사용
concert별 performance M개 보강
performance별 seat map 생성
sale policy 승인
open schedule 설정
public read API 검증
```

## Collection decision

현재 GitOps 모니터링 스택은 Prometheus remote write receiver를 열지 않는다.
OpenTelemetry Collector는 Kubernetes stdout/stderr를 `filelog` receiver로 읽고 JSON body를 파싱해 Loki로 보낸다.

그래서 loadtest runner는 Loki client를 직접 쓰지 않는다.
k6 실행 로그와 `handleSummary` 결과를 stdout JSON line으로 남기고, Collector가 기존 경로로 수집한다.
구분 필드는 `test_type=loadtest`, scenario 이름, `step`이고, chart label과 namespace도 synthetic과 분리한다.

실험 조건은 실행 시점에 `loadtest_experiment_conditions` 이벤트로 별도 기록한다.
이 이벤트에는 `environment`, `target`, `target_base_url`, `scenario`, `vus`, `duration`, threshold, dataset profile/revision, 계산된 dataset 총량, runner image tag, `revision`이 들어간다.
발표 자료나 회고에서는 Grafana time range와 이 이벤트를 함께 보고 같은 조건을 다시 재현한다.

## Scenario conditions

실행 공통 조건과 실험 조건은 분리한다.
`loadtest`는 scenario 선택, target, base URL, image revision처럼 모든 실행에 필요한 값만 둔다.
실험 조건은 파일과 values key를 시나리오별로 둔다.

```text
lib/config/common.js
lib/config/dataset.js
lib/config/scenarios/read-api-baseline.js
lib/config/scenarios/reservation-journey.js
values/scenarios/setup-read-dataset.yaml
values/scenarios/read-api-baseline.yaml
values/scenarios/reservation-journey-load-test.yaml
```

조회 기준선의 VU, duration, stages, read limit, threshold는 `scenarios.readApiBaseline`에서만 조절한다.
예매 여정의 executor, rate, VU 한도, duration, stages, polling, 결제 금액, 좌석 재시도, threshold는 `scenarios.reservationJourney`에서만 조절한다.
dataset setup 조건은 `dataset` 아래에 두고, fresh pool은 `dataset.revision` 또는 `dataset.customerPool.revision`으로 분리한다.

## Commands

운영에서는 command로 Job을 만들지 않는다.
aws-dev는 GitOps sync와 Kubernetes CronJob이 dataset 준비와 read baseline 실행을 관리한다.
수동 실행도 `kubectl create job`이 아니라 `manualRuns.*.enabled`와 `manualRuns.*.runId` 값을 GitOps로 바꿔 선언한다.

로컬에서는 개발 편의를 위해 Taskfile 명령으로 직접 실행한다.
`dev:loadtest`는 로컬 registry, Secret, image, Helm release를 준비한 뒤 dataset setup과 선택한 시나리오를 순차 실행한다.
기본 실행은 Job 완료만 기다리고 runner 로그를 follow하지 않는다.
실행 중 로그가 필요하면 별도 터미널에서 `task --dir gitops/platform/loadtest logs`를 사용한다.
배포만 필요하면 `dev:loadtest:deploy`를 사용한다.
k6를 로컬 프로세스로 바로 실행할 때는 `local-report`를 사용한다.
실행 결과는 gitignore 되는 `reports/local/{run_id}/`에 `metadata.json`, `summary.json`, `report.html`, `report.md`로 남고, `reports/local/latest`가 최근 결과를 가리킨다.
`run_id`는 UTC timestamp, scenario, short git SHA로 만든다.
이 값은 artifact, metadata, log에서만 쓰고 Prometheus metric label/tag에는 넣지 않는다.
S3 업로드와 AWS 장기 보관은 이번 단계에 포함하지 않는다.
공개 concert ingress는 Kong rate limit이 `minute: 120`으로 설정되어 있으므로, 기본 local/aws-dev values는 `thinkTimeSeconds`를 둬 한도 안에서 기준선을 확인한다.
예매 여정 부하테스트는 한계 지점을 보기 위해 `thinkTimeSeconds: 0`과 k6 `ramping-arrival-rate`를 사용한다.
이때 `stages[].target`은 HTTP RPS가 아니라 초당 예매 여정 시작 수다.
한 예매 여정은 이미 로그인된 사용자 기준 공연/회차/좌석 조회, 예약 생성, 결제 승인, 티켓 조회를 포함하므로 실제 HTTP RPS는 target보다 크다.
로컬에서 `reservation-journey-load-test`를 실행하면 기본적으로 `ticketing-rate-limit-*` Kong plugin의 `minute` 값을 크게 올리고, 명령 종료 시 기본값 `120`으로 되돌린다.
Kong rate limit을 포함한 제품 경로 기준선을 보려면 `LOADTEST_DISABLE_KONG_RATE_LIMIT=false`를 명시한다.

```bash
SCENARIO=read-api-baseline task --dir gitops dev:loadtest
SCENARIO=reservation-journey-load-test task --dir gitops dev:loadtest
LOADTEST_DISABLE_KONG_RATE_LIMIT=false SCENARIO=reservation-journey-load-test task --dir gitops dev:loadtest

task --dir gitops/platform/loadtest lint
task --dir gitops/platform/loadtest render
LOADTEST_VALUES_FILE=values/aws-dev.yaml task --dir gitops/platform/loadtest render
LOADTEST_SCENARIO_VALUES_FILE=values/scenarios/reservation-journey-load-test.yaml task --dir gitops/platform/loadtest render
task --dir gitops/platform/loadtest local-report LOADTEST_BASE_URL=http://localhost LOADTEST_VUS=5 LOADTEST_DURATION=1m
task --dir gitops/platform/loadtest local-report-smoke
SCENARIO=reservation-journey-load-test task --dir gitops/platform/loadtest run-local
LOADTEST_DISABLE_KONG_RATE_LIMIT=false SCENARIO=reservation-journey-load-test task --dir gitops/platform/loadtest run-local
task --dir gitops/platform/loadtest kong-rate-limit:status
task --dir gitops/platform/loadtest kong-rate-limit:restore
task --dir gitops/platform/loadtest deploy
task --dir gitops/platform/loadtest setup-dataset
task --dir gitops/platform/loadtest run
task --dir gitops/platform/loadtest logs
task --dir gitops/platform/loadtest status
```

로컬 root task 기준:

```bash
task --dir gitops dev:loadtest
task --dir gitops dev:loadtest:deploy
task --dir gitops dev:loadtest:setup-dataset
task --dir gitops dev:loadtest:run
```

`values/aws-dev.yaml`은 기본으로 dataset CronJob과 read baseline CronJob을 켠다.
dataset은 `5 */6 * * *`, read baseline은 `20 */6 * * *`에 실행해 같은 주기 안에서 dataset 준비가 먼저 끝나도록 둔다.
Argo sync 때도 `syncJobs.dataset`이 먼저 실행되고, `syncJobs.read`가 뒤따른다.

GitOps 관리형 수동 dataset setup 예시:

```yaml
manualRuns:
  dataset:
    enabled: true
    runId: dataset-20260615-001
```

GitOps 관리형 수동 read baseline 예시:

```yaml
manualRuns:
  read:
    enabled: true
    runId: read-20260615-001
```

같은 수동 Job을 다시 만들려면 `runId`를 새 값으로 바꾼다.
`reservation-journey-load-test` 실행 예시:

```yaml
loadtest:
  scenario: reservation-journey-load-test
dataset:
  profile: reservation-journey
  revision: reservation-20260615-001
  customerPool:
    size: 100
    revision: reservation-20260615-001
scenarios:
  reservationJourney:
    executor: ramping-arrival-rate
    requestPrefix: loadtest-reservation
    rate: 1
    timeUnit: 1s
    preAllocatedVUs: 20
    maxVUs: 100
    stages:
      - duration: 2m
        target: 2
      - duration: 2m
        target: 5
      - duration: 2m
        target: 10
```

dataset setup에는 `LOADTEST_PROVIDER_EMAIL`, `LOADTEST_PROVIDER_PASSWORD`, `LOADTEST_ADMIN_EMAIL`, `LOADTEST_ADMIN_PASSWORD`를 가진 `dataset.credentialsSecretName` Secret이 필요하다.
reservation journey 본 실행은 signup을 측정 구간에 포함하지 않는다.
실행 전에 `dataset.profile=reservation-journey`로 dataset setup을 돌려 customer pool과 예매용 공연/회차/좌석을 준비한다.
fresh pool을 만들려면 `dataset.revision` 또는 `dataset.customerPool.revision`을 새 값으로 바꾼다.
본 실행의 `setup()`은 `LOADTEST_CUSTOMER_POOL_*` 값으로 계정을 계산해 customer pool을 미리 로그인하고, `{ customerIndex, customerId, accessToken }` 토큰 목록만 VU에 넘긴다.
default 함수는 `customerPoolIndexForIteration(config, __VU, __ITER)`로 같은 index의 토큰을 골라 예매 API 인증 헤더에만 사용한다.
측정 루프는 `catalog.select_seat -> reservation.create -> payment.approve -> ticket.wait` 순서이며 매 iteration마다 새 `POST /auth/login`을 호출하지 않는다.
metric tag에는 customer email, user id, reservation id, payment id, ticket id를 넣지 않고, email, password, raw token은 JSON 로그에도 남기지 않는다.
