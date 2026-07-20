# Data platform resources

서비스별 DB와 messaging 리소스는 앱 Deployment와 lifecycle이 다르므로 서비스 chart에 직접 넣지 않는다.

Docker Desktop 로컬 개발에서는 `task dev`가 namespace 생성 후 `platform/data/chart` Helm chart를 먼저 배포하고, DB/Kafka가 준비된 뒤 서비스 Helm release를 배포한다.

## Layout

| 경로 | 용도 |
| --- | --- |
| `chart/` | 공통 DB/Kafka/pgAdmin/NetworkPolicy Helm chart |
| `local/` | Docker Desktop 로컬 values. PostgreSQL DB는 서비스별 파일로 분리 |
| `aws-dev/` | AWS-dev용 values. PostgreSQL DB는 서비스별 파일로 분리 |

| 리소스 | 위치 | 메모 |
| --- | --- | --- |
| PostgreSQL 공통 템플릿 | `chart/templates/postgresql.yaml` | values의 `postgresql.databases`를 순회 |
| PostgreSQL 서비스별 values | `local/postgres-*.yaml`, `aws-dev/postgres-*.yaml` | auth, user, catalog, coupon, interest, order, payment DB |
| pgAdmin | `chart/templates/pgadmin.yaml` | 로컬 DB 확인용 web admin, Kong 경로 `http://localhost/pgadmin` |
| Valkey StatefulSet/Service | `chart/templates/valkey.yaml` | coupon 발급 gate와 idempotency 상태 |
| Kafka StatefulSet/Service/topic Job | `chart/templates/kafka.yaml` | interest/order/payment/notification 이벤트 계약 |
| Data NetworkPolicy | `chart/templates/networkpolicies.yaml` | 서비스별 DB, Kafka, pgAdmin 접근 제어 |
| Static PV | 사용하지 않음 | Docker Desktop 기본 local-path provisioner를 사용한다. |

## Render

로컬 기본 리소스를 렌더링한다.

```bash
helm template medikong-data platform/data/chart \
  -f platform/data/local/postgresql.yaml \
  -f platform/data/local/postgres-auth.yaml \
  -f platform/data/local/postgres-user.yaml \
  -f platform/data/local/postgres-catalog.yaml \
  -f platform/data/local/postgres-coupon.yaml \
  -f platform/data/local/postgres-interest.yaml \
  -f platform/data/local/postgres-order.yaml \
  -f platform/data/local/postgres-payment.yaml \
  -f platform/data/local/valkey.yaml
```

AWS-dev DB 성능 조건을 렌더링한다.

```bash
helm template medikong-data platform/data/chart \
  -f platform/data/aws-dev/postgresql.yaml \
  -f platform/data/aws-dev/postgres-auth.yaml \
  -f platform/data/aws-dev/postgres-user.yaml \
  -f platform/data/aws-dev/postgres-catalog.yaml \
  -f platform/data/aws-dev/postgres-coupon.yaml \
  -f platform/data/aws-dev/postgres-interest.yaml \
  -f platform/data/aws-dev/postgres-order.yaml \
  -f platform/data/aws-dev/postgres-payment.yaml
```

## 로컬 pgAdmin

`task dev` 이후 `http://localhost/pgadmin`으로 접속한다.

- pgAdmin 로그인: `admin@example.com` / `admin`
- PostgreSQL 서버 사용자: `user`
- PostgreSQL 서버 비밀번호: `password`
- 현재 자동 등록 서버: `auth-db`, `payment-db`

AWS-dev에서는 `argo/applications/aws-dev/platform/data.yaml`이 `platform/data/chart` Helm chart와 `platform/data/aws-dev/*.yaml` values를 배포한다.

VMware kubeadm의 `10.10.10.10:5000` registry와는 별개이며, 이 디렉터리는 공통 data 리소스와 로컬/AWS-dev overlay만 다룬다.
