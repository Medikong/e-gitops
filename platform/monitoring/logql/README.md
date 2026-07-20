# DropMong LogQL 조사 라이브러리

이 문서는 신규 DropMong 서비스의 구조화 로그 계약을 기준으로 한 복사 가능한 조사 쿼리 모음이다. 대상은 `auth`, `user`, `catalog`, `coupon`, `interest`, `order`, `payment`, `notification`, `dropmong-web` 9개 workload다.

공통 selector는 낮은 cardinality Kubernetes/OTel resource label만 사용한다.

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"}
```

`request_id`, `trace_id`, `span_id`, `correlation_id`는 Loki label이 아니라 JSON 본문 field다. 아래 `<...>` 표시는 실제 조사 값으로 바꾼다. 결과가 비어 있으면 정상으로 단정하지 않고 Collector 수집 상태와 해당 서비스의 구조화 로그 계약을 먼저 확인한다.

## 1. API 5xx

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"} | json | event="http.request.completed" | http_route_kind="api" | http_status_code=~"5.." | line_format "service={{.service_name}} route={{.http_route}} status={{.http_status_code}} duration_ms={{.duration_ms}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"
```

## 2. 느린 API 요청

서비스 로그의 slow-request 경계인 1초를 사용한다. 이 값은 부하·실사용 자료로 보정하기 전의 초기 운영 경계다.

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"} | json | event="http.request.completed" | http_route_kind="api" | duration_ms >= 1000 | line_format "service={{.service_name}} route={{.http_route}} status={{.http_status_code}} duration_ms={{.duration_ms}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"
```

## 3. 서비스 오류

5xx access log뿐 아니라 공통 계약의 `severity_text`를 채운 내부·의존성 오류 후보를 찾는다. 오류 원문에는 비밀값이나 개인정보가 없어야 한다.

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"} | json | severity_text=~"ERROR|CRITICAL" | line_format "service={{.service_name}} event={{.event}} error_type={{.error_type}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"
```

## 4. request_id로 한 요청 묶기

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"} |= "<REQUEST_ID>" | json | request_id="<REQUEST_ID>"
```

## 5. trace_id로 서비스 간 로그 묶기

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"} |= "<TRACE_ID>" | json | trace_id="<TRACE_ID>" | line_format "service={{.service_name}} event={{.event}} route={{.http_route}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"
```

찾은 `trace_id`는 Grafana Tempo datasource에서 직접 조회한다. metric으로 영향 시간대를 찾고, 이 쿼리로 trace ID를 고른 뒤, Tempo에서 느리거나 실패한 span을 확인하는 순서다.

## 6. span_id로 한 처리 구간 찾기

```logql
{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment|notification|web)",service_name=~"auth-service|user-service|catalog-service|coupon-service|interest-service|order-service|payment-service|notification-service|dropmong-web"} |= "<SPAN_ID>" | json | span_id="<SPAN_ID>"
```

## 7. Kafka correlation

Kafka 공통 wrapper는 payload를 남기지 않고 `kafka.message.publish` 또는 `kafka.message.process`, topic, outcome, correlation/trace/span ID만 기록한다.

추적 values에서 broker가 활성인 대상은 `interest`, `order`, `payment`, `notification`이다. 구현만 있고 현재 비활성인 후보를 selector에 섞지 않는다.

```logql
{k8s_namespace_name=~"dropmong-(interest|order|payment|notification)",service_name=~"interest-service|order-service|payment-service|notification-service"} |= "<CORRELATION_ID>" | json | messaging_system="kafka" | correlation_id="<CORRELATION_ID>" | line_format "service={{.service_name}} operation={{.messaging_operation}} topic={{.messaging_destination_name}} outcome={{.outcome}} correlation_id={{.correlation_id}} trace_id={{.trace_id}} span_id={{.span_id}}"
```

## 8. Kafka publish/process 실패

```logql
{k8s_namespace_name=~"dropmong-(interest|order|payment|notification)",service_name=~"interest-service|order-service|payment-service|notification-service"} | json | messaging_system="kafka" | outcome="failure" | line_format "service={{.service_name}} operation={{.messaging_operation}} topic={{.messaging_destination_name}} failure_code={{.failure_code}} correlation_id={{.correlation_id}} trace_id={{.trace_id}} span_id={{.span_id}}"
```

## 9. Collector export 실패 로그 보조 조회

```logql
{k8s_namespace_name="observability",k8s_container_name="opentelemetry-collector"} |~ "(?i)(exporting failed|failed to export|sending_queue is full)"
```

현재 DaemonSet Collector는 자기 컨테이너 로그를 filelog 입력에서 제외한다. 따라서 이 LogQL은 별도 플랫폼 로그 수집 경로가 붙은 환경에서만 보조 증거가 되며, 빈 결과는 export 성공을 뜻하지 않는다. 운영 판정은 `DropMongCollectorLogExportFailure`, `DropMongCollectorTraceExportFailure` Prometheus 경보와 `otelcol_exporter_queue_size`/`otelcol_exporter_queue_capacity`를 우선한다.
