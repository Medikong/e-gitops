# Monitoring platform resources

`platform/monitoring`은 `monitoring` namespace 기준 Prometheus 기본 스택의 GitOps 운영 경로다.

## 범위

- `manifests/namespace.yaml`: `monitoring` namespace를 만든다.
- `manifests/istio-mesh-podmonitors.yaml`: Istio control plane과 주요 ticketing 서비스의 Envoy sidecar metric을 수집한다.
- `manifests/kong-servicemonitor.yaml`: Kong Gateway metric endpoint를 Prometheus scrape 대상으로 등록한다.
- `manifests/prometheusrules/*.yaml`: Prometheus Operator가 선택하는 시스템/Kubernetes 알림 후보를 관리한다.
- `dashboards/{ops,logs,db,load}/*.json`: Grafana sidecar가 읽는 dashboard JSON을 폴더별로 관리한다.
- `values/kube-prometheus-stack.yaml`: `prometheus-community/kube-prometheus-stack` values를 관리한다.
- Grafana datasource는 이 values에서 함께 관리한다. Prometheus는 기본 datasource, Tempo/Loki는 `additionalDataSources`로 선언한다.
- 서비스별 `ServiceMonitor`는 계속 `charts/medikong-service` release가 관리한다.

## Sync 순서

1. Argo CD root Application이 `argo/applications/aws-dev/platform`과 `argo/applications/aws-dev/services`를 함께 읽는다.
2. `aws-ebs-csi-driver-aws-dev` Application은 sync wave `-31`로 EBS CSI driver를 먼저 설치한다.
3. `storage-aws-dev` Application은 sync wave `-30`으로 AWS EBS CSI `gp3` StorageClass를 생성한다.
4. `monitoring-aws-dev` Application은 sync wave `-20`으로 먼저 생성된다.
5. `platform/monitoring` Kustomize source가 `monitoring` namespace를 만든다.
6. 같은 Kustomize source가 `grafana_dashboard=1` ConfigMap으로 dashboard JSON을 적용한다.
7. 같은 Kustomize source가 `release: kube-prometheus-stack` PrometheusRule을 적용한다.
8. `kube-prometheus-stack` Helm source가 Prometheus Operator CRD와 chart 리소스를 적용한다.
9. 서비스 Application이 만든 `ServiceMonitor`는 `release: kube-prometheus-stack` label로 Prometheus에 선택된다.
10. Kong Gateway용 `ServiceMonitor`와 Istio mesh용 `PodMonitor`는 `monitoring` namespace에서 만들어지고 `release: kube-prometheus-stack` label로 Prometheus에 선택된다.
11. Tempo/Loki backend는 `platform/observability` Application들이 만든 service DNS로 연결된다.

## Istio mesh monitoring

Mesh monitoring은 첫 rollout에서 `concert-service`에 sidecar injection을 먼저 적용해 검증했다. 이후 `reservation-service`, `payment-service`, `ticket-service`, `notification-service`까지 같은 PodMonitor로 확장한다.

수집 대상:

```text
istiod
  - namespace: istio-system
  - endpoint: /metrics
  - port: http-monitoring

ticketing service Envoy sidecar
  - namespace: ticketing-concert, ticketing-reservation, ticketing-payment, ticketing-ticket, ticketing-notification
  - endpoint: /stats/prometheus
  - port: http-envoy-prom
```

PodMonitor는 `monitoring` namespace에 둔다. Prometheus 설정이 `podMonitorSelector.matchLabels.release=kube-prometheus-stack`와 `podMonitorNamespaceSelector`를 사용하기 때문이다.

서비스별 NetworkPolicy는 기본적으로 `monitoring` namespace에서 애플리케이션 `/metrics` 포트만 허용한다. Envoy sidecar metric은 `istio-proxy`의 `15090` 포트로 노출되므로, aws-dev values에서는 `serviceMonitor.networkPolicy.extraPorts`로 `15090`을 함께 허용한다. 이 설정이 없으면 Prometheus target은 생성되어도 `context deadline exceeded`로 down 상태가 된다.

## Kong Gateway monitoring

Kong Gateway는 두 종류의 metric을 노출한다.

