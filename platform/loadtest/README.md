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
실행 전 `setup()`에서 `loadtest_run_id` 기반 dataset revision으로 공연/회차/좌석과 customer pool을 새로 만들고, 실제 부하에 참여할 customer의 access token을 준비한다.
측정 구간은 앱 안에서 이미 로그인된 사용자가 예매를 진행하는 모델로 본다.
auth-service access token 기본 TTL은 900초이므로, 현재 구현은 15분 이내 실행을 전제로 한다.
더 긴 실험은 setup 토큰 재사용이 아니라 별도 refresh 설계가 필요하다.

```text
setup/dataset: provider/admin login, concert/performance/seat 생성 또는 검증
setup/account-pool: POST /auth/signup 또는 POST /auth/login 검증
setup/pre-login: active customer token 준비
measure: GET /concerts
measure: GET /concerts/{id}/performances
measure: GET /performances/{id}/seats
measure: POST /reservations
measure: POST /payments
measure: GET /tickets/me?limit=...&cursor=...
```

기본 좌석 선택은 dataset concert 안에서 run id 기반으로 분산한다.
좌석 경쟁 자체를 확인하는 실험은 별도 시나리오로 둔다.
`reservation_id`, `payment_id`, `ticket_id` 같은 동적 ID는 metric label/tag가 아니라 JSON 로그 필드에만 남긴다.
단계별 latency는 본 실행 step tag가 붙은 `http_req_duration`으로 보고, setup/pre-login은 run report의 `api_step_results` 대상에서 제외한다.
예매 성공률, 409 비율, 티켓 발급률은 custom metric threshold로 본다.

`reservation-create-load-test`는 예약 생성 경로만 분리한 R2 시나리오다.
충분한 좌석 풀과 customer 분산으로 정상 생성 기준선을 측정한다.
실행 전 `setup()`에서 `loadtest_run_id`를 붙인 dataset revision으로 공연/회차/좌석과 customer pool을 새로 만들기 때문에 이전 실험의 예약 데이터와 섞이지 않는다.

```text
setup/dataset: provider/admin login, 충분한 concert/performance/seat 생성
setup/account-pool: POST /auth/signup 또는 POST /auth/login 검증
setup/pre-login: active customer token 준비
measure: GET /concerts
measure: GET /concerts/{id}/performances
measure: GET /performances/{id}/seats
measure: POST /reservations
```

분석 기준은 `reservation_create.reservation.create`의 p95/p99, RPS, request count, 201/409/5xx/timeout rate/count다.
R2에서 409는 낮아야 하며, 409가 늘면 좌석 풀 분산이나 좌석 선택 로직보다 reservation-service의 중복 예약 방지 경계와 DB transaction 시간을 먼저 본다.
주요 병목 후보는 DB connection pool 대기, transaction 시간 증가, slow query, row lock/unique constraint 대기, reservation-service CPU/memory, HPA 반응 지연이다.

`reservation-seat-contention-load-test`는 좌석 경합을 의도적으로 만드는 R3 시나리오다.
같은 showtime의 작은 seat candidate pool에 여러 VU가 몰리게 하며, 409는 정상 business conflict로 분리해 보고 5xx/timeout/deadlock만 장애로 본다.
이 시나리오도 `setup()`에서 `LOADTEST_RUN_ID` 기반 revision을 만들고, 작은 좌석 수와 충분한 customer pool을 같은 실행 단위로 준비한다.

```text
setup/dataset: 작은 concert/performance/seat candidate pool 생성
setup/account-pool: POST /auth/signup 또는 POST /auth/login 검증
setup/pre-login: active customer token 준비
measure: GET /concerts
measure: GET /concerts/{id}/performances
measure: GET /performances/{id}/seats
measure: POST /reservations
```

R3 결과는 `reservation_seat_contention.reservation.create`의 201/409/5xx/timeout 비율을 먼저 본다.
성공 예약 수는 `reservation_create_201_count`, 좌석 수는 `loadtest_experiment_conditions.dataset_seats_per_performance`와 `seat_candidate_count`, 개별 성공 로그는 `loadtest_run_finished.seat_id/reservation_id`로 대조한다.
성공 예약 수가 후보 좌석 수보다 커지면 중복 예약 방지 결함을 의심한다.
409가 늘면서 5xx/timeout이 낮으면 정상 경합으로 보고, 5xx/timeout/deadlock이 늘면 DB lock, transaction isolation, unique constraint 처리, pool exhaustion, HPA/CPU/memory를 확인한다.

