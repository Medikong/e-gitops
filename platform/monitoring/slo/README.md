# DropMong SLI/SLO와 Error Budget 명세

## 상태와 범위

이 명세는 신규 서비스 9개에 공통 HTTP histogram 계약이 적용된 뒤 사용할 운영 계산 기준이다.

```text
auth-service, user-service, catalog-service, coupon-service,
interest-service, order-service, payment-service,
notification-service, dropmong-web
```

각 애플리케이션의 PodMonitor namespace는 각각 `dropmong-auth`, `dropmong-user`,
`dropmong-catalog`, `dropmong-coupon`, `dropmong-interest`, `dropmong-order`,
`dropmong-payment`, `dropmong-notification`, `dropmong-web`이다. Istio sidecar 정적
coverage는 이 9개 쌍을 정확히 포함하고, Coupon은 runtime waiver만 허용한다.

저장소 정적 검증만으로 실제 요청 표본, 30일 달성률, 남은 Error Budget은 알 수 없다. 현재 상태는 **미검증**이며 수집된 요청이 없는 경우 `100% 달성`이나 `예산 전부 남음`으로 표시하지 않는다.

## SLI

가용성 SLI의 eligible event는 `http_route_kind="api"`인 HTTP 요청이다.

```text
good event = eligible request 중 5xx가 아닌 응답
bad event  = eligible request 중 5xx 응답
제외       = health/readiness/metrics/debug probe
```

4xx는 인증 거절, 품절, 중복 요청처럼 의도된 업무 결과일 수 있으므로 가용성 bad event에 합치지 않는다. 대신 Traffic/Errors 화면과 구조화 로그에서 status/error code로 별도 조사한다.

원본 metric 계약:

```text
http_server_request_duration_seconds_count
http_server_request_duration_seconds_bucket

labels
  service_name
  service_version
  service_environment
  http_route
  http_route_kind
  http_request_method
  http_response_status_code
```

요청 ID(`request_id`/`x-request-id`), trace/span ID, 사용자·업무 객체 ID, raw path는
metric label로 사용하지 않는다. ID는 HTTP header 전파·응답과 구조화 로그 본문에서만
검색한다.

## SLO 정책값과 실측값 구분

30일 rolling 가용성 `99.9%`는 최신 웹 배포 설계에서 가져온 초기 정책값이다. 이는 측정 결과나 출시 승인값이 아니며, private-dev/aws-dev의 실제 트래픽과 부하 시험으로 보정해야 한다.

```text
목표 가용성 = 0.999
허용 오류 비율 = 1 - 목표 가용성
실측 가용성 = 1 - (30일 5xx eligible 요청 수 / 30일 eligible 요청 수)
```

분모가 0이거나 metric series가 없으면 결과는 `미측정`이다. 이 문서와 dashboard는 실제 달성률이나 남은 budget 숫자를 미리 기록하지 않는다.

recording rule은 각 시간 창의 전체 요청 rate가 `0`보다 큰 경우에만 5xx ratio와 burn-rate series를 만든다. 트래픽이 끊긴 구간을 오류율 `0`이나 SLO 정상으로 오해하지 않기 위한 조건이다.

Latency는 `http_server_request_duration_seconds_bucket`으로 p99를 계산한다. 1초 경계는 구조화 로그의 slow-request 기준과 맞춘 초기 경고선이며, 가용성 Error Budget과 섞지 않는다.

## Error Budget

계산식만 고정하고, 실제 숫자는 30일 eligible request가 수집된 뒤 계산한다.

```text
허용 실패 요청 수 = eligible 요청 수 * (1 - SLO 목표)
소모 요청 수      = 5xx eligible 요청 수
남은 요청 수      = 허용 실패 요청 수 - 소모 요청 수
소모 비율         = 소모 요청 수 / 허용 실패 요청 수
```

서비스별로 따로 계산한다. 9개 서비스를 하나의 분모로 합치면 대량 조회 서비스가 결제·주문 경계의 장애를 가릴 수 있으므로 전체 합산 budget은 배포 판정에 사용하지 않는다.

## Burn Rate

