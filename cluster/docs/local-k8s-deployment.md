# Local Kubernetes Deployment Loop

이 문서는 준비된 로컬 Kubernetes 클러스터 위에서 GitOps manifest를 검증하고 적용하는 흐름을 정리합니다.

## 경계

| 영역 | 담당 |
|---|---|
| 서버와 클러스터 준비 | infra repo |
| local registry 준비 | infra repo 또는 선별 Ansible playbook |
| 앱 image 생성과 게시 | service release pipeline |
| image tag 반영 | 이 GitOps repo |
| DB/Kafka manifest 적용 | `k8s/overlays/local/deps` |
| 앱 manifest 적용 | `k8s/overlays/local/apps` |
| 전체 manifest 적용 | `k8s/overlays/local/all` |

## 구성

| 항목 | 값 |
|---|---|
| Registry | `10.10.10.10:5000` |
| All overlay | `k8s/overlays/local/all` |
| Apps overlay | `k8s/overlays/local/apps` |
| Deps overlay | `k8s/overlays/local/deps` |
| API Gateway | `http://10.10.10.240` |

## Manifest 검증

```bash
make validate
make render-local-all
kubectl kustomize k8s/overlays/local/apps
kubectl kustomize k8s/overlays/local/deps
```

## Image Tag 반영

```bash
make update-local-image-tags IMAGE_TAG=dev-001
make render-local-all
```

이 명령은 `k8s/overlays/local/apps/kustomization.yaml`의 앱 image tag만 갱신합니다. image 생성과 push는 이 repo 밖에서 끝난 상태여야 합니다.

## 수동 적용

GitOps 기본 흐름에서는 Argo CD가 적용합니다. 장애 조사나 로컬 실험에서만 현재 kubeconfig 대상 클러스터에 직접 적용합니다.

```bash
kubectl apply -k k8s/overlays/local/deps
cluster/scripts/verify-local-k8s-deps.sh

kubectl apply -k k8s/overlays/local/apps
cluster/scripts/verify-local-k8s-apps.sh
cluster/scripts/show-local-k8s-status.sh
```

전체 상태를 다시 맞출 때는 다음을 사용합니다.

```bash
kubectl apply -k k8s/overlays/local/all
```

## Docker CA

local registry가 사설 CA를 쓰는 경우, infra repo가 만든 inventory를 지정해서 CA를 가져올 수 있습니다.

```bash
ANSIBLE_INVENTORY=/path/to/inventory.ini cluster/scripts/install-registry-ca.sh
```

## Smoke

```bash
cluster/scripts/local-k8s-crud-smoke.sh
```
