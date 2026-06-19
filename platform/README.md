# Platform resources

`platform/`은 서비스 Helm release보다 먼저 준비되어야 하는 공통 Kubernetes 기반을 둔다.

| 영역 | 위치 | 현재 상태 |
| --- | --- | --- |
| Namespace | `platform/namespaces` | 운영 경로 |
| Storage | `platform/storage` | aws-dev EBS CSI와 private-dev local-path StorageClass 운영 경로 |
| Kong Gateway | `platform/kong` | `archive/k8s-kustomize/kong`에서 이식 필요 |
| Monitoring | `platform/monitoring` | `monitoring` namespace 기준 Prometheus 기본 스택 운영 경로 |
| Observability | `platform/observability` | Tempo, Loki 같은 trace/log backend 운영 경로 |
| Metrics Server | `platform/metrics-server` | HPA와 `kubectl top`이 사용하는 resource metrics 경로 |
| Policy | `platform/policies` | cluster-level 정책 추가 예정 |
| Data | `platform/data` | DB/Kafka 초기 dev 리소스 이식 필요 |

서비스별 `Deployment`, `Service`, `Ingress`, `ServiceAccount`, `Role`, `RoleBinding`, `NetworkPolicy`, `PDB`, `HPA`, `ServiceMonitor`는 `charts/medikong-service`와 `values/services/*`에서 관리한다.

Prometheus/Grafana는 `platform/monitoring`에 남기고, Tempo/Loki backend와 OpenTelemetry Collector trace pipeline은 `platform/observability/<component>`에 둔다.

aws-dev와 private-dev의 공통 PVC 정책은 `platform/storage`에서 관리한다. 관측성 backend와 monitoring stack은 환경별 StorageClass를 명시해 클러스터 default StorageClass에 암묵 의존하지 않는다.
