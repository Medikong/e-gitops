# DropMong storage platform

`platform/storage`는 서비스 Helm release보다 먼저 필요한 StorageClass와 PVC 전제를 관리한다.

## private-dev

private-dev는 `medikong-local-path` StorageClass를 사용한다. 동적 PV는 선택된 노드의 `/var/lib/medikong/local-path` 아래에 생성되고 `WaitForFirstConsumer`로 workload node와 함께 결정된다.

StorageClass 변경은 기존 PVC를 제자리에서 바꾸지 못한다. 데이터 삭제가 허용된 실습 환경 reset에서만 StatefulSet과 PVC를 수동 정리하고 Argo CD를 다시 동기화한다. 자동화된 삭제 명령은 제공하지 않는다.

현재 데이터 소유 namespace:

- PostgreSQL: `dropmong-auth`, `dropmong-user`, `dropmong-catalog`, `dropmong-coupon`, `dropmong-interest`, `dropmong-order`, `dropmong-payment`
- Coupon Valkey: `dropmong-coupon`
- Kafka: `dropmong-messaging`
- 관측성 PVC: `monitoring`, `observability`

전환 후 다음 항목을 확인한다.

```bash
kubectl get sc,pvc -A
kubectl get pods -A -o wide
```

- 신규 PVC가 의도한 StorageClass를 사용한다.
- DB·Kafka Pod와 PVC가 같은 가용 영역 또는 로컬 노드 조건을 만족한다.
- Prometheus, Loki, Tempo PVC가 Bound 상태다.
- Secret이나 데이터 원문을 상태 확인 출력에 포함하지 않는다.

## aws-dev

aws-dev는 EBS CSI provisioner의 `medikong-aws-gp3` StorageClass를 사용한다. 정책은 gp3, `WaitForFirstConsumer`, `Retain`, volume expansion, encryption 활성화다. EBS CSI IAM 권한과 IMDS 접근 조건이 먼저 준비되어야 한다.
