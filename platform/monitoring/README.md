# Monitoring platform resources

`platform/monitoring`은 `monitoring` namespace 기준 Prometheus 기본 스택의 GitOps 운영 경로다.

## 범위

- `manifests/namespace.yaml`: `monitoring` namespace를 만든다.
- `manifests/istio-mesh-podmonitors.yaml`: Istio control plane과 첫 mesh 대상인 `concert-service` Envoy sidecar metric을 수집한다.
- `values/kube-prometheus-stack.yaml`: `prometheus-community/kube-prometheus-stack` values를 관리한다.
- Grafana datasource는 이 values에서 함께 관리한다. Prometheus는 기본 datasource, Tempo/Loki는 `additionalDataSources`로 선언한다.
- 서비스별 `ServiceMonitor`는 계속 `charts/medikong-service` release가 관리한다.

## Sync 순서

1. Argo CD root Application이 `argo/applications/aws-dev/platform`과 `argo/applications/aws-dev/services`를 함께 읽는다.
2. `monitoring-aws-dev` Application은 sync wave `-20`으로 먼저 생성된다.
3. `platform/monitoring` Kustomize source가 `monitoring` namespace를 만든다.
4. `kube-prometheus-stack` Helm source가 Prometheus Operator CRD와 chart 리소스를 적용한다.
5. 서비스 Application이 만든 `ServiceMonitor`는 `release: kube-prometheus-stack` label로 Prometheus에 선택된다.
6. Istio mesh용 `PodMonitor`는 `monitoring` namespace에서 만들어지고 `release: kube-prometheus-stack` label로 Prometheus에 선택된다.
7. Tempo/Loki backend는 `platform/observability` Application들이 만든 service DNS로 연결된다.

## Istio mesh monitoring

Mesh monitoring은 첫 rollout에서 전체 namespace를 한 번에 열지 않는다. `concert-service`에 sidecar injection을 먼저 적용하고, 해당 Envoy sidecar metric부터 Prometheus에 수집한다.

수집 대상:

```text
istiod
  - namespace: istio-system
  - endpoint: /metrics
  - port: http-monitoring

concert-service Envoy sidecar
  - namespace: ticketing-concert
  - endpoint: /stats/prometheus
  - port: http-envoy-prom
```

PodMonitor는 `monitoring` namespace에 둔다. Prometheus 설정이 `podMonitorSelector.matchLabels.release=kube-prometheus-stack`와 `podMonitorNamespaceSelector`를 사용하기 때문이다.

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
