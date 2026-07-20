# DropMong Kong gateway

Kong은 DropMong 로컬·개발 환경의 HTTP ingress와 공통 요청 계약을 담당한다.

## 공통 플러그인

| 리소스 | 책임 |
| --- | --- |
| `dropmong-correlation-id` | `X-Request-Id` 생성과 응답 반환 |
| `dropmong-prometheus` | Kong 요청·상태 코드·latency metric |
| `dropmong-jwt` | JWT 서명과 만료 확인 |
| `dropmong-identity-headers` | 외부 identity header 제거 후 검증된 claim만 재생성 |
| `dropmong-role-customer` | customer 전용 route 인가 |
| `dropmong-rate-limit-{orders,payments,notifications}` | 쓰기·조회 route 호출량 제한 |

Auth bootstrap과 공개 조회 route에는 JWT를 붙이지 않는다. 보호 route만 JWT·identity·role 플러그인을 명시적으로 연결한다.

## 로컬 주소

`task dev`가 성공하고 Kong LoadBalancer가 localhost에 연결되면 다음 주소를 사용한다.

| 대상 | 주소 |
| --- | --- |
| DropMong Web | `http://localhost/` |
| Auth | `http://localhost/auth` |
| User | `http://localhost/api/v1/users` |
| Coupon | `http://localhost/coupons` |
| Interest | `http://localhost/v1/drops`, `http://localhost/v1/users`, `http://localhost/v1/rankings` |
| Order | `http://localhost/orders` |
| Payment | `http://localhost/payments` |
| Notification | `http://localhost/notifications` |
| Grafana | `http://localhost/grafana/` |

Catalog는 현재 Kong Ingress가 없으며 내부 서비스 DNS와 Istio private-dev route를 사용한다. 실제 ingress 계약이 추가되기 전에는 임의 URL을 만들지 않는다.

LoadBalancer가 localhost에 열리지 않으면 다음 포트 포워딩을 사용한다.

```bash
kubectl -n kong port-forward svc/kong-kong-proxy 8080:80
```

이 경우 기본 주소의 host와 port를 `http://127.0.0.1:8080`으로 바꾼다.

## 검증

```bash
kubectl kustomize platform/kong
task kong:render
kubectl get kongclusterplugins.configuration.konghq.com
kubectl get ingress --all-namespaces
```

새 이름의 플러그인과 Ingress attachment가 함께 적용됐는지 확인한다. 이전 이름의 cluster-scoped 플러그인은 `kubectl apply`만으로 자동 삭제되지 않으므로, 새 Ingress가 정상화된 뒤 별도 정리한다.
