# 서비스 단위 Helm release 운영 구조

## 배경

기존 Kustomize 구조는 namespace, storage, Kong, network policy, app, dependency, overlay를 레이어 단위로 관리했다. 이 방식은 초기 Kubernetes 자산을 한 번에 이주하고 전체 platform을 파악하기에는 편했다.

하지만 PRD의 장기 목표는 서비스별 독립 배포, 독립 확장, 장애 격리다. 그래서 기존 구조는 `archive/k8s-kustomize/`에 reference로 보존하고, 새 운영 경로는 `charts/`, `values/`, `platform/`, `argo/`, `Taskfile.yml` 중심으로 전환한다.

## 목표 환경

로컬 환경은 runtime/provisioner가 드러나도록 분리한다. 모호한 단일 이름은 쓰지 않는다.

| 환경 | 목적 | 특징 |
| --- | --- | --- |
| `local-docker-desktop-kubeadm` | Docker Desktop Kubernetes에서 kubeadm 계열 구성을 빠르게 검증 | Docker Desktop용 local registry에 build/push 후 Pod가 pull |
| `local-docker-desktop-kind` | Docker Desktop runtime 위 kind-style 구성을 values로 검증 | kind registry 전제 values |
| `local-vm-kubeadm` | VM 기반 kubeadm 클러스터 검증 | `10.10.10.10:5000` registry 경로 |
| `aws-dev` | 지속 검증용 클라우드 개발 환경 | ECR image, HPA/PDB/ServiceMonitor |
| `aws-prod` | 운영 목표 환경 | 더 엄격한 리소스와 운영 override |

AWS 검증은 단일 환경이 아니라 코드 기반 Kubernetes 시나리오로 둔다.

| 시나리오 | 목적 |
| --- | --- |
| `aws-scenario-network` | Kong/Ingress/NetworkPolicy 경로 확인 |
| `aws-scenario-hpa` | HPA 기준과 replica 동작 확인 |
| `aws-scenario-storage` | storage/data 연동 후보 검증 |
| `aws-scenario-release` | release 안정성, PDB, ServiceMonitor 확인 |

## 결정된 구조

서비스별 독립 배포의 기본 단위는 Helm release다. 공통 Kubernetes 리소스 템플릿은 `charts/medikong-service/templates/*`에 둔다.

```text
gitops/
  charts/
    medikong-service/
      Chart.yaml
      values.yaml
      values.schema.json
      templates/
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
  platform/
    namespaces/
    kong/
    observability/
    policies/
    data/
  argo/
    applications/
      aws-dev/
        services/
  archive/
    k8s-kustomize/
```

values 적용 순서는 다음이다.

```text
base
-> env
-> service
-> optional service-env override
```

예를 들어 `reservation`을 `aws-dev`에 렌더링할 때는 다음처럼 조합한다.

```bash
helm template reservation-aws-dev charts/medikong-service \
  -f values/base.yaml \
  -f values/env/aws-dev.yaml \
  -f values/services/reservation.yaml
```

`aws-prod`에서 특정 서비스만 별도 리소스나 replica 설정이 필요하면 `values/overrides/aws-prod/<service>.yaml`을 추가하고 마지막 layer로 합성한다. 현재 기준선에는 서비스별 `aws-prod` override를 두지 않는다.

```bash
helm template reservation-aws-prod charts/medikong-service \
  -f values/base.yaml \
  -f values/env/aws-prod.yaml \
  -f values/services/reservation.yaml
```

AWS scenario는 환경 파일이 아니라 scenario layer로 합성한다.

```bash
helm template reservation-aws-scenario-network charts/medikong-service \
  -f values/base.yaml \
  -f values/scenarios/aws/base.yaml \
  -f values/services/reservation.yaml \
  -f values/scenarios/aws/network.yaml
```

## Platform과 Service의 경계

모든 것을 서비스 chart에 넣지는 않는다. 플랫폼 공통 리소스와 서비스 리소스를 분리한다.

| 영역 | 위치 | 이유 |
| --- | --- | --- |
| Namespace 기본 생성 | `platform/namespaces` | 서비스 release보다 먼저 있어야 하는 공통 기반 |
| Kong Gateway 설치 | `platform/kong` | gateway 자체는 서비스가 아니라 cluster ingress layer |
| Observability stack | `platform/observability` | Prometheus, Grafana, Loki, Tempo는 공통 운영 add-on |
| Gatekeeper/Falco | `platform/policies` | cluster-level 보안 정책 |
| Data/Messaging | `platform/data` 또는 별도 chart | DB/Kafka lifecycle은 앱 Deployment와 분리 |
| Deployment/Service/Ingress | `charts/medikong-service` + `values/services/*` | 서비스 배포와 함께 바뀌는 release 리소스 |
| ServiceMonitor | `charts/medikong-service` + values | 서비스별 metrics endpoint와 함께 관리 |
| ServiceAccount/RBAC | `charts/medikong-service` + values | 최소 권한 원칙을 서비스 단위로 적용 |
| NetworkPolicy | `charts/medikong-service` + values | 서비스 간 통신 경계를 서비스 단위로 검증 |

기존 Kustomize 자산의 이식 목록은 `docs/architecture/k8s-kustomize-archive-inventory.md`에 둔다.

