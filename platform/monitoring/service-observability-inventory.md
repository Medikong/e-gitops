# DropMong 서비스 관측성 인벤토리

이 문서는 대시보드, 기록 규칙, 경보와 런북이 공통으로 사용하는 대상 목록이다. `service/config/services.yml`, aws-dev/private-dev Argo Application, 서비스 코드와 추적 중인 values를 함께 대조했다. 이미지 빌드 목록만으로 배포나 신호 수집 성공을 단정하지 않는다.

## 최종 대상

| 서비스 | namespace | 주요 HTTP route | 데이터 소유권 | Kafka 계약 | `/metrics` | trace 및 구조화 로그 |
|---|---|---|---|---|---|---|
| `auth-service` | `dropmong-auth` | `/api/v1/auth/intents`, `/api/v1/auth/registrations`, `/api/v1/auth/sessions`, `/api/v1/auth/context` | PostgreSQL, 세션 상태용 Valkey는 환경 선택 | outbox producer 구현은 있으나 추적 values에서 broker 발행은 기본 활성 대상이 아님 | admin port | Go OTel HTTP/PostgreSQL/Valkey 계측, JSON 로그에 request/trace/span ID |
| `user-service` | `dropmong-user` | `/api/v1/users`, `/api/v1/users/me/profile`, `/api/v1/users/me/profile-image`, `/api/v1/operator/users/{userId}/status` | PostgreSQL | 없음 | admin port | Go OTel HTTP/PostgreSQL 계측, JSON 로그에 request/trace/span ID |
| `catalog-service` | `dropmong-catalog` | `/drops`, `/drops/{drop_id}` | PostgreSQL | `inventory.changed` consumer 구현, broker 주소가 있을 때만 실행 | app port | FastAPI OTel HTTP/SQLAlchemy/Kafka 계측, JSON 로그에 request/trace/span ID |
| `coupon-service` | `dropmong-coupon` | `/api/v1/coupon-campaigns/{campaignId}/claims`, `/api/v1/users/me/coupons`, `/api/v1/internal/coupon-*` | PostgreSQL, 선택적 Redis admission gate | 외부 Kafka client 계약 없음; PostgreSQL outbox/inbox와 worker가 업무 이벤트를 처리 | admin port | Go OTel HTTP/PostgreSQL/Redis 계측, JSON 로그에 request/trace/span ID |
| `interest-service` | `dropmong-interest` | `/v1/users/me/interests`, `/v1/drops/{dropId}/views`, `/v1/rankings/drops/*` | PostgreSQL | `interest.added`, `interest.removed` producer; broker 설정이 있을 때 실행 | app port | FastAPI OTel HTTP/SQLAlchemy/Kafka 계측, JSON 로그에 request/trace/span ID |
| `order-service` | `dropmong-order` | `/orders`, `/orders/{order_id}`, `/orders/{order_id}/cancellations` | PostgreSQL, 재고 원장 포함 | 주문·재고·알림·환불 이벤트 producer, 결제·환불 이벤트 consumer | app port | FastAPI OTel HTTP/SQLAlchemy/Kafka 계측, JSON 로그에 request/trace/span ID |
| `payment-service` | `dropmong-payment` | `/payments/mock-approvals`, `/payments/mock-failures`, `/payments/{payment_id}` | PostgreSQL 결제 원장 | `order.created`/환불 요청 consumer, 결제·환불 결과 producer | app port | FastAPI OTel HTTP/SQLAlchemy/Kafka 계측, JSON 로그에 request/trace/span ID |
| `notification-service` | `dropmong-notification` | `/notifications` | PostgreSQL repository 구현은 있으나 추적 values에는 `DATABASE_URL`이 없어 현재 active DB 대상이 아님 | `notification.requested` consumer | app port | FastAPI OTel HTTP/Kafka 계측, JSON 로그에 request/trace/span ID |
| `dropmong-web` | `dropmong-web` | `/api/web/home`, `/api/web/products/*`, `/api/web/checkout`, `/api/web/auth/*`, `/metrics` | 업무 DB 없음 | 없음 | app port | W3C `traceparent`와 `X-Request-Id`를 하위 서비스로 전달하고 JSON access log에 request/trace ID와 propagation context span ID 기록; 자체 OTLP span export는 미검증 |

