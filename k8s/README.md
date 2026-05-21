# Kubernetes Manifests

이 디렉터리는 MediKong을 Kubernetes에 배포하기 위한 manifest와 Kustomize overlay를 관리합니다. 서비스 소스나 이미지 빌드 과정은 포함하지 않고, 이미 registry에 올라간 image tag를 배포 선언에 반영합니다.

## 배포 구조

| Namespace | 리소스 |
| --- | --- |
| `medical-auth` | auth-service, auth-db, auth Ingress, KongConsumer, JWT Secret |
| `medical-messaging` | Kafka StatefulSet, topic Job |
| `medical-patient` | patient-service, patient-db, patient Ingress |
| `medical-appointment` | appointment-service, appointment-db, appointment Ingress |
| `medical-prescription` | prescription-service, prescription-db, prescription Ingress |
| `medical-notification` | notification-service, notification-db, notification Ingress |
| `medical-dashboard` | dashboard Deployment/Service, dashboard Ingress |
| `kong` | Kong Gateway와 Kong Ingress Controller |
| `metallb-system` | MetalLB |

## 주요 디렉터리

```text
k8s/
  base/
    apps/                  # 서비스 Deployment/Service 원본
    deps/                  # PostgreSQL, Kafka, PV 원본
  ingress/                 # 서비스별 Kong Ingress
  kong/                    # Kong Helm values, KongClusterPlugin, consumer
  metallb/                 # MetalLB address pool
  namespaces/              # medical-* namespace
  network-policies/        # namespace 간 ingress 정책
  overlays/
    local/                 # local registry, MetalLB, hostPath PV 기준
    aws/                   # ECR image와 AWS smoke cluster 기준
    docker-desktop/        # Docker Desktop Kubernetes 실험용
```

## 렌더링

```bash
make render-local-all
make render-aws-all
kubectl kustomize k8s/overlays/local/apps
kubectl kustomize k8s/overlays/local/deps
```

## Image Tag 갱신

로컬 overlay의 앱 image tag만 갱신합니다. 이 명령은 이미지를 만들거나 push하지 않습니다.

```bash
make update-local-image-tags IMAGE_TAG=dev-001
make update-local-image-tags IMAGE_TAG=dev-001 REGISTRY=10.10.10.10:5000
```

AWS overlay의 ECR repository와 tag는 `k8s/overlays/aws/all/kustomization.yaml`에서 관리합니다.

## 적용과 확인

GitOps 기본 흐름에서는 Argo CD가 overlay를 적용합니다. 수동 검증이 필요할 때만 현재 kubeconfig가 가리키는 클러스터에 직접 적용합니다.

```bash
kubectl apply -k k8s/overlays/local/all
cluster/scripts/verify-local-k8s-deps.sh
cluster/scripts/verify-local-k8s-apps.sh
cluster/scripts/show-local-k8s-status.sh
```

직접 확인:

```bash
kubectl get pods -A -o wide
kubectl get svc -A
kubectl get ingress -A
kubectl get pvc -A
kubectl get kongclusterplugins
kubectl get kongconsumers -A
```
