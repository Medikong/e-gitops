# Observability Stack

이 디렉터리는 준비된 Kubernetes 클러스터 위에 설치되는 Observability stack을 관리합니다.

## 범위

| 구성 요소 | Helm chart | 역할 |
|---|---|---|
| Prometheus/Grafana | `prometheus-community/kube-prometheus-stack` | Kubernetes 기본 메트릭 수집과 Grafana UI |
| Loki | `grafana/loki` | 로그 저장소 |
| Grafana Alloy | `grafana/alloy` | Kubernetes pod 로그 수집 agent |
| Tempo | `grafana/tempo` | trace 저장소 기반 |

Kong Ingress, Kafka consumer lag exporter, alert rule 설계는 별도 작업으로 둡니다. OpenTelemetry Collector는 trace instrumentation 방향이 정해진 뒤 추가합니다.

## 설치

기본 namespace는 `observability`입니다.

```bash
make observability-install
kubectl get pods -n observability -o wide
```

`install.sh`는 `cluster/stacks/observability` 디렉터리에서 실행되어야 합니다. 루트 `Makefile`의 `observability-install` target은 이 위치 이동을 포함합니다.

## Local Persistence

기본 kubeadm 클러스터에는 StorageClass가 없으므로 `manifests/local-pv.yaml`로 `platform-1` hostPath 기반 정적 PV를 먼저 적용합니다. Grafana, Prometheus, Loki, Tempo의 PVC는 이 PV에 바인딩되고, 데이터는 `platform-1`의 `/var/lib/cloudnative-observability/` 아래에 저장됩니다.

저장소 디렉터리는 선별 Ansible playbook으로 준비할 수 있습니다.

```bash
make ANSIBLE_INVENTORY=/path/to/inventory.ini observability-storage-bootstrap
```

## Node Placement

기본 values는 주요 observability component가 platform tier에 배치되도록 `nodeSelector`를 준비합니다. Alloy는 pod 로그 수집 agent라 DaemonSet으로 각 노드에서 실행됩니다.

```text
node-role.kubernetes.io/platform=true
workload.medical-platform.io/tier=platform
```

## Dashboards as Code

Grafana dashboard는 UI에서 수동 생성하지 않고 `dashboards/*.json` 파일로 관리합니다. `install.sh`는 이 JSON 파일들을 `cloudnative-grafana-dashboards` ConfigMap으로 적용하고, Grafana sidecar는 `grafana_dashboard=1` label이 붙은 ConfigMap을 읽어 dashboard를 자동 반영합니다.

기본 클러스터 보조 대시보드는 `dashboards/local-kubernetes-overview.json`입니다.