- Gateway request metric: Kong prometheus plugin이 proxy container의 status listener `8100/metrics`에 노출한다.
- Ingress Controller metric: Kong Ingress Controller가 `10255/metrics`에 controller-runtime reconcile 상태를 노출한다.

`manifests/kong-servicemonitor.yaml`은 `kong` namespace의 `enable-metrics=true` Service를 선택하고, Pod targetPort 기준으로 `status`와 `cmetrics`를 함께 scrape한다. `status` target은 API Gateway 요청량, latency, status code 같은 실제 외부 진입점 지표를 제공하고, `cmetrics` target은 Kong Ingress Controller가 Kubernetes Ingress/KongPlugin 변경을 정상 반영하는지 보는 운영 지표를 제공한다.

수집 대상:

```text
kong-kong-proxy
  - namespace: kong
  - endpoint: /metrics
  - targetPort: status
  - purpose: Gateway request metric

kong ingress-controller container
  - namespace: kong
  - endpoint: /metrics
  - targetPort: cmetrics
  - purpose: controller reconcile metric
```

Prometheus에서 확인할 query:

```promql
up{job=~"kong.*|monitoring/kong-gateway"}
kong_bandwidth_bytes
kong_http_requests_total
kong_latency_ms_bucket
kong_upstream_latency_ms_bucket
controller_runtime_reconcile_total
```

Kong metric은 Gateway 레벨 요청 수, status code, Kong latency, upstream latency, plugin 처리 상태를 확인하는 데 사용한다. Loki 로그가 개별 요청의 상세 기록이라면, Kong metric은 외부 진입점 전체의 숫자 지표다.

Prometheus에서 확인할 query:

```promql
istio_requests_total
istio_request_duration_milliseconds_bucket
pilot_xds_pushes
```

Grafana에서는 위 metric으로 요청량, 5xx 에러율, P99 응답시간, istiod xDS push 상태를 확인한다. Kiali는 같은 Prometheus를 읽어서 topology, traffic, error rate를 시각화한다.

상태 확인:

```bash
task mesh-monitoring-check
```

## Secret

Grafana admin 계정은 values에 평문으로 넣지 않는다. 배포 전 `monitoring` namespace에 아래 key를 가진 Secret을 준비해야 한다.

```text
name: grafana-admin-credentials
keys: admin-user, admin-password
```

## Storage

aws-dev의 Grafana와 Prometheus PVC는 `medikong-aws-gp3` StorageClass를 명시한다. EBS CSI driver는 `aws-ebs-csi-driver-aws-dev` Application이 설치하고, StorageClass는 `platform/storage`에서 관리한다.

## 기존 reference 경로

`cluster/stacks/observability`는 Loki, Alloy, Tempo까지 포함한 수동 설치 reference로 유지한다. Prometheus 기본 스택의 GitOps 운영 경로는 `platform/monitoring`이다.

## Grafana datasource

Grafana는 `platform/monitoring`의 kube-prometheus-stack이 관리하므로 datasource 선언도 이 values에 둔다.

```text
Prometheus
  - uid: prometheus
  - kube-prometheus-stack 기본 datasource

Tempo
  - uid: tempo
  - url: http://tempo.observability.svc.cluster.local:3200
  - trace-to-logs는 Loki field 검색으로 연결

Loki
  - uid: loki
  - url: http://loki.observability.svc.cluster.local:3100
  - trace_id derived field에서 Tempo로 이동
```

`trace_id`, `request_id`, `user_id`, 업무 객체 ID는 Loki label이나 metric label로 올리지 않는다. Grafana 연결은 JSON log field와 Tempo trace ID 조회를 사용한다.

## Grafana dashboard

Dashboard는 UI에서 수동 생성하지 않고 `dashboards/{ops,logs,db}/*.json` 파일로 관리한다. `kustomization.yaml`의 `configMapGenerator`가 이 파일들을 dashboard ConfigMap으로 만들고, Grafana sidecar는 `grafana_dashboard=1` label을 기준으로 자동 반영한다. ConfigMap은 `kubectl apply` annotation 한도를 피하도록 Ops, Logs, DB 묶음으로 나누며, `k8s-sidecar-target-directory` annotation으로 Grafana folder도 같은 단위로 분리한다.

첫 화면은 Ops folder의 `dashboards/ops/00-service-metrics-overview.json`이다. 패널 순서는 사용자 영향과 핵심 비즈니스 흐름을 먼저 보고, 이후 이벤트와 의존성 상태로 원인을 좁히도록 둔다.

