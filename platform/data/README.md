# Data platform resources

서비스별 DB와 messaging 리소스는 앱 Deployment와 lifecycle이 다르므로 서비스 chart에 직접 넣지 않는다.

Docker Desktop 로컬 개발에서는 `task dev`가 namespace 생성 후 이 디렉터리의 Kustomize 리소스를 먼저 배포하고, DB/Kafka가 준비된 뒤 서비스 Helm release를 배포한다.

| 리소스 | 위치 | 메모 |
| --- | --- | --- |
| PostgreSQL StatefulSet/Service | `postgres.yaml` | auth, concert, reservation, payment, ticket 로컬 DB |
| pgAdmin | `pgadmin.yaml` | 로컬 DB 확인용 web admin, Kong 경로 `http://localhost/pgadmin` |
| MongoDB StatefulSet/Service | `mongo.yaml` | notification 로컬 DB |
| Kafka StatefulSet/Service/topic Job | `kafka.yaml` | reservation/payment/ticket/notification 이벤트 흐름 |
| Static PV | 사용하지 않음 | Docker Desktop 기본 local-path provisioner를 사용한다. |

## 로컬 pgAdmin

`task dev` 또는 `task dev:data` 이후 `http://localhost/pgadmin`으로 접속한다.

- pgAdmin 로그인: `admin@example.com` / `admin`
- PostgreSQL 서버 사용자: `user`
- PostgreSQL 서버 비밀번호: `password`
- 등록 서버: `auth-db`, `concert-db`, `reservation-db`, `payment-db`, `ticket-db`

이 리소스는 Docker Desktop 로컬 디버깅용이며 AWS dev Argo CD Application에는 포함하지 않는다.

VMware kubeadm의 `10.10.10.10:5000` registry와는 별개이며, 이 디렉터리는 Docker Desktop dev loop의 런타임 의존성만 다룬다.