Burn rate는 현재 오류 비율을 허용 오류 비율로 나눈 값이다.

```text
burn rate = 관측 5xx 비율 / (1 - SLO 목표)
```

`1x`는 같은 속도가 30일 내내 이어질 때 budget을 정확히 소모하는 속도라는 뜻이다. 실제 잔여 budget 숫자가 없어도 오류가 얼마나 빠르게 쌓이는지는 계산할 수 있다.

recording rule:

```text
dropmong:http_requests:rate5m
dropmong:http_5xx:rate5m
dropmong:http_5xx_ratio:rate5m
dropmong:http_request_duration_seconds:p99_5m
dropmong:slo_http_5xx_burn_rate:5m
dropmong:slo_http_5xx_burn_rate:1h
dropmong:slo_http_5xx_burn_rate:30m
dropmong:slo_http_5xx_burn_rate:6h
```

multi-window 경보:

| 경보 | 짧은 창 | 긴 창 | 두 창 임계치 | 목적 |
| --- | ---: | ---: | ---: | --- |
| `DropMongSLOFastBurn` | 5분 | 1시간 | `14.4x` | 급격한 장애를 빠르게 잡는다. |
| `DropMongSLOSlowBurn` | 30분 | 6시간 | `6x` | 작지만 지속되는 오류를 잡는다. |

두 창이 동시에 임계치를 넘어야 한다. 짧은 순간 spike만으로 경보가 계속 울리거나, 긴 집계만 보느라 급격한 장애를 늦게 잡는 문제를 줄이기 위한 조건이다.

## 조사 순서

```text
1. metric: 서비스·시간대·Traffic·5xx ratio·p99·burn rate 확인
2. log: 같은 시간대 5xx/slow log에서 request_id와 trace_id 확인
3. trace: Tempo에서 trace_id를 열고 실패·지연 span 확인
4. dependency: DB, Kafka, Collector, Pod/Node 포화 상태 확인
```

`request_id`는 한 요청의 로그를 묶고, `trace_id`는 서비스 간 전체 작업을 묶으며, `span_id`는 그 작업 안의 한 구간을 가리킨다. 택배로 비유하면 request ID는 접수 번호, trace ID는 배송 전체 번호, span ID는 집하·분류·배송 같은 한 단계 번호다.

## Ingress와 mesh decision point

Kong 전용 ServiceMonitor는 신규 진입점 계약으로 승계하지 않는다. 교체 Ingress Controller의 request/error/latency metric 이름과 label이 아직 확정되지 않았으므로 ingress SLI나 fallback query를 만들지 않는다. 현재 SLO의 진실은 각 애플리케이션 `/metrics`다. AWS dev uses Istio-only ingress이며 private-dev Kong 구성은 별도 이전 범위다.

Istio PodMonitor는 `istiod` 1개와 `istio-ingressgateway` 1개 target, 위 9개 애플리케이션의
`istio-proxy` sidecar를 대상으로 한다. 요청 rate/5xx/latency PromQL은 반드시
`reporter="destination"`을 사용해 destination-only 의미를 유지하고 source proxy와의
이중 집계를 막는다. Coupon은 정적 coverage에서 유지하되 알려진 외부 adapter CrashLoop의
runtime waiver만 허용한다. Coupon이 복구되기 전에는 **Task 6 remains partial**이며, 이 문서는
이를 완료로 표시하지 않는다.

## 검증 게이트

- PrometheusRule CRD 정적 render와 PromQL syntax를 확인한다.
- 9개 서비스 `/metrics`에서 공통 histogram과 label을 확인한다.
- 실제 API 요청을 보낸 뒤 count/bucket이 증가하는지 확인한다.
- 5xx와 1초 이상 요청을 통제된 환경에서 만들고 recording rule/alert/log/trace 연결을 확인한다.
- 30일 표본이 없으면 달성률과 남은 budget을 발표하지 않는다.
- live cluster 검증을 실행하지 않았다면 정적 render 통과와 런타임 성공을 구분한다.
- 이번 Istio dashboard/Prometheus runtime verification is deferred; 정적 계약만으로 live 결과나 SLO 달성을 주장하지 않는다.