서비스 runtime 상태는 Ops folder의 `dashboards/ops/01-service-runtime-health.json`, `dashboards/ops/02-service-runtime-detail.json`, `dashboards/ops/04-pod-logs-and-waiting-reasons.json`로 나눠 관리한다. `01-service-runtime-health.json`은 전체 서비스 요약과 서비스별 미니 패널에서 현재 Pod 수, available ratio, Ready=false, restart 증가, OOMKilled, memory limit 사용률, CPU throttling을 stat 타일과 bar gauge 리스트로 빠르게 확인한다. `02-service-runtime-detail.json`은 같은 항목을 시간축으로 펼쳐 특정 시간대에 desired/available pod, Ready=false, restart, OOMKilled, CPU/memory/network 상태가 어떻게 움직였는지 확인한다. `04-pod-logs-and-waiting-reasons.json`은 런타임 상태에서 원인을 좁힌 뒤 namespace/pod/container 기준 Loki 파드 로그와 Prometheus waiting reason, restart 증가, Collector 로그 export 실패를 함께 확인한다.

시스템/Kubernetes 메트릭은 `workspace/docs/architecture/observability/metrics/system-metrics.md` 기준으로 Ops folder의 `dashboards/ops/10-system-kubernetes-overview.json`, `dashboards/ops/11-pod-container-resources.json`, `dashboards/ops/12-node-pressure-overview.json`에서 관리한다. 진단 흐름은 서비스 영향 확인 후 Deployment 가용성, Pod/Container 자원과 restart/OOMKilled, Node Ready/Pressure 상태 순서로 내려간다. 현재 상태는 stat 타일과 bar gauge로 먼저 보고, 정확한 대상 식별은 table로 확인하며, 시간 변화가 필요한 CPU/memory/network/pressure만 time series로 둔다. Pod CPU pressure는 kubelet/cAdvisor PSI 지표인 `container_pressure_cpu_waiting_seconds_total`의 Pod cgroup series를 우선 사용하고, 없으면 container series를 Pod 단위로 합산해서 본다. PromQL은 `pod=""`, `container="POD"`처럼 운영 판단에 의미 없는 series를 제외한다.

시스템/Kubernetes 알림 후보는 `manifests/prometheusrules/system-kubernetes-alerts.yaml`에 둔다. 현재 rule은 Deployment available 부족, Ready=false Pod, restart 증가, OOMKilled, CPU throttling, Node MemoryPressure를 `release: kube-prometheus-stack` selector에 맞춰 Prometheus가 선택하도록 관리한다.

DB 관측성은 `DB 10 -> DB 20 -> DB 30 -> DB 40` 순서로 본다. `DB 10 - Operations Overview`는 DB up, connection 사용률, 처리량, slow operation, error, lock/deadlock, p95/p99 latency, 영향 service Top N을 stat과 bar gauge 중심으로 빠르게 감지한다. 이상이 보이면 `DB 20 - Instance Resources`에서 DB Pod CPU/memory/network, restart, OOMKilled, ready, filesystem, Node pressure를 확인하고, `DB 30 - Workload and Slow Queries`에서 PostgreSQL/MongoDB workload와 slow DB operation을 service, db_operation, statement fingerprint 기준으로 좁힌다. 마지막으로 `DB 40 - Trace and Log Correlation`에서 `trace_id`, `request_id`, service, db_system, db_operation으로 slow operation 로그, 같은 trace/request 로그, Tempo trace, DB span duration을 함께 확인한다.

DB dashboard는 SQL 원문, 사용자 ID, `request_id`, `trace_id`를 metric label로 올리지 않는 정책을 전제로 한다. Slow query/operation 화면은 SQL 원문 대신 `statement_fingerprint` 또는 `normalized_statement` JSON field를 우선 표시한다. `db.query.slow` 로그와 DB span 속성 보강은 `Medikong/service#19` 범위이므로, 해당 신호가 아직 없는 환경에서는 관련 Loki/Tempo 패널이 비어 있을 수 있다. 앱 DB latency/error metric은 `db_client_operation_duration_seconds_*`, `db_client_operation_errors_total` 수집 이후 채워지며, PostgreSQL/MongoDB exporter metric도 수집기가 배포된 뒤 값이 채워진다.