`auth-login-load-test`는 `/auth/login` 병목만 분리해서 보는 시나리오다.
실행 전 setup 단계에서 customer pool을 `POST /auth/signup`으로 만들거나 409 재사용을 허용한 뒤 login으로 검증한다.
측정 구간의 반복 루프는 `POST /auth/login`만 호출하고, `loadtest_run_report.api_step_results`에는 `auth_login.login` 결과만 남긴다.
email, password, token 값은 JSON 로그나 metric tag에 남기지 않고, 계정 pool 식별은 revision과 count 조건으로만 관리한다.
기본 scenario values는 빠른 임계점 탐색용으로 30초 단위 3단계 ramp-up을 사용한다.

```text
setup: POST /auth/signup 또는 POST /auth/login 검증
measure: POST /auth/login, 30s@60/s -> 30s@90/s -> 30s@120/s
```

`ticket-service-read-load-test`는 ticket-service read path만 분리해서 보는 시나리오다.
reservation journey 전체 병목을 다시 재는 시나리오가 아니며, 예매/결제/티켓 발급 write flow를 측정 구간에 섞지 않는다.
setup 단계에서 run id 기반 customer pool을 만들고 `/tickets/issue`로 customer별 ticket 목록을 준비한 뒤, 측정 구간에서는 `/tickets/me`만 호출한다.
setup에서 쓰는 email/password/raw token은 JSON 로그나 metric tag에 남기지 않고, 동적 reservation/ticket id는 JSON 로그 field에만 남긴다.

```text
setup/account-pool: POST /auth/signup 또는 POST /auth/login 검증
setup/ticket-dataset: POST /tickets/issue로 customer별 ticket 목록 준비
measure: ticket-list, GET /tickets/me 첫 페이지
measure: ticket-list-pagination, nextCursor로 여러 페이지 조회
measure: ticket-wait-by-list, 특정 reservationId의 ticket을 목록 pagination으로 찾기
```

분석 기준은 `loadtest_run_report.api_step_results`의 `ticket-list`, `ticket-list-pagination`, `ticket-wait-by-list` 행이다.
각 행에서 p50/p95/p99, error rate, `http_reqs_rate`, `rps`, request count를 비교한다.
RPS, duration, VU, local/cluster 차이는 scenario 코드가 아니라 `values/scenarios/ticket-service-read-load-test.yaml` 또는 `values/presets/ticket-service-read/*.yaml`에서 조절한다.

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
이때 `setup-read-dataset` scenario, Helm template, GitOps manualRuns는 바꾸지 않고 `dataset.profile` 값만 바꿔 실행한다.

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

실험 결과는 `loadtest_run_report` JSON line 하나를 단일 결과로 보고, 호환용 전체 요약은 `loadtest_summary` JSON line으로 함께 남긴다.
요청 처리량은 기존 k6 이름인 `http_reqs_rate`와 사람이 읽기 쉬운 별칭인 `rps`를 함께 기록한다.
API별 처리량 비교에서는 `loadtest_run_report.api_step_results[].rps`를 보고, 전체 실행 처리량은 `loadtest_run_report.rps`를 본다.
레이턴시는 일반적인 사용자 체감에 가까운 p50과 tail latency를 보는 p95/p99를 함께 기록한다.
전체 실행은 `loadtest_run_report.http_req_duration_p50_ms`와 `loadtest_summary.http_req_duration_p50_ms`, API step별 결과는 `loadtest_run_report.api_step_results[].http_req_duration_p50_ms`를 본다.
시나리오별 판단은 `loadtest_run_report.scenario_report`에 둔다.
기존 top-level 필드와 `api_step_results`는 대시보드 호환을 위해 유지하고, stress 한계 탐색처럼 추가 판단이 필요한 값만 `scenario_report`에 확장한다.

