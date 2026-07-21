# Kong에서 Istio로 전환하는 실행 계획

## 목표

Kong을 즉시 제거하지 않고 Istio 경로를 병행 구축한다. 서비스·데이터·인증·관측·rollback을 두 dev 환경에서 검증한 뒤 트래픽을 전환하고, 관찰 기간 후 Kong을 제거한다.

이 문서는 작업 순서와 gate를 정의한다. 서비스 트래픽 계약은 `service-traffic-contracts.md`, 환경별 현황은 `environment-release-matrix.md`를 기준으로 한다.

## 소유권

| 저장소/담당 | 소유 범위 |
| --- | --- |
| infra | 노드, Terraform, Ansible, SSH/SSM/ProxyJump, Argo bootstrap, DB bootstrap Secret |
| e-gitops | 서비스 release, data workload, Gateway, mesh/network policy, 관측, synthetic/loadtest/chaos |
| 서비스 담당자 | route와 인증 계약, 애플리케이션 코드, worker, migration command |
| Argo CD 담당자 | Application, root 연결, sync와 health 관리 |

## 단계 0. 기준선과 계약 확정

### 작업

- infra 기준선을 `8f81bb3` 이상으로 맞춘다.
- active Argo Git source와 raw bootstrap URL을 실제 `Medikong/e-gitops`로 통일한다.
- canonical 8개와 private-dev backoffice 계약을 문서화한다.
- aws-dev/private-dev의 Application, values, data, Secret, migration 상태를 매핑한다.
- backoffice는 기존 Kong 경로와 자원을 보존하고 후속 future/private admin route handoff 대상으로 기록한다.

### 완료 gate

- route, port, probe, 인증 경계, destination owner가 확정된다.
- AWS 목표는 canonical 8개, private 목표는 canonical 8개+backoffice다.
- canonical 8개의 미확정 route 항목이 없다. backoffice 미확정 항목은 최종 Kong 제거 blocker로 기록되어 있다.
- 외부 노출 포트를 저장소 근거 없이 가정하지 않는다.

## 단계 1. Secret·데이터·migration 완성

### 작업

- values의 DB/JWT/HMAC/cookie/password 평문을 제거하고 기존 값을 회전한다.
- DB credential은 infra bootstrap Secret으로 공급한다.
- 애플리케이션 키는 환경별 SealedSecret으로 공급한다.
- catalog와 notification PostgreSQL 및 Kafka 연결을 완성한다.
- private-dev backoffice DB·Secret은 변경하지 않고 후속 담당자 계약까지 보존한다.
- DB 사용 서비스마다 migration Job을 활성화한다.
- DB/PVC/Secret에 prune 보호와 backup·restore 절차를 둔다.

### 완료 gate

- tracked/rendered 평문 credential이 0이다.
- 모든 Secret reference의 name/key가 실제 공급 계약과 일치한다.
- fresh DB migration과 idempotent 재실행이 성공한다.
- migration 실패 시 Deployment가 Ready가 되지 않는다.
- backup·restore 증거 없이 기존 DB/PVC를 삭제하지 않는다.

## 단계 2. 서비스 release 정규화

### 작업

- aws-dev에 catalog, coupon, dropmong-web, interest, order Application을 추가한다.
- private-dev의 canonical 8개와 backoffice를 유지·보완한다.
- immutable image digest를 사용한다.
- sidecar, ServiceMonitor, NetworkPolicy를 서비스별로 적용한다.
- Application의 namespace, Service 이름, port, values layering을 계약과 맞춘다.

### 완료 gate

- aws-dev 8개, private-dev 9개 release가 모두 Healthy다.
- migration 완료 후 서비스가 Ready다.
- route destination과 Kubernetes Service port가 일치한다.
- DB/PVC/Secret에 의도하지 않은 Argo prune diff가 없다.

## 단계 3. Kong 옆에 Istio 병행 구축

### 작업

- Kong listener와 충돌하지 않는 Istio ingress gateway를 내부 endpoint로 설치한다.
- 서비스 소스 계약에 따라 VirtualService를 작성한다.
- backoffice는 이번 단계에서 Istio route를 만들지 않고 기존 Kong `/admin`을 유지한다.
- Task 4 planned production purchase 권한부여는 `/orders*`, `/payments*`, `/notifications*`에만 Istio `ext_authz`를 적용하고 auth-service의 planned internal-only `/internal/authz`를 통해 기존 `Authenticate`를 재사용한다. `/internal/authz`는 현재 배포 완료 경로가 아니며 public `VirtualService`에 추가하지 않는다.
- Gateway `RequestAuthentication`의 direct JWT 검증이나 Gateway 내부 claim→header 재구성을 production purchase 권한부여 근거로 사용하지 않는다. `AUTH_JWT_SECRET`과 다른 signing/shared secret은 auth-service에만 두고 Gateway/downstream에 배포하지 않는다.
- planned purchase bridge는 `ext_authz` 호출 전에 client-supplied `X-User-Id`, `X-User-Role`, `X-User-Email`, 대소문자를 구분하지 않고 이름이 `X-User-`로 시작하는 모든 `X-User-*`, `X-Principal`을 제거한다. successful authz response에서 얻은 `X-User-Id`와 canonical `X-User-Role: CUSTOMER`만 upstream에 주입하며 나머지는 신뢰·재생성·복사·fallback·emit하지 않는다.
- public auth/catalog 경로는 `ext_authz`를 호출하지 않는다. auth context, interest, coupon customer route는 현재 service-owned authorization을 유지하거나 별도 계약까지 deferred이며 Task 4 purchase bridge에 넣지 않는다.
- deny-first AuthorizationPolicy를 적용하고 authz endpoint 5xx, `250ms` timeout, connection failure, invalid/unparseable response를 downstream `503`으로 변환해 fail closed한다.
- mTLS를 `PERMISSIVE`에서 시작해 namespace 단위 `STRICT`로 전환한다.
- NetworkPolicy가 전환 기간 동안 Kong과 Istio Gateway를 모두 임시 허용하게 한다.