Load dashboard는 조회 API 부하 테스트 실행 중 빠르게 상태를 판단하고 병목 후보를 좁히는 Grafana folder다. `kustomization.yaml`의 `medikong-load-dashboards` ConfigMap generator가 `k8s-sidecar-target-directory: Load` annotation으로 Grafana `Load` folder에만 provision한다. 부하 테스트 실행 시나리오, 프로필, runner image, 실행 Taskfile은 `service` repo 책임이고, `gitops`는 Prometheus/Grafana로 들어온 관측 신호를 보여주는 dashboard와 scrape/render 검증만 맡는다.

Load dashboard는 synthetic dashboard와 섞지 않는다. Synthetic은 실제 사용 처리 과정처럼 주기적으로 보내는 자동화 테스트 트래픽을 확인하는 영역이며 `Logs 50 - Synthetic`에서 run/step/result 로그를 본다. Load는 사용자가 선택한 부하 테스트 profile과 target을 기준으로 RPS, latency, error, service saturation, 원인 후보를 확인하는 영역이다.

Load dashboard는 수집 신호를 역할별로 나눠 본다. `Load 20 - Latency and Errors`는 이미 scrape 중인 Kong Gateway metric을 사용해 실제 ingress가 받은 요청의 latency, response code, error rate를 본다. k6 runner 자체의 VU, iteration, dropped iteration 같은 발생기 지표가 필요하면 k6 Prometheus/OTel output을 별도 수집 경로로 켠 뒤 `scenario`, `profile`, `target`, `environment`, `route`, `status`처럼 낮은 cardinality label만 사용한다. `request_id`, `trace_id`, 사용자 ID, raw URL은 metric label로 올리지 않는다. 필요하면 로그 본문 field나 Tempo trace 조회로 내려간다.

Load dashboard 확인 순서:

```text
Load 50 - Service Resource and Traffic
  auth/concert/notification/payment/reservation/ticket의 CPU, memory, RPS, p95 latency를 2열 큰 그래프로 비교한다.
Load 60 - k6 Runner Execution
  runner stdout JSON으로 남은 실험 조건과 실행 결과 원문을 확인한다. API별 상세 비교는 Grafana 패널로 분산하지 않고, 필요한 run의 JSON 로그와 서비스/Kong 지표를 함께 대조한다.
Load 70 - Slow Trace Discovery
  Load 60에서 확인한 실험 시간 범위에 맞춰 service/route/min duration 기준의 느린 요청 trace 후보를 보고, trace_id 링크로 Tempo Explore에 바로 들어간다.
```

`Load 40 - Cause Candidates`는 원인을 확정하는 화면이 아니다. 아직 metric 계약이 없는 connection pool wait, queue depth, consumer lag 같은 항목은 readiness/stat/table 패널로 먼저 드러내며, 없는 신호를 억지 PromQL로 정상처럼 보이게 만들지 않는다. 값이 비어 있으면 해당 metric 수집 계약이나 exporter 배포가 먼저 필요하다.

Loki 로그 확인은 `Logs 10 - Overview`부터 시작한다. Overview는 서비스 5xx, slow request, warning/error, synthetic 실패, Kong 4xx/5xx처럼 큰 이상 신호와 24시간 RED(request/error/duration) 흐름을 먼저 보여주고 원문 로그를 많이 두지 않는다. 서비스/route/status/latency 범위를 넓게 비교할 때는 `Logs 20 - Services and Requests`를 보고, 평상시 trace 후보를 찾을 때는 `Logs 25 - Service Log Search`에서 최근 서비스 요청 로그와 전체 Tempo trace 목록을 함께 본 뒤 trace_id, user_id, request_id를 JSON field로 검색한다. 이후 `Logs 30 - Service Errors`에서 서비스별 에러 로그를 나눠 본 뒤, `Logs 40 - Drilldown`에서 `request_id`, `trace_id`, reservation/payment/ticket ID를 JSON field로 검색한다. 특정 서비스 장애를 깊게 볼 때는 `Logs 80 - Service Trace Detail`에서 서비스 하나를 고르고 에러 로그, 요청 흐름, request_id, trace_id, Tempo trace를 한 화면에서 추적한다.

