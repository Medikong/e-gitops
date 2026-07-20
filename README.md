# Medikong GitOps

이 repo는 준비된 Kubernetes 클러스터 위에서 MediKong 배포 선언과 운영 add-on을 관리하는 GitOps 전담 repo다.

서비스 코드, image build, VM 생성, 서버 초기 bootstrap은 이 repo의 책임이 아니다. 여기서는 이미 만들어진 container image tag를 values에 반영하고, Argo CD가 그 선언을 클러스터에 동기화하도록 관리한다.

## 책임 범위

| 포함 | 설명 |
| --- | --- |
| `charts/` | 서비스별 Helm release에 공통으로 쓰는 chart template |
| `values/` | `base -> env -> service -> optional override` 순서로 합성하는 Helm values |
| `platform/` | namespace, gateway, monitoring, observability, policy, data처럼 서비스보다 먼저 준비되는 공통 기반 |
| `argo/` | 플랫폼/서비스별 Argo CD Application 초안과 설치 보조 스크립트 |
| `Taskfile.yml` | `dev`, `aws`, `scenario` 중심의 기본 명령 표면 |
| `Makefile` | 기존 사용자를 위한 Taskfile wrapper |
| `archive/k8s-kustomize/` | 기존 Kustomize 구조 reference와 이식 근거 |
| `.github/workflows/` | GitOps manifest 렌더링과 Kubernetes 보안 스캔 |

## 제외 범위

| 제외 | 담당 repo |
| --- | --- |
| Terraform, cloud network, VM topology | infra repo |
| infra repo VM definition, VM 생성, SSH key 동기화 | infra repo |
| 서버 패키지 설치, OS 초기 bootstrap | infra repo |
| FastAPI 서비스 코드와 frontend 코드 | service repo |
| 서비스 단위 테스트, Docker Compose E2E | service repo |
| image publishing pipeline | service repo 또는 release pipeline |
| 별도 kind CLI 기반 클러스터 생성 자동화 | 후속 범위 |
| 실제 AWS 인프라 생성/삭제 실행 | 후속 범위 |

## 기본 흐름

1. service release pipeline이 container image를 만들고 registry에 게시한다.
2. 이 repo에서 image tag를 `values/services/*` 또는 `values/overrides/*`에 반영한다.
3. `task validate`가 Helm chart, 모든 서비스/환경 render, AWS scenario values render, platform render를 확인한다.
4. 준비된 AWS kubeadm 클러스터에서는 `task aws:bootstrap`으로 Argo CD Application 진입점을 등록하거나 갱신한다.
5. Argo CD가 플랫폼 Application과 서비스별 Helm Application을 동기화한다.

## 자주 쓰는 명령

Taskfile이 기본 명령 표면이다.

개발자가 Docker Desktop Kubernetes에 올릴 때는 기본 workspace sibling layout에서 한 명령으로 image build/push와 Helm 배포를 이어갈 수 있다.

```bash
task dev
```

`task dev`는 Prometheus/Grafana와 Tempo/Loki를 먼저 준비한 뒤 namespace, `platform/data`, Kong Ingress Controller/Gateway를 준비한다. 이어서 `SERVICE_REPO`의 공개 Taskfile 명령으로 백엔드 서비스 이미지를 만들고 push한 뒤, 같은 registry/tag를 서비스 Helm release에 넘긴다. 기본값은 `SERVICE_REPO=../service`, `DEV_REGISTRY=localhost:5001`, `DEV_IMAGE_TAG=dev`, `DEV_SERVICES="auth user catalog coupon interest order payment notification dropmong-web"`이다.

```bash
task dev:check
task dev SERVICE_REPO=../service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev
```

서비스 `/metrics`가 Prometheus scrape 대상까지 등록되는지는 `task dev` 완료 후 Prometheus에서 확인한다.

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
```

이미지 build/push부터 Prometheus stack과 서비스 `ServiceMonitor` 배포까지 한 번에 확인하는 기본 명령은 다음과 같다.

```bash
task dev SERVICE_REPO=../service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev
```

배포 후 API는 Kong proxy를 통해 접근한다. Docker Desktop의 LoadBalancer가 `localhost`로 열리지 않는 환경에서는 안내되는 port-forward fallback을 사용한다.

```text
Auth API:  http://localhost/auth
```

인증이 필요한 API smoke는 demo token을 받은 뒤 실행한다.

```bash
TOKEN="$(
  curl -fsS -X POST http://localhost/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"admin@example.com","password":"admin1234"}' \
  | sed -n 's/.*"accessToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
)"

