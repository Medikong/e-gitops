# Istio sidecar injection

DropMong은 namespace 전체 주입보다 workload 단위 opt-in을 먼저 사용한다.

현재 검증 대상:

1. `dropmong-payment/payment-service`
2. `dropmong-notification/notification-service`

Helm values의 Pod template에 다음 annotation을 설정한다.

```yaml
podAnnotations:
  sidecar.istio.io/inject: "true"
```

검증 조건은 Pod `READY 2/2`, `istio-proxy` container 존재, Kong 요청 성공, 내부 호출 성공, trace context 유지, Prometheus Envoy scrape 성공이다. 기존 Pod에는 annotation 변경만으로 sidecar가 생기지 않으므로 rollout이 필요하다.