## Image Tag 관리

GitOps repo는 image를 만들지 않는다.

서비스 repo 또는 release pipeline이 image를 만들고 registry에 게시한다. GitOps repo는 그 결과 tag를 values에 반영한다.

```yaml
image:
  repository: reservation-service
  tag: 2026.05.21-abc1234
```

registry처럼 환경별로 달라지는 값은 `values/env/*`에 둔다.

```yaml
image:
  registry: 941141115079.dkr.ecr.ap-northeast-2.amazonaws.com
```

Docker Desktop local dev만 예외적으로 `task dev`가 orchestration 편의를 제공한다. 이때도 GitOps repo는 Dockerfile 목록이나 build context를 알지 않고, sibling `../service` 또는 `SERVICE_REPO=/path/to/service`의 공개 Taskfile target만 호출한다.

```bash
task dev:images SERVICE_REPO=../service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev
task dev SERVICE_REPO=../service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev
```

Docker Desktop용 기본 registry는 `localhost:5001`이다. kindest-node 기반 multi-node 클러스터에서는 node가 host Docker image store를 직접 보지 못하므로, Taskfile이 local registry container와 containerd mirror를 준비해서 Kubernetes가 같은 image reference를 pull하게 한다. VM lab의 `10.10.10.10:5000`은 `local-vm-kubeadm` 전용 경로라 Docker Desktop dev registry와 섞지 않는다.

단일 서비스 배포에서는 `values/services/<service>.yaml` 또는 `values/overrides/<env>/<service>.yaml`만 변경하는 것을 원칙으로 한다. `values/env/*`나 chart template 변경은 같은 환경 또는 전체 서비스에 영향을 줄 수 있으므로 플랫폼 배포 표준 변경으로 취급한다.

## Database per Service

PRD는 서비스별 독립 데이터베이스를 요구한다. 다만 DB lifecycle은 앱 Deployment lifecycle과 같지 않다.

그래서 DB는 두 단계로 나눈다.

1. 로컬과 초기 dev에서는 서비스별 PostgreSQL StatefulSet을 `platform/data` 또는 별도 data chart로 관리한다.
2. `aws-dev`, `aws-prod`에서는 RDS 같은 외부 DB를 연결하고, GitOps repo는 Secret 참조와 연결 설정만 관리한다.

앱 chart에는 DB StatefulSet을 직접 넣지 않는다. 앱 배포와 DB 변경의 위험을 분리하기 위해 DB release는 별도 chart 또는 platform/data 영역에서 다룬다.

## Argo CD 구조

초기에는 환경별 app-of-apps 패턴이 적합하다.

```text
argo/applications/aws-dev/root.yaml
argo/applications/aws-dev/services/auth.yaml
argo/applications/aws-dev/services/reservation.yaml
...
```

서비스별 Application은 같은 chart와 values 조합을 사용한다.

```yaml
sources:
  - repoURL: https://github.com/Medikong/gitops.git
    targetRevision: HEAD
    path: charts/medikong-service
    helm:
      releaseName: reservation-aws-dev
      valueFiles:
        - $values/values/base.yaml
        - $values/values/env/aws-dev.yaml
        - $values/values/services/reservation.yaml
  - repoURL: https://github.com/Medikong/gitops.git
    targetRevision: HEAD
    ref: values
```

이 구조에서는 `reservation`만 sync, rollback, canary 전환하는 흐름이 가능해진다. 실제 Argo CD sync 수행과 prod 승인 정책은 별도 후속 작업으로 둔다.

AWS bootstrap 명령은 인프라 생성 명령이 아니다. `task aws:bootstrap`은 infra repo가 준비한 AWS kubeadm 클러스터와 Argo CD 위에 `argo/applications/aws-dev/root.yaml` 같은 GitOps 진입점을 등록하거나 갱신한다.

## 전환 순서

1. 기존 Kustomize 구조를 `archive/k8s-kustomize/`로 옮긴다.
2. namespace, Kong, observability, policy, data 이식 후보를 기록한다.
3. 환경 이름을 runtime/provisioner 기준으로 분리한다.
4. AWS scenario를 values layering으로 표현한다.
5. `Taskfile.yml`을 기본 명령 표면으로 만들고 `Makefile`은 wrapper로 축소한다.
6. `values/services/*.yaml` 전체를 대상으로 Helm render를 검증한다.
7. Argo CD Application은 서비스별 Helm release 구조로 전환한다.
8. 실제 sync, secret, prod 승인 정책은 후속 작업으로 분리한다.

## 검증 명령

기본 검증은 Taskfile로 실행한다.

```bash
task validate
task dev:check
task aws:check
task helm:lint
task helm:template:service SERVICE=reservation
task helm:template:env ENV=aws-dev
task scenario:network
```

기존 사용자를 위한 Makefile wrapper도 유지한다.

```bash
make validate
make helm-lint
make helm-template SERVICE=reservation ENV=aws-prod
```

공통 chart가 바뀐 경우에는 모든 서비스와 주요 환경 조합을 렌더링해야 한다. 서비스 values만 바뀐 경우에는 해당 서비스와 대상 환경 렌더링을 최소 검증 단위로 삼는다.
