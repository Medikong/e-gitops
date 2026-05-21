# Kong Gateway

Kong은 MediKong의 외부 API 진입점입니다.

## 설치

Kong Gateway와 Kong Ingress Controller는 Helm chart values와 Kubernetes policy를 이 repo에서 관리합니다. 준비된 클러스터에 설치할 때는 Kong chart를 먼저 설치하고, `k8s/overlays/*`를 렌더링하거나 Argo CD로 동기화합니다.

로컬 클러스터에서는 MetalLB가 Kong proxy Service에 `10.10.10.240`을 할당합니다.

```text
http://10.10.10.240
```

## KIC Watch 범위

현재는 Kong Ingress Controller의 watch namespace 제한을 걸지 않습니다. KIC가 전체 namespace를 감시해야 서비스별 Ingress와 `medical-auth`의 KongConsumer/Secret을 함께 읽을 수 있기 때문입니다.

## 리소스 구조

| 리소스 | 위치 | 설명 |
| --- | --- | --- |
| `KongClusterPlugin` | cluster-scoped | JWT, rate limit, request id, prometheus 정책 |
| `KongConsumer` | `medical-auth` | demo 사용자 |
| JWT `Secret` | `medical-auth` | demo credential |
| Ingress | 서비스별 namespace | `/patients`, `/appointments` 같은 route |

## 라우팅

| Path | Namespace/Service |
| --- | --- |
| `/patients` | `medical-patient/patient-service:8081` |
| `/appointments` | `medical-appointment/appointment-service:8082` |
| `/prescriptions` | `medical-prescription/prescription-service:8083` |
| `/notifications` | `medical-notification/notification-service:8084` |
| `/` | `medical-dashboard/dashboard:80` |

## 확인

```bash
kubectl -n kong get pods,svc
kubectl get ingress -A
kubectl get kongclusterplugins
kubectl get kongconsumers -n medical-auth
```

Smoke test:

```bash
cluster/scripts/local-k8s-crud-smoke.sh
```
