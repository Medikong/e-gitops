# DropMong monitoring

`platform/monitoring`은 신규 DropMong 서비스의 metric, log, trace 조사 자산과 Prometheus 경보를 관리한다. 대상 서비스와 신호 계약의 기준 문서는 [service-observability-inventory.md](service-observability-inventory.md)다.

## 대상과 원칙

- 대상은 `auth`, `user`, `catalog`, `coupon`, `interest`, `order`, `payment`, `notification`, `dropmong-web` 9개 서비스와 각각의 `dropmong-*` namespace다.
- Ops 11은 서비스 Pod를 반복하지 않고 `monitoring`, `observability`, `kong`, `kube-system`, `local-path-storage`, `dropmong-messaging`과 실제 DB·Valkey StatefulSet을 지원 Pod로 분리한다.
- API 신호는 route template을 사용하는 공통 `http_server_request_duration_seconds` histogram과 `http_server_active_requests`를 기준으로 한다.
- `request_id`, `trace_id`, `span_id`는 고카디널리티 metric label이 아니라 구조화 로그 본문에 둔다.
- 실제 요청 자료가 없으면 SLO 달성률, Error Budget 잔여량, burn rate 실측값을 만들지 않는다.
- Kong 전용 metric은 승계하지 않는다. 교체 Ingress Controller 계약이 정해질 때까지 애플리케이션 metric을 SLI 기준으로 사용한다.
- Envoy PodMonitor는 추적 values에서 `http-envoy-prom` port가 확인된 `payment-service`, `notification-service`만 수집한다.

## Grafana 그룹

Grafana sidecar는 총 29개 화면을 `Ops` 9개, `Logs` 9개, `DB` 4개, `Load` 7개 폴더에 배치한다. 화면 수를 늘리는 것이 목적이 아니라, 첫 이상 감지 화면에서 구체적인 Pod·DB·로그·trace 증거까지 한 단계씩 내려가도록 역할을 분리하는 것이 목적이다.

| 그룹 | 대표 화면 | 상세 조사 순서 |
| --- | --- | --- |
| Ops | `00-service-overview.json` | `00` 영향 확인 → `01` 서비스 runtime → `03` mesh 근거 → `04` 업무 route/Pod 로그 → `10` Kubernetes → `11` 지원 Pod → `12` Node |
| Logs | `logs-10-overview.json` | `10` 전체 이상 → `20` 서비스·route → `25` ID 검색 → `30` 오류/Kafka → `40` ID 연결 → `50` trace → `70` platform → `80` 서비스 상세 |
| DB | `db-10-operations-overview.json` | `10` PostgreSQL 이상 → `20` DB Pod 자원 → `30` workload/slow span → `40` log·trace 연결 |
| Load | `load-10-api-load-overview.json` | `10` 부하 영향 → `20` latency/error → `30` saturation → `40` 원인 후보 → `50` service/DB/Kafka 자원 → `60` runner 로그 → `70` slow trace |

Ops의 `payment-service-metrics.json`은 현재 `/payments/*` route, payment PostgreSQL, Kafka 완료 로그만 다루는 서비스 상세 화면이다. Logs의 `logs-30-kafka-correlation.json`은 active broker 계약이 있는 `interest`, `order`, `payment`, `notification`만 대상으로 한다.

## 조사 순서

1. Ops 00 또는 Load 10에서 영향 서비스, route, 시간대와 Latency·Traffic·Errors·Saturation을 확인한다.
2. Ops 01/10/11/12에서 서비스 → Deployment → 지원 시스템 Pod → Node 순서로 Kubernetes 원인을 좁힌다.
3. Logs 10/20/25에서 같은 조건의 `request_id`와 `trace_id`를 찾고, Logs 30/40/50에서 오류·Kafka·span을 연결한다.
4. Tempo에서 `trace_id`를 열고 `span_id`가 가리키는 지연 또는 실패 구간을 확인한다.
5. DB 소유 서비스라면 DB 10/20/30/40에서 PostgreSQL → DB Pod → workload → trace 순서로 확인한다.

`request_id`는 한 HTTP 요청의 로그 묶음, `trace_id`는 여러 서비스를 지난 작업 전체, `span_id`는 그 안의 한 처리 구간을 식별한다. `dropmong-web`의 span export 미검증 경계는 인벤토리에 따로 명시한다.

## 신호가 없는 화면의 해석

