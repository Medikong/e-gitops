---
id: ADR-0001
title: 서비스별 독립 배포를 위해 공통 Helm chart와 values layering을 사용한다
status: accepted
date: 2026-05-21
decision_owner: Medikong GitOps
related:
  - ../PRD.md
  - ../architecture/service-release-model.md
tags:
  - gitops
  - kubernetes
  - helm
  - argocd
  - service-release
---

# ADR-0001: 서비스별 독립 배포를 위해 공통 Helm chart와 values layering을 사용한다

## 배경

기존 Kustomize 구조는 namespace, storage, Kong, network policy, app, dependency, overlay를 레이어 중심으로 관리했다.

이 구조는 Kubernetes 자산을 초기 이주하고 전체 manifest를 한 번에 렌더링하기에는 적합했다. 하지만 PRD의 장기 목표는 서비스별 독립 배포, 독립 확장, 장애 격리다. 레이어 중심 구조만 유지하면 서비스 하나를 배포하거나 롤백하려고 할 때 다른 서비스와 같은 묶음 안에서 함께 다뤄질 가능성이 커진다.

따라서 기존 Kustomize 구조는 `archive/k8s-kustomize/`에 reference로 보존하고, 새 운영 경로는 `charts/`, `values/`, `platform/`, `argo/`, `Taskfile.yml`로 전환한다.

장기적으로 관리해야 할 환경은 다음처럼 명확히 나눈다.

| 환경 | 목적 |
| --- | --- |
| `local-docker-desktop-kubeadm` | Docker Desktop Kubernetes에서 kubeadm 계열 구성을 검증하며 Docker Desktop용 local registry를 쓴다 |
| `local-docker-desktop-kind` | Docker Desktop runtime 위 kind-style 구성을 values로 검증 |
| `local-vm-kubeadm` | VM 기반 kubeadm 클러스터 검증 |
| `aws-dev` | 클라우드 개발/지속 검증 환경 |
| `aws-prod` | 운영 목표 환경 |

AWS scenario는 단일 환경이 아니라 `aws-scenario-network`, `aws-scenario-hpa`, `aws-scenario-storage`, `aws-scenario-release` 검증 시나리오 values로 둔다.

서비스별로 필요한 Kubernetes 리소스는 거의 같은 패턴을 가진다.

- `Deployment`
- `Service`
- `Ingress` 또는 Kong route 연동 리소스
- `ServiceAccount`
- `Role`, `RoleBinding`
- `NetworkPolicy`
- `PodDisruptionBudget`
- `HorizontalPodAutoscaler`
- `ServiceMonitor`

이 리소스들을 서비스마다 순수 YAML로 복제하면 중복이 커진다. 반대로 서비스별 values를 리소스 단위 파일로 너무 잘게 쪼개면 파일 수와 Argo CD `valueFiles` 목록이 빠르게 늘어난다.

## 결정

서비스별 독립 배포의 기본 단위는 Helm release로 본다.

공통 Kubernetes 리소스 템플릿은 공통 Helm chart에 둔다.

```text
charts/
  medikong-service/
    templates/
      deployment.yaml
      service.yaml
      ingress.yaml
      serviceaccount.yaml
      role.yaml
      rolebinding.yaml
      networkpolicy.yaml
      pdb.yaml
      hpa.yaml
      servicemonitor.yaml
```

공통 기본값, 환경별 값, 서비스별 값, 예외 override는 다음 구조로 둔다.

```text
values/
  base.yaml
  env/
    local-docker-desktop-kubeadm.yaml
    local-docker-desktop-kind.yaml
    local-vm-kubeadm.yaml
    aws-dev.yaml
    aws-prod.yaml
  services/
    auth.yaml
    concert.yaml
    reservation.yaml
    payment.yaml
    ticket.yaml
    notification.yaml
    dashboard.yaml
  scenarios/
    aws/
      base.yaml
      network.yaml
      hpa.yaml
      storage.yaml
      release.yaml
  overrides/
    aws-prod/
```

플랫폼 공통 리소스는 서비스 Helm release와 분리한다.

