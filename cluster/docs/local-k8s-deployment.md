# Legacy VM kubeadm deployment loop

이 문서는 VM 기반 kubeadm 실습 경로를 해석하기 위한 reference다. 새 운영 경로는 `Taskfile.yml`, `charts/`, `values/`, `platform/`, `argo/`이며 기존 Kustomize manifest는 `archive/k8s-kustomize/`에 보관한다.

## 경계

| 영역 | 담당 |
| --- | --- |
| 서버와 클러스터 준비 | infra repo |
| registry 준비 | infra repo 또는 선별 Ansible playbook |
| 앱 image 생성과 게시 | service release pipeline |
| image tag 반영 | `values/services/*` 또는 `values/overrides/*` |
| DB/Kafka reference manifest | `archive/k8s-kustomize/base/deps` |
| 서비스 release render | `task helm:template:*` |
| 전체 검증 | `task validate` |

## 현재 기준

| 항목 | 값 |
| --- | --- |
| VM kubeadm env | `local-vm-kubeadm` |
| Registry | `10.10.10.10:5000` |
| Archived all overlay | `archive/k8s-kustomize/overlays/local/all` |
| Archived apps overlay | `archive/k8s-kustomize/overlays/local/apps` |
| Archived deps overlay | `archive/k8s-kustomize/overlays/local/deps` |
| API Gateway 후보 | `http://10.10.10.240` |

## Manifest 검증

새 기준 검증은 Helm values layering을 사용한다.

```bash
task validate
task helm:template:env ENV=local-vm-kubeadm
```

기존 Kustomize 구조를 reference로만 확인해야 할 때는 archive 경로를 직접 지정한다.

```bash
kubectl kustomize archive/k8s-kustomize/overlays/local/apps
kubectl kustomize archive/k8s-kustomize/overlays/local/deps
```

## Image Tag 반영

새 기준에서는 서비스별 values를 바꾼다.

```bash
task helm:template:one SERVICE=reservation ENV=local-vm-kubeadm
```

기존 Kustomize image tag helper는 Makefile의 deprecated wrapper로만 남긴다.

```bash
make update-local-image-tags IMAGE_TAG=dev-001
```

## 수동 적용

GitOps 기본 흐름에서는 Argo CD가 적용한다. 장애 조사나 실험에서 직접 적용이 필요하면 archive 경로를 명시하고, 이 작업이 새 운영 경로가 아니라 reference 적용임을 먼저 확인한다.

```bash
kubectl apply -k archive/k8s-kustomize/overlays/local/deps
kubectl apply -k archive/k8s-kustomize/overlays/local/apps
```

## Registry CA

registry가 사설 CA를 쓰는 경우, infra repo가 만든 inventory를 지정해서 CA를 가져올 수 있다.

```bash
ANSIBLE_INVENTORY=/path/to/inventory.ini cluster/scripts/install-registry-ca.sh
```

## Smoke

새 기준의 smoke는 서비스별 API 스크립트가 아니라 GitOps render와 cluster 상태 확인으로 나눈다.

```bash
task validate
task dev:status
```
