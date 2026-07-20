# DropMong Istio platform

이 디렉터리는 Istio control plane, ingress gateway, Kiali와 DropMong 서비스 간 라우팅·인가 정책을 관리한다.

## 활성 구성

| 경로 | 책임 |
| --- | --- |
| `argocd/` | Istio base, istiod, ingress gateway, Kiali Application |
| `gateway/` | 공통 Gateway와 내부 진입점 |
| `private-dev/routing-authz/` | auth, catalog, order, payment, notification route와 외부 인가 정책 |
| `traffic/notification/` | notification-service 연결 제한과 outlier detection |
| `security/` | mTLS 정책과 검증 시나리오 |

라우팅 대상은 실제 서비스 DNS를 사용한다. 예를 들어 payment는
`payment-service.dropmong-payment.svc.cluster.local`, notification은
`notification-service.dropmong-notification.svc.cluster.local`이다.

## 렌더 검증

```bash
task istio:render
task mesh-monitoring:render
```

`task istio:render`는 현재 Kustomize 리소스와 `scripts/validate-istio-routing.py` 계약을 함께 확인한다.

## 런타임 확인

```bash
task mesh-check
task mesh-monitoring-check
```

확인 순서는 control plane과 CRD, VirtualService·AuthorizationPolicy, 서비스 Pod의 `istio-proxy`, Prometheus의 `istio_requests_total` 순서다. 트래픽이 없으면 서비스별 mesh 지표가 없는 것이 정상이며 정적 렌더 성공을 런타임 성공으로 간주하지 않는다.

## Sidecar 범위

현재 workload 단위 확인 대상은 `dropmong-payment/payment-service`와
`dropmong-notification/notification-service`다. namespace 전체 injection은 두 workload의 Kong 요청, 내부 호출, trace 전파를 확인한 뒤 별도 결정한다.
