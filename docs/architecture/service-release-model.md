# 서비스 단위 배포 구조 전환 방향

## 배경

현재 `k8s/` 구조는 서비스 단위보다 레이어 단위에 가깝다.

```text
k8s/
  namespaces/
  storage/
  kong/
  network-policies/
  base/apps/
  base/deps/
  overlays/local/apps
  overlays/local/deps
  overlays/local/all
```

이 방식은 초기 Kubernetes 구성을 한 번에 렌더링하고 전체 플랫폼을 파악하기에는 편하다. 하지만 PRD의 최종 목표인 서비스별 독립 배포, 독립 확장, 장애 격리까지 생각하면 점점 한계가 생긴다.

PRD에서 특히 중요한 기준은 다음이다.

- 각 서비스가 독립적으로 배포, 확장, 장애 격리 가능해야 한다.
- 서비스별 독립 데이터베이스 원칙을 유지해야 한다.
- 서비스별 독립 배포 파이프라인을 분리해야 한다.
- 한 서비스의 배포가 다른 서비스에 영향을 주지 않음을 E2E 테스트로 검증해야 한다.
- PDB, ServiceAccount, NetworkPolicy 같은 운영/보안 리소스도 서비스 경계에 맞춰 관리해야 한다.

따라서 현재 구조는 GitOps repo 초기 이주 단계로는 적절하지만, 장기 운영 구조는 서비스 단위 Helm release 중심으로 전환하는 것이 더 자연스럽다.

## 목표 환경

최종적으로 관리할 환경은 세 가지다.

| 환경 | 목적 | 특징 |
|---|---|---|
| `local` | 개인 로컬 Kubernetes 실습과 빠른 검증 | local registry, MetalLB, hostPath PV, 낮은 리소스 기준 |
| `aws-dev` | 클라우드 개발/검증 환경 | ECR image, AWS load balancer, dev용 리소스와 관측성 |
| `aws-prod` | 운영형 환경 | 더 엄격한 보안 정책, PDB/HPA, 운영 리소스, 점진 배포 |

환경이 늘어나더라도 서비스 chart는 같게 유지하고, 차이는 values로 분리한다.

## 방향

서비스는 Helm release 단위로 분리한다. 환경은 values 단위로 분리한다.

```text
gitops/
  charts/
    medikong-service/
    medikong-postgres/
  apps/
    auth/
      values-local.yaml
      values-aws-dev.yaml
      values-aws-prod.yaml
    patient/
      values-local.yaml
      values-aws-dev.yaml
      values-aws-prod.yaml
    appointment/
    prescription/
    notification/
    dashboard/
  platform/
    namespaces/
    kong/
    observability/
    policies/
  argo/
    projects/
    applications/
      local/
      aws-dev/
      aws-prod/
```

`charts/medikong-service`는 서비스 공통 리소스를 템플릿으로 제공한다.

- `Deployment`
- `Service`
- `Ingress` 또는 Kong route 연동 리소스
- `ServiceAccount`
- `Role`, `RoleBinding`
- `NetworkPolicy`
- `PodDisruptionBudget`
- `HorizontalPodAutoscaler`
- `ServiceMonitor`
- 필요 시 `ConfigMap`, `Secret` 참조

각 서비스는 같은 chart를 쓰되 values만 다르게 둔다.

```text
apps/patient/values-local.yaml
apps/patient/values-aws-dev.yaml
apps/patient/values-aws-prod.yaml
```

이렇게 하면 `patient` 서비스의 image tag, replica, resource, ingress host, autoscaling, network policy를 다른 서비스와 독립적으로 바꿀 수 있다.

## Platform과 Service의 경계

모든 것을 서비스 chart에 넣지는 않는다. 플랫폼 공통 리소스와 서비스 리소스를 분리한다.

| 영역 | 위치 | 이유 |
|---|---|---|
| Namespace 기본 생성 | `platform/namespaces` | 서비스보다 먼저 있어야 하는 공통 기반 |
| Kong Gateway 설치 | `platform/kong` | gateway 자체는 서비스가 아니라 cluster ingress layer |
| 서비스별 route/ingress | `apps/<service>` | 서비스 배포와 함께 바뀌는 경로 선언 |
| Observability stack | `platform/observability` | Prometheus, Grafana, Loki, Tempo는 공통 운영 add-on |
| ServiceMonitor | `apps/<service>` | 서비스별 metrics endpoint와 함께 관리 |
| Gatekeeper/Falco | `platform/policies` | cluster-level 보안 정책 |
| ServiceAccount/RBAC | `apps/<service>` | 최소 권한 원칙을 서비스 단위로 적용 |
| NetworkPolicy | `apps/<service>` | 서비스 간 통신 경계를 서비스 단위로 검증 |

## Database per Service

PRD는 서비스별 독립 데이터베이스를 요구한다. 다만 DB lifecycle은 앱 Deployment lifecycle과 같지 않다.