`mau10k-normal-peak`와 `mau10k-ticket-open`은 기준선 비교용이고, `stress-find-limit`는 한계 후보를 찾기 위한 실행이다.
`stress-find-limit` 결과는 `scenario_report.stage_results`에서 `5 journey/s`, `10 journey/s`, `20 journey/s`별 p95/p99, error rate, reservation 5xx/timeout을 본다.
`409 reservation.conflict`는 정상 경합으로 보고 한계 후보에서 제외한다.
`scenario_report.first_limit_candidate`가 있으면 첫 후보 stage의 `limit_reasons`를 우선 확인하고, `scale_out_results`의 `hpa_decision_seconds`, `scale_out_ready_seconds`로 HPA 반응 지연을 함께 본다.

## Scenario conditions

실행 공통 조건과 실험 조건은 분리한다.
`loadtest`는 scenario 선택, target, base URL, image revision처럼 모든 실행에 필요한 값만 둔다.
실험 조건은 파일과 values key를 시나리오별로 둔다.

```text
lib/config/common.js
lib/config/dataset.js
lib/config/scenarios/read-api-baseline.js
lib/config/scenarios/reservation-journey.js
lib/config/scenarios/reservation-load.js
lib/config/scenarios/ticket-service-read.js
values/scenarios/setup-read-dataset.yaml
values/scenarios/read-api-baseline.yaml
values/scenarios/auth-login-load-test.yaml
values/scenarios/ticket-service-read-load-test.yaml
values/scenarios/reservation-journey-load-test.yaml
values/scenarios/reservation-create-load-test.yaml
values/scenarios/reservation-seat-contention-load-test.yaml
```

조회 기준선의 VU, duration, stages, read limit, threshold는 `scenarios.readApiBaseline`에서만 조절한다.
auth login의 executor, rate, VU 한도, duration, stages, threshold는 `scenarios.authLogin`에서만 조절한다.
ticket-service read의 executor, rate, VU 한도, duration, ticket list limit, pagination page depth, wait target ticket position, customer별 ticket 수, active customer 수, threshold는 `scenarios.ticketServiceRead`에서만 조절한다.
예매 여정의 executor, rate, VU 한도, duration, stages, polling, ticket list page 범위, active customer 수, 결제 금액, 좌석 재시도, threshold는 `scenarios.reservationJourney`에서만 조절한다.
예약 생성 기준선의 executor, rate, VU 한도, duration, stages, active customer 수, 좌석 재시도, seat candidate 수, threshold는 `scenarios.reservationCreate`에서만 조절한다.
좌석 경합의 executor, rate, VU 한도, duration, stages, active customer 수, seat candidate 수, threshold는 `scenarios.reservationSeatContention`에서만 조절한다.
dataset setup 조건은 `dataset` 아래에 두고, fresh pool은 `dataset.revision` 또는 `dataset.customerPool.revision`으로 분리한다.
`trafficModel`은 실행값을 만든 사업/트래픽 가정을 기록한다. k6 실행은 선택한 scenario key의 값을 사용하고, `trafficModel`은 `loadtest_experiment_conditions`에 함께 남겨 나중에 같은 프리셋끼리 비교한다.
프리셋 파일은 `values/presets/<scenario-family>/<preset>.yaml`에 둔다. scenario 파일은 실행 script의 기본 조건이고, preset 파일은 같은 script에 얹는 실험 조건이다.

## Reservation Journey Presets

예매 여정 프리셋은 모두 같은 k6 script인 `reservation-journey-load-test`를 실행한다.
실행할 때는 파일 경로가 아니라 `PRESET=<name>`으로 선택한다.
preset values 파일은 `values/presets/reservation-journey/` 아래에 두고, values 안의 `loadtest.scenario`는 실제 script 이름으로 고정한다.

```text
values/presets/reservation-journey/local-ticket-open-5m.yaml
values/presets/reservation-journey/aws-dev-smoke-1m.yaml
values/presets/reservation-journey/mau10k-normal-peak.yaml
values/presets/reservation-journey/mau10k-ticket-open.yaml
values/presets/reservation-journey/mau10k-ticket-open-aggressive.yaml
values/presets/reservation-journey/stress-find-limit.yaml
values/presets/reservation-create/mau10k-normal-peak.yaml
values/presets/reservation-create/mau10k-ticket-open.yaml
values/presets/reservation-seat-contention/mau10k-ticket-open.yaml
values/presets/reservation-seat-contention/stress-find-limit.yaml
values/presets/ticket-service-read/local-ticket-read-smoke.yaml
```