## 공통 신호 계약

### Metric

- HTTP 요청 시간: `http_server_request_duration_seconds_bucket`, `_count`, `_sum`
- 처리 중 요청: `http_server_active_requests`
- 준비 상태: `service_ready` (`service_name`, `service_version`, `service_environment` label)
- 공통 label: `service_name`, `service_version`, `service_environment`, `http_route`, `http_route_kind`, `http_request_method`
- 완료 요청에만 추가하는 label: `http_response_status_code`
- `http_request_method`는 표준 HTTP method만 유지하고 그 밖의 입력은 `OTHER`로 정규화해 임의 method가 시계열을 늘리지 못하게 한다.
- `http_route`는 route template만 사용한다. raw path, `request_id`, `trace_id`, `span_id`, 사용자·업무 객체 ID는 metric label로 사용하지 않는다.
- ServiceMonitor는 추적 환경 values에서 활성화된다. 정적 render는 설정 연결을 확인하지만 Prometheus target `up`을 증명하지 않는다.

### Log

- HTTP 완료 event는 `http.request.completed`다.
- 공통 조사 field는 `service.name`, `service.version`, `service.environment`, `severity_text`, `request_id`, `trace_id`, `span_id`, `http.method`, `http.route`, `http.status_code`, `duration_ms`, `log.kind`, `log.policy`다.
- Kafka 완료 event는 `kafka.message.publish` 또는 `kafka.message.process`이며 `messaging.destination.name`, `correlation_id`, `trace_id`, `span_id`, `outcome`, 선택적 `failure.code`를 사용한다.
- ID와 오류 원문은 Loki label로 올리지 않고 JSON 본문 field로만 검색한다.

### Trace

- HTTP는 W3C `traceparent`를 전달한다.
- Kafka producer는 trace carrier를 header에 넣고 consumer는 이를 추출해 처리 span을 만든다.
- Grafana에서는 metric의 서비스·route·시간 범위로 로그를 좁힌 뒤 로그의 `trace_id`로 Tempo trace를 열고 `span_id`로 해당 작업 구간을 확인한다.
- `dropmong-web`은 trace context를 만들고 전달하지만 현재 로그의 `span_id`는 전달용 `traceparent`의 context ID다. 자체 span OTLP export가 검증되지 않았으므로 이 ID가 Tempo의 web span과 일치한다고 단정하지 않으며, `trace_id`로 하위 서비스 trace를 찾는 연결만 사용한다.

## DB 화면 대상

DB 대시보드는 추적 values와 데이터 manifest가 함께 존재하는 아래 7개 PostgreSQL 소유 서비스만 기본 선택 대상으로 둔다.

```text
auth-service
user-service
catalog-service
coupon-service
interest-service
order-service
payment-service
```

`notification-service`는 PostgreSQL repository가 있지만 active values에 DB 연결이 없으므로 기본 DB 화면에서 제외한다. `dropmong-web`은 업무 DB를 소유하지 않는다.

## 미검증 및 결정 항목

- live cluster에서 9개 ServiceMonitor target과 signal ingestion을 확인하지 않았다.
- Istio sidecar와 `http-envoy-prom` 계약은 현재 `payment-service`, `notification-service`에만 있다. 다른 7개에 Envoy metric이 있다고 가정하지 않는다.
- Kong 리소스가 일부 active values에 남아 있지만 교체할 Ingress Controller의 요청 metric 계약이 확정되지 않았다. 따라서 신규 대표 대시보드와 SLO는 Kong metric을 사용하지 않는다.
- SLO 달성률, Error Budget 잔여량과 burn rate 실측값은 요청 데이터가 쌓인 뒤에만 판정한다.