### 완료 gate

- route matrix coverage가 100%이고 extra route가 0이다.
- `/`, `/admin`, internal, operational 경로의 경계가 충돌하지 않는다.
- production purchase 요청은 planned `ext_authz`→auth-service `Authenticate` 경로만 사용하고 Gateway/downstream에 signing secret이 없다.
- no-token, wrong-role, expired/tampered token, header spoof가 거부된다.
- 선언되지 않은 서비스 간 통신이 차단된다.
- Kong 기존 경로는 rollback 용도로 계속 정상 동작한다.

## 단계 4. 환경별 외부 노출과 관측 전환

### aws-dev

- NodePort 32407을 내부 cutover endpoint로 사용한다.
- SSM tunnel로 Istio 경로를 검증한다.
- public SG/NLB를 추가하지 않는다.

### private-dev

- live HAProxy 전달 대상과 owner를 확인한다.
- 실제 listen/upstream/health/rollback 계약을 확인한 후 Istio listener를 정한다.
- 근거가 없는 32047을 사용하지 않는다.

### 관측·소비자

- synthetic/loadtest를 auth→catalog→order→payment→notification 흐름으로 바꾼다.
- ticketing 또는 Kong 전용 selector를 현재 service label과 Istio 지표로 교체한다.
- gateway 5xx/latency, Envoy upstream error, AuthZ deny, Kafka lag, DB readiness를 추가한다.
- Grafana, Kiali, DB, admin port는 외부 비공개를 유지한다.

### 완료 gate

- Kong과 Istio에서 동일한 정상·음성 시나리오 결과를 얻는다.
- canonical 구매 흐름과 notification 소비가 실제 데이터로 확인된다.
- rollback 명령과 이전 endpoint가 검증된다.
- 관리 UI와 데이터 port의 외부 노출이 0이다.

## 단계 5. 외부 트래픽 전환과 Kong 제거

### Cutover gate

- Istio 정상 테스트가 통과한다.
- 인증 음성 테스트와 trusted-header spoof 테스트가 통과한다.
- DB backup·restore와 migration 상태가 확인된다.
- Istio에서 Kong으로 되돌리는 rollback rehearsal이 통과한다.
- private-dev forwarding owner와 변경 절차가 확인된다.

### 제거 순서

1. 승인된 외부 전달 대상을 Istio로 전환한다.
2. 관찰 기간 동안 Istio와 서비스 지표를 확인한다.
3. 서비스 Ingress를 제거한다.
4. KongPlugin, KongClusterPlugin, KongConsumer를 제거한다.
5. Kong shared resource Application을 제거한다.
6. backoffice가 Istio 또는 승인된 대체 내부 Gateway로 이전됐는지 확인한다.
7. 확인된 경우에만 Kong Application, workload, Service, listener를 제거한다.
8. 마지막에 Kong namespace를 제거한다.

DB, PVC, Secret은 Kong lifecycle과 분리하며 함께 삭제하지 않는다.

## 단계 6. dev 전용 카오스 검증

### 허용

- 단일 서비스 pod-kill
- 단일 서비스 경로 network delay/loss
- Kafka 연결 단절
- PostgreSQL 연결 단절

### 금지

- production과 control plane
- namespace 전체 selector
- PVC 삭제와 데이터 손상
- duration, deadline, abort가 없는 실험

replica 1 서비스는 무중단이 아니라 readiness 해제, 재시작, RTO 내 Ready 복귀, 데이터 중복·손실 0을 검증한다.

## 공통 rollback 원칙

- 각 단계는 이전 단계의 정상 경로를 제거하기 전에 rollback을 검증한다.
- Kong 제거 전까지 Kong endpoint를 rollback 경로로 유지한다.
- Secret 값, kubeconfig, Terraform plan binary, PII는 evidence에 저장하지 않는다.
- 실패한 migration, 인증 경계 불일치, data drift, unexplained 5xx가 있으면 다음 단계로 진행하지 않는다.

## 최종 완료 조건

- aws-dev는 canonical 8개, private-dev는 canonical 8개+backoffice release가 Healthy다.
- 모든 서비스의 Secret, DB, migration, route, policy owner가 명확하다.
- Istio route coverage 100%, public admin/internal/operational route 0이다.
- canonical 8개는 Istio-only로 동작한다. backoffice가 아직 Kong을 사용하면 Kong 전체 제거는 완료가 아니라 명시적 blocker 상태다.
- auth와 구매 흐름, 관측, rollback, 제한된 chaos recovery가 통과한다.