`mau10k-normal-peak`는 MAU 1만, DAU/MAU 20%, DAU의 30%가 피크 1시간에 분산되는 일반 피크를 가정한다.
계산값은 약 `0.17 journey/s`이고 safety factor 3을 적용해 `0.5 journey/s`로 실행한다.

`local-ticket-open-5m`은 로컬 재검증용이다.
MAU 1만 티켓 오픈 가정을 5분 동안 `2 journey/s`로 짧게 실행해 ticket-service tail latency와 관측계 부담을 함께 확인한다.

`aws-dev-smoke-1m`은 aws-dev에서 runner, credential, dataset setup, 예매 여정, 자동 보고서 경로만 빠르게 확인하는 1분 smoke다.
`1 journey/s`로 1분만 실행하므로 용량 판단에는 쓰지 않는다.

`mau10k-ticket-open`은 MAU 1만, DAU/MAU 20%, DAU의 30%가 티켓 오픈 10분 안에 몰리는 상황을 가정한다.
계산값은 `1 journey/s`이고 safety factor 2를 적용해 `2 journey/s`로 실행한다.

`mau10k-ticket-open-aggressive`는 DAU/MAU 30%, DAU의 50%가 10분 안에 몰리는 더 공격적인 오픈런을 가정한다.
계산값은 `2.5 journey/s`이고 safety factor 2를 적용해 `5 journey/s`로 실행한다.

`stress-find-limit`는 MAU 모델 검증이 아니라 한계 탐색용이다.
`5 -> 10 -> 20 journey/s` ramping-arrival-rate로 병목 위치를 찾는다.

프리셋의 기준 식은 다음과 같다.

```text
DAU = MAU * stickiness
raw journey/s = DAU * peakParticipationRate * journeysPerUser / (peakWindowMinutes * 60)
실행 journey/s = raw journey/s * safetyFactor
activeCustomerCount >= ceil(expectedJourneys / targetTicketsPerCustomer)
```

현재 기본 목표는 계정당 ticket을 대략 100건 안쪽으로 유지하는 것이다.
따라서 duration이나 arrival rate를 키우면 `activeCustomerCount`와 `customerPool.size`도 같이 키운다.

## Commands

운영에서는 배포나 sync만으로 부하테스트를 자동 실행하지 않는다.
aws-dev chart는 CronJob을 만들지 않는다.
실험할 때만 `manualRuns.*.runId` 값을 GitOps로 바꿔 Argo Hook Job을 한 번 실행한다.
같은 수동 Job을 다시 만들려면 `runId`를 새 값으로 바꾼다.
Hook Job은 성공하면 ArgoCD가 자동 삭제하고, 실패하면 로그 확인을 위해 남긴다.
runner image는 `.github/workflows/loadtest-image-publish.yml`이 ECR에 publish하고, `values/aws-dev.yaml`의 `image.tag`를 commit SHA 기반 tag로 갱신한다.