- Ops 03은 Kong 요청 metric을 사용하지 않는다. 추적 중인 PodMonitor가 명시한 `payment-service`, `notification-service` Envoy와 istiod만 다루며, 해당 workload에 sidecar가 없으면 `No data`가 정상이다.
- Load 60은 k6 stdout JSON 로그만 사용한다. k6 Prometheus remote-write가 비활성인 상태에서 VU나 dropped iteration 수치를 만들지 않는다.
- 업무 화면은 공통 HTTP route 완료량과 Kafka 완료 로그를 운영 근거로 사용한다. 이를 주문 성공률이나 결제 성공률 같은 업무 성과로 표현하지 않는다.
- DB 30은 실제 PostgreSQL exporter와 Tempo PostgreSQL span을 사용한다. 별도 slow-query metric이 없으면 이를 가정하지 않는다.

`dashboards/{ops,logs,db,load}`의 JSON 파일이 Grafana 대시보드의 유일한 원본이다. 대시보드는 해당 JSON을 직접 수정하고 문법, UID, 링크와 렌더링을 검증한다.

## 규칙과 운영 문서

- `manifests/prometheusrules/service-slo-alerts.yaml`: HTTP recording rule 8개와 서비스/SLO/Collector 경보 6개
- `manifests/prometheusrules/system-kubernetes-alerts.yaml`: Deployment, OOM, CPU throttling, Node memory 경보 4개
- [slo/README.md](slo/README.md): SLI/SLO, Error Budget, multi-window burn-rate 계산 명세
- [logql/README.md](logql/README.md): 5xx, slow request, ID, Kafka, Collector 조사 쿼리 9개
- [runbooks/README.md](runbooks/README.md): 모든 경보의 대응 절차
- [alerting/README.md](alerting/README.md): 외부 알림 webhook Secret 계약과 기존 endpoint 폐기 절차

모든 경보에는 저장소 runbook의 절대 `runbook_url`이 있다. 경보의 임계치는 초기 운영값이며 live traffic과 부하 시험 자료로 보정한다.

## Grafana 관리자 Secret

AWS Dev의 Grafana 로컬 관리자는 비상용 계정으로만 사용한다. AWS Secrets Manager가 원본을 보관하고 External Secrets Operator가 `monitoring/grafana-admin-credentials`를 생성한다. Git과 Terraform에는 Secret 값을 저장하지 않는다.

Grafana가 최초 관리자 비밀번호를 내부 DB에 저장하므로 ExternalSecret은 `CreatedOnce`와 immutable target을 사용한다. target은 `Owner`로 연결해 Kubernetes Secret 삭제 이벤트를 ESO가 즉시 감지하고 AWS 원본으로 복구하게 한다. 정상 Secret은 AWS 원본 값이 바뀌었다는 이유만으로 자동 교체되지 않는다. ExternalSecret을 삭제하면 target도 함께 제거되므로 Argo CD에서 ExternalSecret을 계속 관리해야 하며, 회전 시에는 Grafana CLI/API, AWS 원본, Kubernetes Secret을 함께 변경해야 한다.

일반 사용자 로그인은 향후 OIDC/SSO로 전환한다. IdP issuer, client ID, callback URL과 그룹 역할 매핑을 검증하기 전에는 로컬 로그인과 비상용 계정을 비활성화하지 않는다.

## 적용 순서

1. `namespaces-aws-dev`가 `external-secrets`와 `monitoring` namespace를 만든다.
2. `external-secrets-aws-dev`가 ESO CRD와 컨트롤러를 설치한다.
3. `external-secrets-monitoring-config-aws-dev`가 SecretStore와 ExternalSecret을 만들고 PostSync Job으로 실제 Secret 준비를 확인한다.
4. `monitoring-aws-dev`가 dashboard ConfigMap, PodMonitor, PrometheusRule과 kube-prometheus-stack을 적용한다.
5. 서비스 chart의 ServiceMonitor가 각 `/metrics` endpoint를 Prometheus에 연결한다.
6. Grafana sidecar가 `grafana_dashboard=1` ConfigMap을 `Ops`, `Logs`, `DB`, `Load` 폴더로 읽는다.
7. Loki와 Tempo datasource는 `platform/observability`가 배포한 backend service를 사용한다.

Alertmanager는 cluster 내부 adapter만 호출한다. 외부 webhook 원문은 Git에 두지 않고 `monitoring/alertmanager-discord-webhook` Secret의 `webhook-url` key로 adapter에 주입한다.

## 검증 경계

정적 검증은 29개 dashboard JSON 문법, UID 고유성, 이전·다음 UID 링크, Kustomize/Helm render, Prometheus rule 문법과 참조 연결을 확인한다. 이는 live cluster의 ServiceMonitor `up`, 실제 log/trace 수집, 알림 전달, SLO 달성을 증명하지 않는다. 런타임 검증에서는 비밀값이나 개인정보를 출력하지 않고 ConfigMap key, Grafana 검색 결과, target 상태와 통제된 비민감 요청만 사용한다.