curl -fsS http://localhost/v1/drops -H "Authorization: Bearer ${TOKEN}"
curl -fsS http://localhost/orders -H "Authorization: Bearer ${TOKEN}"
```

배포 후 상태 확인과 정리는 다음처럼 한다.

```bash
task dev:down
```

AWS 쪽 명령은 인프라 생성이 아니라, 이미 AWS에 kubeadm 클러스터와 Argo CD가 준비되어 있다고 가정한 GitOps bootstrap 표면이다.

```bash
task aws:check
task aws:bootstrap
task aws:status
```

코드 기반 Kubernetes 검증 시나리오는 `scenario` 아래에 둔다. 단순 생존 확인이 아니라 network, HPA, storage, release 동작을 values 조합으로 검증하는 표면이다.

```bash
task scenario:network
task scenario:hpa
task scenario:storage
task scenario:release
task scenario:status
```

Makefile은 호환 wrapper다.

```bash
make validate
make helm-lint
make helm-template SERVICE=order ENV=aws-prod
make helm-template-service SERVICE=order
make scenario SCENARIO=hpa SERVICE=order
```

## 환경 이름

`values/env/*`는 runtime/provisioner가 드러나는 이름을 사용한다.

| 환경 | 목적 |
| --- | --- |
| `dev` | Docker Desktop Kubernetes에서 Prometheus stack과 `ServiceMonitor` 포함 scrape 흐름을 검증하는 기본 로컬 개발 환경 |
| `local-docker-desktop-kubeadm` | Docker Desktop Kubernetes에서 kubeadm 계열 구성을 검증하는 호환 환경 |
| `local-docker-desktop-kind` | Docker Desktop runtime 위 kind-style 구성을 values로 검증 |
| `local-vm-kubeadm` | VM 기반 kubeadm 클러스터와 registry 경로 검증 |
| `aws-dev` | 지속 검증용 클라우드 개발 환경 |
| `aws-prod` | 운영 목표 환경 |

`task dev`, `task dev:check`, `task dev:down`은 내부적으로 `dev` values와 `platform/kong/values-local.yaml`, `platform/monitoring/values/kube-prometheus-stack-local.yaml`, `platform/observability/*/values/local.yaml`을 사용한다. 개발자는 평소에 환경 파일명을 직접 넘기지 않아도 된다. `dev`는 로컬 개발에서도 분산 동작을 확인할 수 있도록 기본 replica를 2개로 두고, 백엔드 서비스별 `/metrics`가 Prometheus scrape 대상이 되도록 `ServiceMonitor`를 켠다. Tempo/Loki backend도 `task dev` 과정에서 함께 설치된다.

Docker Desktop 개발 루프는 VM/kubeadm lab registry인 `10.10.10.10:5000`을 쓰지 않는다. 기본 dev registry는 Docker Desktop host에서 push 가능한 `localhost:5001`이고, kindest-node 기반 multi-node 클러스터에서는 Taskfile이 node containerd mirror를 설정해서 같은 image reference를 pull하게 한다. 이 repo는 `DEV_SERVICES`에 있는 백엔드 서비스만 service repo의 `task app-images-push IMAGE_REGISTRY=<registry> IMAGE_TAG=<tag>` 표면으로 빌드한다.

Kong proxy는 Docker Desktop local에서 `LoadBalancer` Service로 열릴 수 있다. 클러스터 설정에 따라 `EXTERNAL-IP`가 `<pending>`이면 `task dev`는 계속 진행하고 `kubectl -n kong port-forward svc/kong-kong-proxy 8080:80` fallback을 안내한다.

다른 위치의 service repo나 다른 registry/tag를 쓸 때는 다음처럼 넘긴다.

```bash
task dev SERVICE_REPO=/path/to/service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev-001
task dev DEV_SERVICES="auth payment"
```

`10.10.10.10:5000`은 `local-vm-kubeadm`용 registry다. Docker Desktop 개발 루프에서 이 값을 재사용하면 Pod image pull 경로와 service repo push 경로가 어긋나기 쉽다.

AWS 검증 시나리오는 단일 환경이 아니라 scenario values로 표현한다.

| 시나리오 | Values |
| --- | --- |
| `aws-scenario-network` | `values/scenarios/aws/base.yaml` + `values/scenarios/aws/network.yaml` |
| `aws-scenario-hpa` | `values/scenarios/aws/base.yaml` + `values/scenarios/aws/hpa.yaml` |
| `aws-scenario-storage` | `values/scenarios/aws/base.yaml` + `values/scenarios/aws/storage.yaml` |
| `aws-scenario-release` | `values/scenarios/aws/base.yaml` + `values/scenarios/aws/release.yaml` |

## 구조

```text
gitops/
  README.md
  Taskfile.yml
  Makefile
  .github/
  argo/
    application.yaml
    applications/
      aws-dev/
        root.yaml
        platform/
        services/
  charts/
    medikong-service/
  values/
    base.yaml
    env/
      dev.yaml
      local-docker-desktop-kubeadm.yaml
      local-docker-desktop-kind.yaml
      local-vm-kubeadm.yaml
      aws-dev.yaml
      aws-prod.yaml
    services/
    scenarios/
      aws/
    overrides/
  platform/
    data/
    kong/
    monitoring/
    namespaces/
    observability/
    policies/
  archive/
    k8s-kustomize/
```

## 운영 메모

- 기존 Kustomize 구조는 `archive/k8s-kustomize/`에 reference로 남긴다. 새 운영 경로로 사용하지 않는다.
- Helm values는 `values/base.yaml`, `values/env/<env>.yaml`, `values/services/<service>.yaml`, `values/overrides/<env>/<service>.yaml` 순서로 합성한다.
- `charts/medikong-service`는 서비스별 Helm release의 공통 chart다.
- `platform/namespaces`는 서비스 release보다 먼저 렌더링되는 공통 기반이다.
- `platform/monitoring`은 `monitoring` namespace 기준 `kube-prometheus-stack` GitOps 운영 경로이며, Grafana datasource 선언을 함께 관리한다.
- `platform/observability`는 `observability` namespace 기준 Tempo/Loki backend 운영 경로다.
- `task aws:bootstrap`은 서비스 Helm release를 직접 올리지 않고 Argo CD Application 진입점을 적용한다.
- Kong, policy, data 리소스의 이식 후보는 `docs/architecture/k8s-kustomize-archive-inventory.md`에 정리한다.
- 클러스터 자체의 프로비저닝(서버 준비, Kubernetes 부트스트랩, Argo CD 설치)은 이 repo가 아니라 infra repo(`environments/{aws-dev,private-dev}`)가 전담한다.
- live cluster에 직접 적용하는 명령은 명시적으로 실행할 때만 사용한다.
