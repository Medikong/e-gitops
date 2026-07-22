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

## Private-dev identity-only boundary and local rate limits

Private-dev Istio ingress는 Auth가 검증해 반환하는 `x-user-id`, `x-session-id`,
`x-token-id`만 protected upstream에 전달한다. 외부 요청의 `x-user-role`,
`x-user-email`, `x-provider-id`는 ext_authz 전에 제거되고 route에서도 다시 제거된다.
Role/email/provider 이관은 별도 identity migration 책임이며 Auth/User 계약은 이 경로에서
확장하지 않는다.

`protected-order`, `protected-payment`, `protected-notification`은 각각 독립적인
120-token bucket을 사용하며 60초마다 120 tokens를 refill한다. 이 제한은 per ingress
Envoy process local limit이다. Gateway restart resets each bucket, replica scaling은 전체
허용량을 replica 수만큼 늘리므로 cluster-wide quota를 보장하지 않는다.

AWS dev uses Istio-only ingress: Kong은 AWS에 배포하거나 라우팅하지 않는다. 기존 AWS routing,
common Gateway/Istiod, canary는 수정하지 않고 AWS authz/rate-limit은 별도 child에서 관리한다.

## Sidecar 범위

정적 sidecar 대상은 다음 정확한 9개 애플리케이션/namespace 쌍이다.

```text
auth-service/dropmong-auth
user-service/dropmong-user
catalog-service/dropmong-catalog
coupon-service/dropmong-coupon
interest-service/dropmong-interest
order-service/dropmong-order
payment-service/dropmong-payment
notification-service/dropmong-notification
dropmong-web/dropmong-web
```

## Mesh monitoring contract

Prometheus PodMonitor는 `istio-system`의 `istiod` target 1개와
`istio-ingressgateway` target 1개, 위 9개 namespace의 `istio-proxy` sidecar target을
선택한다. Sidecar와 ingress endpoint는 `http-envoy-prom`/`/stats/prometheus`로 제한하고,
요청 rate·5xx·latency는 `reporter="destination"`만 집계한다. 따라서 source와 destination
proxy를 합산해 요청을 두 번 세지 않는다.

Coupon은 정적 coverage에서 항상 유지한다. 알려진 외부 adapter CrashLoop에 대해서만 runtime
waiver를 기록하며, 복구 전에는 **Task 6 remains partial**이다. 이번 검증에서 live Grafana나
Prometheus 결과를 확인하지 않았다면 runtime verification is deferred로 남긴다.

요청 ID는 `x-request-id` HTTP header 전파·응답과 gateway/backend structured log에서
correlate한다. `request_id`나 `x_request_id`는 어떤 Prometheus metric label에도 추가하지
않는다. AWS dev uses Istio-only ingress; private-dev Kong 구성은 별도 환경의 이전 범위로 남긴다.