로그 전용 dashboard는 아래 레이어로 나눈다.

```text
Logs 10 - Overview       큰 이상 신호와 최근 증가 흐름
Logs 20 - Services and Requests
                         ticketing-* 서비스별 로그량, warn/error, 5xx, slow request, route/status/latency
Logs 25 - Service Log Search
                         최근 요청 로그, 전체 Tempo trace 목록, trace_id/user_id/request_id 검색
Logs 30 - Service Errors 서비스별 에러 로그 수치와 서비스별 원문 에러 로그
Logs 40 - Drilldown      request_id, trace_id, 업무 객체 ID 기반 원문 검색
Logs 50 - Synthetic      synthetic runner run/step/result 로그
Logs 60 - Business Flow  예약/결제/티켓/알림 이벤트 로그
Logs 70 - Platform       Kong, DB, Kafka, Collector, Loki 로그
Logs 80 - Service Trace Detail
                         서비스별 에러/요청 로그, request_id, trace_id, Tempo trace 상세 추적
```

기본 request 패널은 `/health`, `/metrics`, `/readyz` 성공 로그를 제외한다. `trace_id`, `request_id`, `synthetic_run_id`, reservation/payment/ticket ID는 Loki label로 쓰지 않고 `| json` 이후 본문 field로 검색한다. Synthetic 상태와 journey 결과는 `Logs 50 - Synthetic`에서만 다루고, 서비스 상세 추적 dashboard에는 synthetic 패널을 섞지 않는다. 비즈니스 이벤트 로그가 아직 부족한 서비스는 현재 구조화 로그의 `event` field 기준으로만 표시하며, 별도 service 로그 스키마나 Collector drop/sampling 정책 변경은 이 dashboard 작업 범위에 포함하지 않는다.

Pod stdout/stderr 수집은 `platform/observability/collector/values/aws-dev.yaml`의 DaemonSet `filelog` receiver가 `/var/log/pods/*/*/*.log`를 읽어 Loki OTLP endpoint로 전달하는 구조다. `ImagePullBackOff`, `FailedToRetrieveImagePullSecret`처럼 컨테이너 시작 전 실패는 컨테이너 로그가 없을 수 있으므로 `04 Pod Logs and Waiting Reasons`에서 kube-state-metrics의 waiting reason을 함께 본다. Kubernetes Event를 Loki 로그로 장기 보관하려면 DaemonSet Collector에 event watch receiver를 바로 추가하지 않고, 중복 수집을 피하는 별도 cluster-scoped Collector 배포로 설계한다.

## Docker Desktop 로컬 테스트

로컬에서는 운영 values 대신 `values/kube-prometheus-stack-local.yaml`을 사용한다. 이 values는 public image, 짧은 retention, Grafana 비영구 저장소를 기준으로 둔다.

```bash
task dev
```

`task dev`는 Prometheus stack을 먼저 설치한 뒤 백엔드 서비스 Helm release를 배포한다. 기본 `values/env/dev.yaml`은 서비스별 `/metrics`가 scrape 대상에 등록되도록 `ServiceMonitor`를 켠다. 기본 로컬 대상은 `DEV_SERVICES="auth concert notification payment reservation ticket"`이며 dashboard는 로컬 dev/metrics 검증 대상에서 제외한다.
서비스 chart는 `ServiceMonitor`가 켜진 경우 `monitoring` namespace의 Prometheus가 `/metrics` 포트에 접근할 수 있도록 서비스 `NetworkPolicy`에 scrape 허용 규칙을 함께 추가한다.

Prometheus UI는 port-forward로 연다.

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
```

Grafana UI는 다음처럼 연다.

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
```

로컬 Grafana 계정은 `admin` / `prom-local`이다.

Prometheus에서 확인할 query:

```promql
up
kube_pod_container_status_ready
container_cpu_usage_seconds_total
http_requests_total
rate(http_request_duration_seconds_count[5m])
```

ServiceMonitor 생성 여부는 다음 명령으로 확인한다.

```bash
kubectl get servicemonitor --all-namespaces -l release=kube-prometheus-stack
```

정리는 `task dev:down` 하나로 서비스 release, Tempo/Loki backend, Prometheus stack, Kong, data, namespace를 정리한다.

```bash
task dev:down
```
