# Medikong GitOps

이 repo는 준비된 Kubernetes 클러스터 위에서 MediKong 배포 선언과 운영 add-on을 관리하는 GitOps 전담 repo입니다.

서비스 코드, 이미지 빌드, VM 생성, 서버 초기 bootstrap은 이 repo의 책임이 아닙니다. 여기서는 이미 만들어진 container image tag를 Kustomize overlay에 반영하고, Argo CD가 그 선언을 클러스터에 동기화하도록 관리합니다.

## 책임 범위

| 포함 | 설명 |
| --- | --- |
| `k8s/` | Kubernetes base, Kustomize overlay, namespace, storage, Kong, MetalLB, NetworkPolicy |
| `argo/` | Argo CD Application과 설치 보조 스크립트 |
| `cluster/ansible/` | 준비된 서버 위에서 Kubernetes cluster와 운영 add-on을 확인하거나 bootstrap하는 선별 playbook |
| `cluster/scripts/` | MetalLB, local registry CA, image tag 갱신, Kubernetes 상태 확인 스크립트 |
| `cluster/stacks/observability/` | Prometheus, Grafana, Loki, Alloy, Tempo values, manifest |
| `.github/workflows/` | GitOps manifest 렌더링과 Kubernetes 보안 스캔 |

## 제외 범위

| 제외 | 담당 repo |
| --- | --- |
| Terraform, cloud network, VM topology | infra repo |
| infra repo VM definition, VM 생성, SSH key 동기화 | infra repo |
| 서버 패키지 설치, OS 초기 bootstrap | infra repo |
| FastAPI 서비스 코드와 frontend 코드 | services repo |
| 서비스 단위 테스트, Docker Compose E2E | services repo |
| image publishing pipeline | services repo 또는 release pipeline |

## 기본 흐름

1. service release pipeline이 container image를 만들고 registry에 게시합니다.
2. 이 repo에서 image tag를 Kustomize overlay에 반영합니다.
3. GitOps 검증 workflow가 Kustomize 렌더링과 manifest 보안 스캔을 실행합니다.
4. Argo CD가 `Medikong/gitops`의 overlay 경로를 감시하고 클러스터에 동기화합니다.

## 자주 쓰는 명령

```bash
make validate
make render-local-all
make render-aws-all
make update-local-image-tags IMAGE_TAG=dev-001
```

`update-local-image-tags`는 local overlay의 image tag만 바꿉니다. 이미지를 build하거나 push하지 않습니다.

```bash
make update-local-image-tags IMAGE_TAG=dev-001 REGISTRY=10.10.10.10:5000
```

Argo CD가 볼 기본 Application은 `argo/application.yaml`입니다.

```bash
kubectl apply -f argo/application.yaml -n argocd
```

## 구조

```text
gitops/
  README.md
  Makefile
  .github/
    workflows/
      gitops-validate.yml
      k8s-security-scan.yml
  argo/
  k8s/
  cluster/
    ansible/
      group_vars/
      playbooks/
    docs/
    scripts/
    stacks/
      observability/
```

## 운영 메모

- `k8s/overlays/local/all`은 로컬 kubeadm 클러스터 전체 manifest 렌더링 entrypoint입니다.
- `k8s/overlays/aws/all`은 AWS 배포 실험용 overlay entrypoint입니다.
- `cluster/ansible`에는 inventory를 포함하지 않습니다. inventory와 VM topology는 infra repo에서 준비한 값을 사용합니다.
- `cluster/stacks/observability/install.sh`는 `cluster/stacks/observability` 디렉터리에서 실행합니다.
- live cluster에 직접 적용하는 명령은 명시적으로 실행할 때만 사용합니다.
