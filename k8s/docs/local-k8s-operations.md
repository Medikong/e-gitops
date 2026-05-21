# Local Kubernetes Operations

이 문서는 준비된 로컬 Kubernetes 클러스터에서 GitOps manifest를 렌더링하고, 필요할 때 수동으로 적용해 상태를 좁히는 명령을 정리합니다.

## 기본 루프

```bash
make render-local-all
kubectl apply -k k8s/overlays/local/all
cluster/scripts/verify-local-k8s-deps.sh
cluster/scripts/verify-local-k8s-apps.sh
cluster/scripts/show-local-k8s-status.sh
```

앱 이미지가 새로 배포되었다면 이 repo에서는 image tag만 바꿉니다.

```bash
make update-local-image-tags IMAGE_TAG=dev-001
make render-local-all
```

## Kustomize Entry Points

| 경로 | 포함 리소스 | 사용 시점 |
|---|---|---|
| `k8s/overlays/local/apps` | namespace, Kong plugins/consumers, 앱 Deployment/Service/Ingress, local registry image tag | 앱 manifest 또는 이미지 태그 변경 |
| `k8s/overlays/local/deps` | namespace, PostgreSQL PV/StatefulSet/Service, Kafka PV/PVC/StatefulSet/Service | DB/Kafka manifest 변경 |
| `k8s/overlays/local/all` | namespace, storage, Kong, network policy, deps, apps | 최초 전체 적용 또는 전체 상태 동기화 |

Kafka는 `medical-messaging` 네임스페이스의 `kafka` Service로 노출되며 앱은 `kafka.medical-messaging.svc.cluster.local:9092`를 사용합니다. 로컬 hostPath PV는 `k8s/storage/pv.yaml`에 둡니다.

## 확인 항목

| 확인 | 명령 | 통과 기준 |
|---|---|---|
| 렌더링 | `make render-local-all` | Kustomize 렌더링 성공 |
| 의존성 Ready | `cluster/scripts/verify-local-k8s-deps.sh` | DB/Kafka StatefulSet Ready |
| 앱 Ready | `cluster/scripts/verify-local-k8s-apps.sh` | 앱 Deployment rollout 완료 |
| gateway 통신 | `cluster/scripts/local-k8s-crud-smoke.sh` | Kong Gateway로 환자 생성/조회 성공 |
| runtime 상태 | `cluster/scripts/show-local-k8s-status.sh` | pod, service, ingress, PVC 상태 확인 |

## 직접 kubectl

```bash
kubectl get pods -A -o wide
kubectl get svc -A
kubectl get pvc -A
kubectl get events -A --sort-by=.lastTimestamp | tail -n 40
```