```text
platform/
  namespaces/
  kong/
  observability/
  policies/
  data/
```

Helm values 적용 순서는 다음 원칙을 따른다.

```text
base
-> env
-> service
-> optional service-env override
```

AWS scenario는 다음 순서로 합성한다.

```text
base
-> scenarios/aws/base
-> service
-> scenarios/aws/<experiment>
```

## 책임 경계

공통 Helm chart는 서비스 배포 표준이다. values 파일은 그 표준에 넣을 입력값이다.

| 영역 | 위치 | 원칙 |
| --- | --- | --- |
| 공통 Kubernetes manifest template | `charts/medikong-service/templates/*` | 중복을 줄이고 배포 표준을 강제한다 |
| 공통 기본값 | `values/base.yaml` | 모든 환경과 서비스에 적용되는 기본값을 둔다 |
| 환경 공통값 | `values/env/*` | runtime/provisioner 또는 지속 환경 차이를 표현한다 |
| AWS scenario 값 | `values/scenarios/aws/*` | 코드 기반 Kubernetes 검증 시나리오 차이를 환경과 분리한다 |
| 서비스별 값 | `values/services/<service>.yaml` | image, port, env, route, resource 등 서비스 고유 설정을 둔다 |
| 예외 override | `values/overrides/<env>/<service>.yaml` | 특정 서비스와 환경의 예외만 둔다 |
| 플랫폼 공통 리소스 | `platform/*` | namespace, gateway, observability, policy, data처럼 서비스 release와 lifecycle이 다른 리소스를 둔다 |
| Kustomize reference | `archive/k8s-kustomize/*` | 이식 근거로만 남기고 운영 경로로 사용하지 않는다 |

Namespace 생성은 기본적으로 `platform/namespaces`에서 먼저 관리한다.

서비스 release는 해당 namespace 안의 `Deployment`, `Service`, `Ingress`, `NetworkPolicy`, `ServiceAccount`, `PDB`, `HPA`, `ServiceMonitor`를 관리한다.

## 단일 서비스 배포 흐름

`reservation` 서비스만 배포할 때는 서비스 image를 service/release pipeline에서 만들고 registry에 게시한 뒤, GitOps repo에서 `reservation`의 image tag만 갱신한다.

```text
service repo
-> reservation-service image build/push
-> gitops repo values/services/reservation.yaml 또는 values/overrides/<env>/reservation.yaml image tag update
-> Argo CD reservation-aws-dev Application sync
-> Kubernetes reservation Deployment rollout
```

Docker Desktop local dev에서는 개발 편의를 위해 GitOps repo의 `task dev:images`와 `task dev`가 service repo의 공개 Taskfile target을 호출한다. 이 의존은 local dev 명령에만 존재하며, 운영/AWS Argo CD bootstrap은 `SERVICE_REPO`에 의존하지 않는다.

```bash
task dev SERVICE_REPO=../service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev
```

Docker Desktop dev registry는 VM lab registry인 `10.10.10.10:5000`과 분리한다. kindest-node 기반 multi-node 클러스터에서는 host Docker image store가 Pod pull 경로가 아니므로, local registry에 push하고 node containerd mirror를 통해 pull한다.

다른 서비스의 values나 Argo CD Application은 변경하지 않는다.

환경 공통값인 `values/env/aws-dev.yaml`을 바꾸면 해당 환경의 여러 서비스에 영향을 줄 수 있다. 그래서 단일 서비스 배포에서는 `values/services/<service>.yaml` 또는 `values/overrides/<env>/<service>.yaml`만 변경하는 것을 원칙으로 한다.

## 대안

### 대안 1: 서비스별 폴더 아래 관심사 단위 values fragment를 둔다

```text
apps/
  reservation/
    values.yaml
    networking.yaml
    scaling.yaml
    observability.yaml
```

장점은 서비스 폴더만 보면 해당 서비스 설정을 모아볼 수 있다는 점이다. 단점은 Helm의 기본적인 values layering 구조보다 valueFiles 목록이 길어지고, 서비스 폴더 구조가 또 하나의 자체 규칙이 된다는 점이다.