로컬에서는 개발 편의를 위해 Taskfile 명령으로 직접 실행한다.
`dev:loadtest`는 로컬 registry, Secret, image, Helm release를 준비한 뒤 dataset setup과 선택한 시나리오를 순차 실행한다.
기본 실행은 Job 완료만 기다리고 runner 로그를 follow하지 않는다.
실행 중 로그가 필요하면 별도 터미널에서 `task --dir gitops/platform/loadtest logs`를 사용한다.
배포만 필요하면 `dev:loadtest:deploy`를 사용한다.
실험 결과의 기준은 runner stdout JSON과 Loki/Grafana 조회이며, 로컬 report 파일은 만들지 않는다.
`run_id`는 artifact, metadata, log에서만 쓰고 Prometheus metric label/tag에는 넣지 않는다.
S3 업로드와 AWS 장기 보관은 포함하지 않는다.
공개 concert ingress는 Kong rate limit이 `minute: 120`으로 설정되어 있으므로, 기본 local/aws-dev values는 `thinkTimeSeconds`를 둬 한도 안에서 기준선을 확인한다.
예매 여정 부하테스트는 한계 지점을 보기 위해 `thinkTimeSeconds: 0`과 k6 `ramping-arrival-rate`를 사용한다.
이때 `stages[].target`은 HTTP RPS가 아니라 초당 예매 여정 시작 수다.
한 예매 여정은 이미 로그인된 사용자 기준 공연/회차/좌석 조회, 예약 생성, 결제 승인, 티켓 조회를 포함하므로 실제 HTTP RPS는 target보다 크다.
로컬에서 `reservation-journey-load-test`를 실행하면 기본적으로 `ticketing-rate-limit-*` Kong plugin의 `minute` 값을 크게 올리고, 명령 종료 시 기본값 `120`으로 되돌린다.
Kong rate limit을 포함한 제품 경로 기준선을 보려면 `LOADTEST_DISABLE_KONG_RATE_LIMIT=false`를 명시한다.

```bash
SCENARIO=read-api-baseline task --dir gitops dev:loadtest
SCENARIO=auth-login-load-test task --dir gitops dev:loadtest
SCENARIO=ticket-service-read-load-test task --dir gitops dev:loadtest
SCENARIO=reservation-journey-load-test task --dir gitops dev:loadtest
SCENARIO=reservation-create-load-test task --dir gitops dev:loadtest
SCENARIO=reservation-seat-contention-load-test task --dir gitops dev:loadtest
PRESET=mau10k-ticket-open task --dir gitops dev:loadtest
SCENARIO=reservation-create-load-test PRESET=mau10k-ticket-open task --dir gitops dev:loadtest
SCENARIO=reservation-seat-contention-load-test PRESET=stress-find-limit task --dir gitops dev:loadtest
SCENARIO=ticket-service-read-load-test PRESET=local-ticket-read-smoke task --dir gitops dev:loadtest
LOADTEST_DISABLE_KONG_RATE_LIMIT=false SCENARIO=reservation-journey-load-test task --dir gitops dev:loadtest

task --dir gitops/platform/loadtest lint
task --dir gitops/platform/loadtest render
LOADTEST_VALUES_FILE=values/aws-dev.yaml task --dir gitops/platform/loadtest render
LOADTEST_SCENARIO_VALUES_FILE=values/scenarios/auth-login-load-test.yaml task --dir gitops/platform/loadtest render
LOADTEST_SCENARIO_VALUES_FILE=values/scenarios/ticket-service-read-load-test.yaml task --dir gitops/platform/loadtest render
LOADTEST_SCENARIO_VALUES_FILE=values/scenarios/reservation-journey-load-test.yaml task --dir gitops/platform/loadtest render
LOADTEST_SCENARIO_VALUES_FILE=values/scenarios/reservation-create-load-test.yaml task --dir gitops/platform/loadtest render
LOADTEST_SCENARIO_VALUES_FILE=values/scenarios/reservation-seat-contention-load-test.yaml task --dir gitops/platform/loadtest render
PRESET=mau10k-ticket-open task --dir gitops/platform/loadtest render
PRESET=mau10k-normal-peak SCENARIO=reservation-create-load-test task --dir gitops/platform/loadtest render
PRESET=stress-find-limit SCENARIO=reservation-seat-contention-load-test task --dir gitops/platform/loadtest render
SCENARIO=auth-login-load-test task --dir gitops/platform/loadtest run-local
SCENARIO=ticket-service-read-load-test task --dir gitops/platform/loadtest run-local
SCENARIO=reservation-journey-load-test task --dir gitops/platform/loadtest run-local
SCENARIO=reservation-create-load-test task --dir gitops/platform/loadtest run-local
SCENARIO=reservation-seat-contention-load-test task --dir gitops/platform/loadtest run-local
PRESET=mau10k-ticket-open task --dir gitops/platform/loadtest run-local
SCENARIO=reservation-create-load-test PRESET=mau10k-ticket-open task --dir gitops/platform/loadtest run-local
SCENARIO=reservation-seat-contention-load-test PRESET=stress-find-limit task --dir gitops/platform/loadtest run-local
SCENARIO=ticket-service-read-load-test PRESET=local-ticket-read-smoke task --dir gitops/platform/loadtest run-local
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

`values/aws-dev.yaml`은 CronJob을 만들지 않는다.
부하테스트는 자동 반복 실행하면 결과 해석이 흐려지므로, 실험 조건을 확정한 뒤 `manualRuns.*.runId`로 한 번씩 실행한다.
`enabled`는 이전 값 파일과의 호환성을 위해 남겨두지만, 새 수동 실행은 `runId`만 채우면 된다.
성공한 Hook Job은 ArgoCD가 자동 삭제하므로 실행 후 `enabled: false`로 되돌리는 복구 커밋은 필요 없다.
실험을 더 이상 선언하지 않으려면 `runId: ""`로 비운다.

GitOps 관리형 수동 dataset setup 예시:

```yaml
manualRuns:
  dataset:
    runId: dataset-20260615-001
