# Kong platform resources

Kong Gateway와 Kong Ingress Controller는 서비스 Helm release보다 먼저 준비하는 platform 레이어다. 서비스별 `Ingress` 객체는 `charts/medikong-service` release가 계속 관리하지만, `Ingress`만 있어서는 외부 요청이 서비스로 전달되지 않는다. Kong controller/gateway, `IngressClass/kong`, 공통 `KongClusterPlugin`, demo `KongConsumer`가 함께 준비되어야 한다.

## Environment values

| 환경 | values 파일 | proxy Service 타입 | 용도 |
| --- | --- | --- | --- |
| Docker Desktop local | `platform/kong/values-local.yaml` | `LoadBalancer` | 로컬 개발. 외부 IP가 pending이면 port-forward fallback 사용 |
| AWS dev | `platform/kong/values-aws-dev.yaml` | `NodePort` | EC2 self-managed Kubernetes에서 smoke test, JWT, Rate Limit, Istio 연동 검증 |
| AWS prod 후보 | `platform/kong/values-aws-prod.yaml` | `LoadBalancer` | AWS Load Balancer Controller 또는 cloud provider 연동 후 NLB/ELB 외부 진입점 사용 |

현재 AWS dev 클러스터는 EKS가 아니라 EC2 기반 self-managed Kubernetes이므로 `LoadBalancer` Service를 생성해도 외부 AWS LB가 자동 생성되지 않는다. 따라서 dev에서는 Kong Proxy를 `NodePort`로 노출하고, 운영형 환경에서는 `LoadBalancer`로 전환한다.

## Docker Desktop dev

`task dev`는 Docker Desktop local loop에서 다음 순서로 동작한다.

1. Helm/Kustomize render 검증
2. Prometheus stack 배포
3. Medikong namespace 생성
4. `platform/data` DB/Kafka 배포
5. Kong Helm release와 shared gateway resource 배포
6. `service` repo backend image build/push
7. 백엔드 서비스별 Helm release 배포

Kong chart는 `platform/kong/values-local.yaml`을 사용한다. Docker Desktop 클러스터 설정에 따라 proxy Service `EXTERNAL-IP`가 `<pending>`이면 `task dev`는 계속 진행하고 `kubectl -n kong port-forward svc/kong-kong-proxy 8080:80` fallback을 안내한다.

## AWS dev access

AWS dev에서는 Kong Proxy Service가 `NodePort`로 배포된다.

```bash
kubectl get svc -n kong kong-kong-proxy
curl -i http://127.0.0.1:32407/concerts
```

EC2 외부에서 직접 접근하려면 보안 그룹에서 해당 NodePort를 열어야 한다. 기본 검증은 control-plane 노드에 SSH 접속한 뒤 `127.0.0.1:32407` 또는 노드 IP의 `32407` 포트로 수행한다.

## Local URLs

`task dev SERVICE_REPO=../service DEV_REGISTRY=localhost:5001 DEV_IMAGE_TAG=dev` 후 기본 접속 주소는 다음과 같다.

| 대상 | URL |
| --- | --- |
| Auth API | `http://localhost/auth` |
| Concert API | `http://localhost/concerts` |
| Performance seats API | `http://localhost/performances` |
| Reservation API | `http://localhost/reservations` |
| Payment API | `http://localhost/payments` |
| Ticket API | `http://localhost/tickets` |
| Notification API | `http://localhost/notifications` |

## Smoke

Auth route는 JWT plugin을 붙이지 않는다. 나머지 API route는 `ticketing-jwt`와 `ticketing-identity-headers`를 통해 demo token을 검증하고 `X-User-*` header를 upstream service에 전달한다.

```bash
curl -fsS http://localhost/auth/demo-accounts

TOKEN="$(
  curl -fsS -X POST http://localhost/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"admin@example.com","password":"admin1234"}' \
  | ruby -rjson -e 'puts JSON.parse(STDIN.read).fetch("accessToken")'
)"

curl -fsS http://localhost/concerts -H "Authorization: Bearer ${TOKEN}"
curl -fsS http://localhost/reservations -H "Authorization: Bearer ${TOKEN}"
curl -fsS http://localhost/payments -H "Authorization: Bearer ${TOKEN}"
curl -fsS http://localhost/tickets -H "Authorization: Bearer ${TOKEN}"
curl -fsS http://localhost/notifications -H "Authorization: Bearer ${TOKEN}"
```

## Resource Ownership

| 리소스 | 위치 | 소유 |
| --- | --- | --- |
| Kong Helm release | `argo/applications/*/platform/kong.yaml` | platform |
| Kong Helm values | `platform/kong/values-*.yaml` | platform |
| `IngressClass/kong` | Kong Helm chart `ingressController.createIngressClass=true` | platform |
| `KongClusterPlugin` | `platform/kong/plugins` | platform |
| demo `KongConsumer`/JWT `Secret` | `platform/kong/consumers` | platform |
| 서비스별 `Ingress` | `values/services/*.yaml` + `charts/medikong-service` | service release |

`service` repo는 Dockerfile과 image build/push만 소유한다. Kubernetes/Helm/Kong/Ingress 선언은 이 `gitops` repo가 소유한다.
