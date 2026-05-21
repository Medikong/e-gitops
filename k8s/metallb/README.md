# MetalLB 구성

로컬 Vagrant Kubernetes 클러스터에서 `Service type: LoadBalancer`를 사용할 수 있도록 MetalLB Layer2 모드를 사용한다.

## IP 대역

현재 Vagrant VM은 `10.10.10.0/24` 대역을 사용한다.

```text
control-plane-1   10.10.10.10
worker-1          10.10.10.11
worker-2          10.10.10.12
```

MetalLB는 VM IP와 겹치지 않는 다음 대역을 LoadBalancer 서비스에 할당한다.

```text
10.10.10.240-10.10.10.250
```

Kong Gateway는 이 pool에서 `10.10.10.240`을 고정 외부 진입점으로 사용한다.

```text
http://10.10.10.240
```

## 적용

`cluster`에서 실행한다.

```bash
make metallb-bootstrap
make metallb-verify
```

`metallb-bootstrap`은 MetalLB controller/speaker를 설치하고, `IPAddressPool`과 `L2Advertisement`를 적용한다.

## 확인

```bash
kubectl get pods -n metallb-system -o wide
kubectl get ipaddresspool -n metallb-system
kubectl get l2advertisement -n metallb-system
kubectl get svc -n kong
```

Kong 설치 후 `kong-gateway-proxy` 또는 Kong proxy 서비스의 `EXTERNAL-IP`가 `10.10.10.240`이면 정상이다.
