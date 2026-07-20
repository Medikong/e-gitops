# DropMong monitoring

`platform/monitoring`은 신규 DropMong 서비스의 metric, log, trace 조사 자산과 Prometheus 경보를 관리한다. 대상 서비스와 신호 계약의 기준 문서는 [service-observability-inventory.md](service-observability-inventory.md)다.

## 대상과 원칙

- 대상은 `auth`, `user`, `catalog`, `coupon`, `interest`, `order`, `payment`, `notification`, `dropmong-web` 9개 서비스와 각각의 `dropmong-*` namespace다.
- API 신호는 route template을 사용하는 공통 `http_server_request_duration_seconds` histogram과 `http_server_active_requests`를 기준으로 한다.
- `request_id`, `trace_id`, `span_id`는 고카디널리티 metric label이 아니라 구조화 로그 본문에 둔다.
- 실제 요청 자료가 없으면 SLO 달성률, Error Budget 잔여량, burn rate 실측값을 만들지 않는다.
- Kong 전용 metric은 승계하지 않는다. 교체 Ingress Controller 계약이 정해질 때까지 애플리케이션 metric을 SLI 기준으로 사용한다.
- Envoy PodMonitor는 추적 values에서 `http-envoy-prom` port가 확인된 `payment-service`, `notification-service`만 수집한다.

## Grafana 그룹

| 그룹 | 대표 화면 | 목적 |
| --- | --- | --- |
| Ops | `00-service-overview.json` | 9개 서비스의 Latency, Traffic, Errors, Saturation과 readiness를 한 번에 확인한다. |
| Logs | `10-request-investigation.json` | metric으로 좁힌 시간대에서 request/trace/span ID를 찾아 Tempo trace로 이동한다. |
| DB | `10-postgresql-overview.json` | 실제 PostgreSQL exporter가 있는 7개 DB 소유 서비스의 연결·transaction·resource 상태를 확인한다. |
| Load | `10-api-load-overview.json` | 신규 API route별 부하, latency, 5xx, active request와 Pod 포화를 비교한다. |

대표 화면은 위 4개다. 문제가 좁혀졌을 때만 다음 보조 화면을 연다.

- Ops: `10-runtime-and-telemetry.json` - Pod runtime과 Collector export/queue 상태
- Logs: `20-service-errors.json` - 5xx 및 구조화 서비스 오류
- Logs: `30-kafka-correlation.json` - active broker를 쓰는 interest/order/payment/notification의 correlation ID 조사
- DB: `20-db-trace-correlation.json` - DB 관련 로그와 trace 연결
- Load: `20-slow-request-traces.json` - 느린 route의 로그와 Tempo trace 조사

## 조사 순서

1. Ops 또는 Load에서 영향 서비스, route, 시간대와 Latency·Traffic·Errors·Saturation을 확인한다.
2. Logs에서 같은 조건의 `request_id`와 `trace_id`를 찾는다.
3. Tempo에서 `trace_id`를 열고 `span_id`가 가리키는 지연 또는 실패 구간을 확인한다.
4. 원인이 좁혀지면 DB, Kafka, Collector, Pod/Node 보조 화면과 해당 런북을 확인한다.

`request_id`는 한 HTTP 요청의 로그 묶음, `trace_id`는 여러 서비스를 지난 작업 전체, `span_id`는 그 안의 한 처리 구간을 식별한다. `dropmong-web`의 span export 미검증 경계는 인벤토리에 따로 명시한다.

## 규칙과 운영 문서

- `manifests/prometheusrules/service-slo-alerts.yaml`: HTTP recording rule 8개와 서비스/SLO/Collector 경보 6개
- `manifests/prometheusrules/system-kubernetes-alerts.yaml`: Deployment, OOM, CPU throttling, Node memory 경보 4개
- [slo/README.md](slo/README.md): SLI/SLO, Error Budget, multi-window burn-rate 계산 명세
- [logql/README.md](logql/README.md): 5xx, slow request, ID, Kafka, Collector 조사 쿼리 9개
- [runbooks/README.md](runbooks/README.md): 모든 경보의 대응 절차
- [alerting/README.md](alerting/README.md): 외부 알림 webhook Secret 계약과 기존 endpoint 폐기 절차

모든 경보에는 저장소 runbook의 절대 `runbook_url`이 있다. 경보의 임계치는 초기 운영값이며 live traffic과 부하 시험 자료로 보정한다.

## 적용 순서

1. Argo CD platform Application이 `monitoring` namespace와 dashboard ConfigMap, PodMonitor, PrometheusRule을 적용한다.
2. kube-prometheus-stack Helm source가 Prometheus Operator, Prometheus, Alertmanager와 Grafana를 적용한다.
3. 서비스 chart의 ServiceMonitor가 각 `/metrics` endpoint를 Prometheus에 연결한다.
4. Grafana sidecar가 `grafana_dashboard=1` ConfigMap을 `Ops`, `Logs`, `DB`, `Load` 폴더로 읽는다.
5. Loki와 Tempo datasource는 `platform/observability`가 배포한 backend service를 사용한다.

Alertmanager는 cluster 내부 adapter만 호출한다. 외부 webhook 원문은 Git에 두지 않고 `monitoring/alertmanager-discord-webhook` Secret의 `webhook-url` key로 adapter에 주입한다.

## 검증 경계

정적 검증은 dashboard JSON 문법, Kustomize/Helm render, Prometheus rule 문법과 참조 연결을 확인한다. 이는 live cluster의 ServiceMonitor `up`, 실제 log/trace 수집, 알림 전달, SLO 달성을 증명하지 않는다. 런타임 검증에서는 비밀값이나 개인정보를 출력하지 않고 target 상태와 통제된 비민감 요청만 사용한다.