```

GitOps 관리형 수동 read baseline 예시:

```yaml
manualRuns:
  read:
    runId: read-20260615-001
```

같은 수동 Job을 다시 만들려면 `runId`를 새 값으로 바꾼다. 실패한 Hook Job은 남아 있으므로, 원인을 확인한 뒤 새 `runId`로 재실행한다.
`reservation-journey-load-test` 실행 예시:

```yaml
loadtest:
  scenario: reservation-journey-load-test
  credentialsSecretName: read-api-loadtest-credentials
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
    activeCustomerCount: 100
    ticketListLimit: 20
    ticketListMaxPages: 5
    stages:
      - duration: 2m
        target: 2
      - duration: 2m
        target: 5
      - duration: 2m
        target: 10
```

dataset setup과 reservation journey setup에는 `LOADTEST_PROVIDER_EMAIL`, `LOADTEST_PROVIDER_PASSWORD`, `LOADTEST_ADMIN_EMAIL`, `LOADTEST_ADMIN_PASSWORD`를 가진 Secret이 필요하다.
`reservation-journey-load-test` values는 같은 Secret을 `loadtest.credentialsSecretName`으로도 붙여 본 실행의 setup 단계에서 run-scoped dataset을 만들 수 있게 한다.
reservation journey 본 실행은 signup을 측정 구간에 포함하지 않는다.
실행 전에 `dataset.profile=reservation-journey`로 dataset setup을 돌려 기본 예매용 데이터셋을 준비할 수 있지만, 본 실행의 `setup()`도 `LOADTEST_RUN_ID`를 붙인 revision으로 공연/회차/좌석을 새로 만든다.
본 실행의 `setup()`은 같은 run-scoped revision으로 신규 customer pool도 만들고, `{ customerIndex, customerId, accessToken }` 토큰 목록만 VU에 넘긴다.
`dataset.customerPool.size`는 setup에서 생성 또는 검증하는 전체 계정 수이고, `scenarios.reservationJourney.activeCustomerCount`는 실제 부하에 참여하는 계정 수다.
기본값은 둘 다 100명으로 두어 6분 `5 -> 10 -> 20/s` ramping-arrival-rate 실행에서 계정당 ticket 수가 평균 약 51건 수준이 되게 한다.
더 높은 arrival rate나 긴 duration을 쓰면 `ceil(예상 성공 journey 수 / 계정당 목표 ticket 수)` 기준으로 active customer 수를 같이 늘려 계정당 ticket 수를 대략 100건 안쪽으로 유지한다.
default 함수는 `customerPoolIndexForIteration(config, __VU, __ITER)`로 active customer 범위 안의 토큰을 골라 예매 API 인증 헤더에만 사용한다.
측정 루프는 `catalog.select_seat -> reservation.create -> payment.approve -> ticket.wait` 순서이며 매 iteration마다 새 `POST /auth/login`을 호출하지 않는다.
`ticket.wait`는 `/tickets/me` 전체 목록을 반복 조회하지 않고 `ticketListLimit`와 `ticketListMaxPages`로 제한한 cursor pagination만 사용한다.
metric tag에는 customer email, user id, reservation id, payment id, ticket id를 넣지 않고, email, password, raw token은 JSON 로그에도 남기지 않는다.