### 대안 2: 구성요소별 values 파일을 더 잘게 나눈다

```text
apps/reservation/values/deployment.yaml
apps/reservation/values/service.yaml
apps/reservation/values/ingress.yaml
apps/reservation/values/network-policy.yaml
apps/reservation/values/hpa.yaml
apps/reservation/values/pdb.yaml
```

장점은 Kubernetes 리소스와 파일이 1:1로 대응되어 직관적이라는 점이다. 단점은 파일 수가 빠르게 늘고, Argo CD `valueFiles` 목록이 장황해지며, port처럼 여러 리소스에 걸친 값을 놓치기 쉽다는 점이다.

### 대안 3: 서비스별 chart를 완전히 분리한다

```text
charts/reservation/
charts/concert/
charts/auth/
```

장점은 서비스별 자유도가 크다는 점이다. 단점은 거의 같은 템플릿이 서비스마다 복제되고, 보안 기본값이나 배포 표준을 일괄 적용하기 어려워진다는 점이다.

## 결과

이 결정으로 다음 장점이 생긴다.

- 서비스 하나가 Helm release 하나로 배포된다.
- `reservation`만 sync, rollback, canary 전환하는 흐름을 만들 수 있다.
- 공통 Kubernetes manifest template 중복이 줄어든다.
- 환경별 차이는 `values/env/*`로 관리한다.
- AWS scenario는 `values/scenarios/aws/*`로 관리한다.
- 서비스별 차이는 `values/services/*`로 관리한다.
- 특정 서비스와 환경의 예외만 `values/overrides/*`에 둔다.
- Helm의 일반적인 values layering 방식에 맞춰 repo 규칙을 단순하게 유지한다.

동시에 다음 위험이 생긴다.

- 공통 chart 변경의 영향 범위가 모든 서비스와 환경으로 커질 수 있다.
- 공통 chart 변경이 협업 병목이 될 수 있다.
- values merge 순서가 배포 결과에 영향을 준다.
- chart가 모든 예외를 받아주기 시작하면 템플릿이 복잡해질 수 있다.
- `values/services/<service>.yaml`이 커지면 서비스 내부 관심사가 한 파일에 섞일 수 있다.

## 대응책

공통 chart 변경은 플랫폼 배포 표준 변경으로 취급한다.

- chart template 변경 PR과 서비스 image tag 변경 PR은 분리한다.
- chart 변경 시 모든 서비스와 주요 환경 조합을 `helm template`으로 렌더링한다.
- AWS scenario values도 모든 서비스에 대해 렌더링한다.
- `values.schema.json`을 추가해 필수 값과 타입을 검증한다.
- `helm lint`와 manifest 보안 스캔을 CI에서 실행한다.
- 공통 chart가 지나치게 많은 예외를 품기 시작하면 chart를 유형별로 나눈다.
- 서비스 values 파일이 너무 커지면 단일 서비스 안에서만 구조를 재검토하되, 기본 repo 구조는 `values/services/<service>.yaml`를 유지한다.

장기적으로 서비스 유형이 갈라지면 다음처럼 chart를 분리할 수 있다.

```text
charts/
  medikong-api-service/
  medikong-worker/
  medikong-frontend/
```

초기에는 `medikong-service` 하나로 시작하되, chart가 복잡해지는 시점을 chart 분리의 신호로 본다.

## 검증 기준

이 결정이 실제 구조로 구현되면 다음 검증이 가능해야 한다.

```bash
task validate
task helm:lint
task helm:template:one SERVICE=reservation ENV=aws-dev
task helm:template:service SERVICE=reservation
task helm:template:env ENV=local-vm-kubeadm
task scenario:network
```

기존 사용자는 Makefile wrapper를 쓸 수 있다.

```bash
make validate
make helm-lint
make helm-template SERVICE=reservation ENV=aws-prod
```

공통 chart가 바뀐 경우에는 모든 서비스와 주요 환경 조합을 렌더링해야 한다. 서비스 values만 바뀐 경우에는 해당 서비스와 대상 환경 렌더링을 최소 검증 단위로 삼는다.