그래서 DB는 두 단계로 나누는 것이 좋다.

1. 로컬과 초기 dev에서는 서비스별 PostgreSQL StatefulSet을 GitOps로 관리한다.
2. `aws-dev`, `aws-prod`에서는 RDS 같은 외부 DB를 연결하고, GitOps repo는 Secret 참조와 연결 설정만 관리한다.

예상 구조는 다음과 같다.

```text
data/
  auth-db/
    values-local.yaml
    values-aws-dev.yaml
    values-aws-prod.yaml
  patient-db/
  appointment-db/
```

또는 DB chart를 서비스 chart 안에 직접 넣지 않고, `medikong-postgres` 같은 별도 chart로 둔다. 이 방식이 앱 배포와 DB 변경의 위험을 분리하기 쉽다.

## Argo CD 구조

초기에는 환경별 App of Apps 패턴이 적합하다.

```text
argo/applications/local/root.yaml
argo/applications/aws-dev/root.yaml
argo/applications/aws-prod/root.yaml
```

각 root application이 서비스별 application을 묶는다.

```text
auth-local
patient-local
appointment-local
prescription-local
notification-local
dashboard-local

auth-aws-dev
patient-aws-dev
...

auth-aws-prod
patient-aws-prod
...
```

서비스별 Application은 같은 chart와 환경별 values를 조합한다.

```yaml
source:
  repoURL: https://github.com/Medikong/gitops.git
  targetRevision: HEAD
  path: charts/medikong-service
  helm:
    valueFiles:
      - ../../apps/patient/values-aws-dev.yaml
```

이 구조에서는 `patient`만 sync, rollback, canary 전환하는 흐름이 가능해진다.

## Image Tag 관리

GitOps repo는 image를 만들지 않는다.

서비스 repo 또는 release pipeline이 image를 만들고 registry에 게시한다. GitOps repo는 그 결과 tag를 받아 values에 반영한다.

```yaml
image:
  repository: 941141115079.dkr.ecr.ap-northeast-2.amazonaws.com/medikong-patient
  tag: 2026.05.21-abc1234
```

서비스별 독립 배포를 위해 image tag도 서비스별 values에 둔다.

```text
apps/patient/values-aws-dev.yaml
apps/appointment/values-aws-dev.yaml
```

이렇게 해야 `patient` image tag 변경이 `appointment`, `prescription`, `notification` release에 영향을 주지 않는다.

## 전환 순서

한 번에 전체를 Helm으로 바꾸지 않는다. 현재 Kustomize 구조는 안정적인 reference로 유지하면서 한 서비스씩 옮긴다.

1. 서비스 release model 문서를 확정한다.
2. 공통 `charts/medikong-service` 초안을 만든다.
3. `patient` 서비스를 pilot으로 Helm chart values 구조를 검증한다.
4. `local` 환경에서 `patient-local` Argo CD Application을 분리한다.
5. `aws-dev`에 같은 chart와 다른 values를 적용한다.
6. `patient`에서 PDB, HPA, ServiceAccount, NetworkPolicy까지 서비스 단위로 묶는다.
7. 같은 패턴을 `auth`, `appointment`, `prescription`, `notification`, `dashboard`로 확장한다.
8. 서비스별 Helm release가 안정화되면 기존 레이어형 Kustomize overlay를 축소한다.
9. `aws-prod`는 마지막에 보안 정책, 승인 흐름, canary/rollback 기준을 갖춘 뒤 연다.

## Pilot 서비스 후보

`patient`가 첫 번째 후보로 적합하다.

- 핵심 도메인이면서 다른 서비스보다 흐름이 이해하기 쉽다.
- DB per Service, Kong route, NetworkPolicy, ServiceMonitor를 모두 검증할 수 있다.
- CRUD smoke test로 배포 후 확인이 가능하다.

`auth`는 인증과 JWT credential이 걸려 있어 첫 pilot으로는 약간 더 조심스럽다. `appointment`나 `prescription`은 Kafka 이벤트 흐름까지 같이 봐야 하므로 두 번째 단계가 더 적합하다.

## 아직 결정하지 않은 것

- Helm chart를 단일 공통 chart로 갈지, 서비스별 chart로 완전히 분리할지
- DB StatefulSet을 서비스 chart 하위 옵션으로 둘지, 별도 `data/*` release로 둘지
- Kong route를 chart에 포함할지, gateway 전용 chart에서 서비스 목록을 받아 만들지
- Argo CD Rollouts를 처음부터 chart에 포함할지, 주요 서비스에만 나중에 붙일지
- `aws-prod`에서 GitOps 변경 승인을 GitHub branch protection만으로 볼지, Argo CD sync window/approval까지 둘지

현재 판단으로는 공통 서비스 chart + 서비스별 values + DB 별도 release가 가장 안전하다.
