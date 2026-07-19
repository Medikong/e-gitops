# 환경별 서비스 release 매핑

## 목적

이 문서는 `aws-dev`와 `private-dev`의 Application, values, data, Secret, migration 상태를 같은 기준으로 비교한다. `present`는 현재 선언이 존재한다는 뜻이며, 실행 계약이 완전하거나 runtime 검증을 통과했다는 뜻은 아니다.

## 목표 release 집합

```text
aws-dev
  canonical 고객·도메인 서비스 8개

private-dev
  canonical 고객·도메인 서비스 8개
  + 운영자용 backoffice 1개
```

backoffice는 private-dev 전용으로 유지하되 현재 Istio cutover에서는 `deferred`다. AWS 배포 요구가 별도로 승인되기 전에는 aws-dev Application이나 외부 route를 추가하지 않는다.

## 현재 매핑

| 서비스 | aws-dev Application | private-dev Application | 공통 values | 환경 values | Data | Bootstrap Secret | Migration values | 목표 조치 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| auth | present | present | present | AWS/private present | 양 환경 DB 선언 존재 | private present, AWS 확인 필요 | disabled | Secret 참조와 migration 활성화 |
| catalog | missing | present | present | 없음 | 양 환경 DB 누락 | 누락 | disabled | DB·Secret·Kafka 연결 후 AWS Application 추가 |
| coupon | missing | present | present | dev만 존재 | private DB 존재, private Redis 연결 확인 필요 | private present | disabled | Redis·migration 완성 후 AWS Application 추가 |
| dropmong-web | missing | present | present | 없음 | 해당 없음 | session/app key 공급 필요 | N/A | catalog 내부 URL과 app Secret 연결 후 AWS Application 추가 |
| interest | missing | present | present | 없음 | private DB 존재, AWS 누락 | private present | disabled | 명시적 migration과 AWS data/Application 추가 |
| notification | present | present | present | AWS present | 양 환경 DB 누락, private Kafka 존재 | 누락 | disabled | DB·Secret·Kafka 계약 완성 |
| order | missing | present | present | 없음 | private DB 존재, AWS 누락 | private present | disabled | migration과 AWS data/Application 추가 |
| payment | present | present | present | AWS/private present | 양 환경 DB 선언 존재 | private present, AWS 확인 필요 | disabled | Secret 참조와 migration 활성화 |
| backoffice | absent by design | present | present | dev만 존재 | local reference만 있고 private active data에는 누락 | 누락 | disabled/unknown | 기존 Kong 경로와 자원 보존, 후속 담당자 계약까지 deferred |

## Application 기준선

### aws-dev 현재 3개

- auth
- notification
- payment

추가가 필요한 canonical 서비스는 catalog, coupon, dropmong-web, interest, order다. Application 작성과 root 연결은 Argo CD 담당자가 수행하고, 트래픽 담당자는 namespace, Service 이름, port가 route 계약과 같은지 확인한다.

### private-dev 현재 9개

- auth
- catalog
- coupon
- dropmong-web
- interest
- notification
- order
- payment
- backoffice

private-dev의 backoffice Application은 제거하지 않는다. canonical 8개가 Istio로 전환된 뒤에도 backoffice가 Kong `/admin`을 사용하면 Kong 전체 제거는 blocked 상태로 남는다.

## Data와 Secret 소유권

| 항목 | 소유자 | 원칙 |
| --- | --- | --- |
| DB credential bootstrap 값 | infra | Ansible/환경 입력으로 Kubernetes Secret 생성 |
| Application JWT/HMAC/cookie key | e-gitops 환경 구성 | SealedSecret으로 관리 |
| DB/Kafka/Redis workload 선언 | e-gitops | `platform/data*`에서 관리 |
| Secret 소비 | 서비스 Helm values | Secret 이름과 key만 참조 |

현재 private-dev infra bootstrap은 auth, payment, coupon, order, interest PostgreSQL Secret을 공급한다. catalog, notification, backoffice는 추가 계약이 필요하다.

## Migration 원칙

- DB를 사용하는 서비스는 Deployment가 트래픽을 받기 전에 migration Job이 성공해야 한다.
- migration command는 서비스 소스 또는 서비스 담당자가 승인한 계약에서 가져온다.
- backoffice migration command는 담당자 확인 전 추정하지 않는다.
- 기존 DB, PVC, Secret은 backup·restore 확인 전 삭제하거나 Argo prune 대상에 넣지 않는다.
- migration 재실행은 idempotent해야 하며 실패하면 release를 Ready로 처리하지 않는다.

## 환경별 노출 계약

### aws-dev

- public SG, NLB, DNS, TLS를 이 작업에서 새로 만들지 않는다.
- Istio ingress gateway의 내부 cutover endpoint는 NodePort 32407과 SSM tunnel로 검증한다.
- Grafana, Kiali, DB, admin port를 외부에 공개하지 않는다.

### private-dev

- 실제 HAProxy 또는 외부 전달 계층의 owner, listen port, upstream, health check, rollback 방법을 확인한다.
- 확인되지 않은 32047을 Istio 목표 포트로 고정하지 않는다.
- backoffice는 고객용 Gateway와 분리된 내부 운영자 경로만 사용한다.

## Release 완료 조건

- aws-dev desired/live 서비스가 canonical 8개와 정확히 같다.
- private-dev desired/live 서비스가 canonical 8개와 backoffice 1개와 정확히 같다.
- 각 서비스의 Application, values, data, Secret, migration owner가 하나로 정해져 있다.
- image는 mutable tag가 아니라 immutable digest를 사용한다.
- 모든 대상 서비스에서 sidecar, ServiceMonitor, NetworkPolicy가 렌더링된다.
- DB/PVC/Secret에 의도하지 않은 prune diff가 없다.
