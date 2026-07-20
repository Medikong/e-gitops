# DropMong 운영 로그 수집 정책

## 원칙

Loki는 모든 request/access log의 원장이 아니다. 서비스는 stdout/stderr에 구조화 JSON을 기록하고, Collector가 보존 정책을 적용해 Loki로 보낸다.

```text
metric
  /metrics -> Prometheus

trace
  OTLP trace -> OpenTelemetry Collector -> Tempo

technical log
  stdout/stderr JSON -> OpenTelemetry Collector filelog -> Loki

audit evidence
  business event/outbox -> 별도 검색·증적 경로
```

서비스 코드는 Loki backend나 sampling 구현을 알지 않는다. Collector export 실패는 애플리케이션 요청을 성공처럼 바꾸지 않으며, Prometheus의 Collector internal metric으로 별도 감시한다.

## 대상 서비스

```text
auth-service              dropmong-auth
user-service              dropmong-user
catalog-service           dropmong-catalog
coupon-service            dropmong-coupon
interest-service          dropmong-interest
order-service             dropmong-order
payment-service           dropmong-payment
notification-service      dropmong-notification
dropmong-web              dropmong-web
```

## HTTP 구조화 로그 계약

요청 완료 event는 `event="http.request.completed"`를 사용한다.

```text
service.name
service.version
service.environment
severity
severity_text
http.method
http.route
http.route.kind
http.status_code
duration_ms
request_id
trace_id
span_id
client_action_id
http.request.is_probe
log.kind
log.policy
```

Loki의 `| json` parser에서는 dotted key가 `service_name`, `http_route_kind`, `http_status_code`처럼 조회된다.

| 조건 | service field | Collector 정책 |
| --- | --- | --- |
| `/health`, `/healthz`, `/readyz`, `/metrics` 성공 | `http.route.kind=probe`, `log.policy=drop` | local/private-dev/aws-dev에서 drop |
| 일반 2xx/3xx API | `http.route.kind=api`, `log.policy=sample` | aws-dev에서 10% sampling |
| `duration_ms >= 1000` | `severity_text=WARN`, `log.policy=keep` | keep |
| 5xx | `severity_text=ERROR`, `log.policy=keep` | keep |
| 4xx 또는 debug route | `severity_text=WARN` 또는 `http.route.kind=debug`, `log.policy=keep` | keep |

현재 private-dev Collector도 성공 access log에 sampling 정책을 적용한다. 보존 비율은 실측 volume과 조사 가능성을 확인한 뒤 조정하며, 성공 로그 sampling을 SLO 분모로 사용하지 않는다. SLO 분모는 Prometheus HTTP histogram이다.

## Kafka 구조화 로그 계약

공통 Kafka wrapper는 message payload를 기록하지 않고 처리 경계만 남긴다.

```text
event                       kafka.message.publish | kafka.message.process
service.name
messaging.system            kafka
messaging.operation         publish | process
messaging.destination.name  고정 topic 이름
outcome                     success | failure
failure.code                allowlist된 실패 분류, 실패 시에만
correlation_id
trace_id
span_id
messaging.kafka.partition   consumer에 있을 때만
messaging.kafka.message.offset
```

`correlation_id`로 producer/consumer 로그를 찾고 `trace_id`로 Tempo trace를 연다. message value, 사용자·주문·결제 원문, 인증 정보는 로그에 넣지 않는다.

## Collector 정책

Collector는 contrib distribution의 DaemonSet으로 각 노드의 `/var/log/pods`를 읽는다.

```text
image: otel/opentelemetry-collector-contrib:0.153.0
command: otelcol-contrib
mode: daemonset
```

환경별 정책:

| 환경 | 정책 |
| --- | --- |
| local | 성공 probe를 drop하고 일반 API 로그는 sampling 없이 개발 조사에 보존한다. |
| private-dev | 성공 probe를 drop하고 일반 성공 access log는 10% sampling한다. |
| aws-dev | 성공 probe를 drop하고 일반 성공 access log는 10% sampling한다. |
| prod | 전용 Collector values가 아직 없으므로 미정이다. prod 정책을 추측해 복제하지 않는다. |

Collector NetworkPolicy는 `dropmong.io/tier`가 `api` 또는 `frontend`인 Pod의 OTLP `4317/4318`만 허용한다. 과거 서비스 label은 허용하지 않는다.

Collector 자기 컨테이너 로그는 filelog 입력에서 제외한다. 동일 Collector의 Loki export가 실패하면 자기 오류 로그도 보낼 수 없기 때문이다. export 실패의 운영 진실은 다음 metric이다.

```text
otelcol_exporter_send_failed_log_records_total
otelcol_exporter_send_failed_spans_total
otelcol_exporter_queue_size
otelcol_exporter_queue_capacity
```

## Loki label 정책

허용 label은 낮은 cardinality resource만 사용한다.

```text
k8s_namespace_name
k8s_pod_name
k8s_container_name
service_name
deployment_environment_name
scenario
step
```

다음 값은 label로 올리지 않고 JSON 본문에서만 검색한다.

```text
trace_id
span_id
request_id
client_action_id
correlation_id
user_id
업무 객체 ID
raw URL/query string
```

## 조사 쿼리

5xx, slow request, 서비스 오류, request/trace/span ID, Kafka correlation/failure, Collector export 실패의 표준 쿼리는 `../monitoring/logql/README.md`에서 관리한다.

## 검증

```bash
task --taskfile platform/observability/collector/Taskfile.yml render
task observability:render
task validate
git diff --check
```

정적 render는 실제 Loki 수집이나 Tempo 저장 성공을 증명하지 않는다. live cluster 확인을 실행하지 않았으면 런타임 성공으로 보고하지 않는다.
