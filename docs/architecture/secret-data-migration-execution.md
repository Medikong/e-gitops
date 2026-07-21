# Wave 1 Secret·데이터·migration 실행 지침

## 현재 단계와 범위

현재는 전체 Istio 전환 계획의 **단계 1**이다. 목표는 canonical 8개 서비스가 사용할 Secret, PostgreSQL, Kafka/Redis 연결과 migration 선행 조건을 완성하는 것이다.

canonical 8개는 `auth`, `catalog`, `coupon`, `dropmong-web`, `interest`, `notification`, `order`, `payment`다. backoffice는 기존 private-dev Application, 데이터, Secret, Kong `/admin` 경로를 보존하고 이번 단계에서는 수정하지 않는다.

이 단계에서는 순서를 지킨다.

1. infra가 DB credential Secret을 공급한다.
2. e-gitops가 애플리케이션 키 SealedSecret과 DB workload를 선언한다.
3. 서비스 values가 평문 대신 Secret을 참조한다.
4. DB가 준비된 서비스의 migration Job을 활성화한다.
5. render, fresh migration, 재실행, rollback 검증 후 다음 서비스로 이동한다.

Secret 공급 전에 이를 참조하는 Deployment나 migration Job을 먼저 동기화하면 Pod가 `CreateContainerConfigError`로 멈춘다. DB/PVC/Secret은 backup·restore 확인 전 삭제하거나 prune 대상으로 만들지 않는다.

## 저장소별 소유권

| 저장소 | 수정 대상 | 의미 |
| --- | --- | --- |
| `infra` | `infra/cluster/provision/ansible/environments/*/playbooks/secrets.yml` | 클러스터에 DB 비밀번호와 `database-url` Secret을 생성한다. 평문 값은 Git에 저장하지 않고 실행 환경에서 받는다. |
| `e-gitops` | `platform/data*` | PostgreSQL, Kafka, Redis workload와 PVC를 선언한다. |
| `e-gitops` | `platform/service-credentials/<env>` 신규 경로 | JWT/HMAC/cookie 같은 애플리케이션 키를 환경별 SealedSecret으로 관리한다. |
| `e-gitops` | `values/services/<env>/<service>.yaml` | Deployment와 migration Job이 Secret의 name/key를 소비하게 한다. |
| 서비스 저장소 | migration executable과 schema | GitOps가 실행할 명령과 idempotency를 보장한다. |
| Argo CD 담당자 | `argo/applications/<env>/platform/service-credentials.yaml` | SealedSecret 경로를 해당 클러스터에 동기화한다. |

## 현재 감사 결과

| 서비스 | 현재 문제 | DB Secret 목표 | migration command | 상태 |
| --- | --- | --- | --- | --- |
| auth | 공통/AWS values에 DB·JWT·HMAC 평문, 환경 overlay의 `JWT_SECRET` 이름이 소스와 불일치 | `postgres-auth-credentials/database-url` | `[/app/migrate]` | 첫 pilot 대상 |
| catalog | DB/Kafka env, 양 환경 DB와 bootstrap Secret 누락 | `postgres-catalog-credentials/database-url` | `[python, -m, app.migrations, upgrade]` | data 선행 필요 |
| coupon | DB와 `COUPON_CODE_HASH_KEY` 평문, Redis 환경 계약 불완전 | `postgres-coupon-credentials/database-url` | `[/app/migrate]` | Redis 확인 필요 |
| dropmong-web | `SESSION_COOKIE_SECRET` 평문 | DB 없음 | N/A | app Secret만 필요 |
| interest | DB 평문, AWS DB 누락 | `postgres-interest-credentials/database-url` | 없음 | 서비스 담당자가 명시적 migration을 제공해야 함 |
| notification | `DATABASE_URL` 누락으로 in-memory fallback, 양 환경 PostgreSQL/Secret 누락 | `postgres-notification-credentials/database-url` | `[python, -m, alembic, upgrade, head]` | data 선행 필요 |
| order | DB 평문, AWS DB 누락 | `postgres-order-credentials/database-url` | `[python, -m, app.migrate, upgrade, head]` | AWS data 선행 필요 |
| payment | 공통/AWS DB 평문 | `postgres-payment-credentials/database-url` | `[python, -m, alembic, -c, alembic.ini, upgrade, head]` | auth 다음 pilot |

추가로 확인된 기반 문제는 다음과 같다.

- AWS active data values에는 auth와 payment PostgreSQL만 있다. catalog, coupon, interest, notification, order가 누락돼 있다.
- AWS data chart에는 Kafka가 없다. Kafka의 실제 공급 위치와 endpoint를 먼저 확정해야 한다.
- private-dev PostgreSQL은 auth, payment, coupon, order, interest만 있다. catalog와 notification이 누락돼 있다.
- private-dev에는 Kafka가 있지만 active kustomization에 Redis가 없다.
- notification용 MongoDB 선언은 현재 PostgreSQL 기반 서비스 소스와 맞지 않는 과거 선언이다. backup 확인 전 바로 삭제하지 않고 PostgreSQL 전환 후 별도 정리한다.
- private-dev infra `secrets.yml`은 auth, payment, coupon, order, interest만 공급한다. catalog와 notification을 추가해야 한다.
- AWS에는 `playbooks/secrets.yml`이 아직 없다.
- private-dev `playbooks/site.yml`은 현재 `secrets.yml`을 import하지 않는다. Secret bootstrap은 별도 실행인지 site 편입인지 infra 담당자가 결정해야 한다.

## Secret 이름 계약

DB Secret은 infra가 아래 두 key를 갖는 Opaque Secret으로 만든다.

```text
password      PostgreSQL StatefulSet의 POSTGRES_PASSWORD가 사용
database-url  서비스와 migration Job의 DATABASE_URL이 사용
```

| namespace | Secret 이름 |
| --- | --- |
| `dropmong-auth` | `postgres-auth-credentials` |
| `dropmong-catalog` | `postgres-catalog-credentials` |
| `dropmong-coupon` | `postgres-coupon-credentials` |
| `dropmong-interest` | `postgres-interest-credentials` |
| `dropmong-notification` | `postgres-notification-credentials` |
| `dropmong-order` | `postgres-order-credentials` |
| `dropmong-payment` | `postgres-payment-credentials` |

애플리케이션 키는 환경별로 암호문이 달라야 한다.

| namespace | Secret 이름 | key |
| --- | --- | --- |
| `dropmong-auth` | `auth-runtime-secrets` | `AUTH_JWT_SECRET`, `AUTH_CREDENTIAL_HMAC_KEY`, `AUTH_REPLAY_ENCRYPTION_KEY` |
| `dropmong-coupon` | `coupon-runtime-secrets` | `COUPON_CODE_HASH_KEY` |
| `dropmong-web` | `dropmong-web-runtime-secrets` | `SESSION_COOKIE_SECRET` |

AWS와 private-dev가 같은 Secret 이름을 써도 SealedSecret 파일과 암호문은 공유하지 않는다. 암호문은 각 클러스터의 sealed-secrets 공개키로 별도 생성한다.

## 새로 만들 e-gitops 경로

애플리케이션 키는 다음처럼 환경을 분리한다.

```text
platform/service-credentials/
  aws-dev/
    kustomization.yaml
    auth.sealedsecret.yaml
    coupon.sealedsecret.yaml
    dropmong-web.sealedsecret.yaml
  private-dev/
    kustomization.yaml
    auth.sealedsecret.yaml
    coupon.sealedsecret.yaml
    dropmong-web.sealedsecret.yaml
```

Argo CD 담당자는 다음 Application을 추가한다.

```text
argo/applications/aws-dev/platform/service-credentials.yaml
argo/applications/private-dev/platform/service-credentials.yaml
```

이 Application은 sealed-secrets controller가 준비된 뒤, 서비스 Application보다 먼저 동기화돼야 한다. Secret 자체는 `prune: false` 또는 동등한 보호 정책을 적용해 실수로 삭제되지 않게 한다.

## values 작성 시 주의점

Helm의 values 합성에서 배열은 key 기준으로 병합되지 않는다. `container.env`와 `migration.env`는 환경 overlay가 공통 배열 전체를 교체한다.

따라서 다음처럼 일부 항목만 덧붙인다고 생각하면 안 된다.

```yaml
# 이 배열은 공통 container.env 뒤에 추가되는 것이 아니라 공통 배열을 전부 교체한다.
container:
  env:
    - name: DATABASE_URL
      valueFrom: ...
```

각 `values/services/<env>/<service>.yaml`에는 해당 환경에서 필요한 **최종 env 전체 목록**을 작성한다. 평문이 아닌 값만 `value:`를 사용하고 credential은 `valueFrom.secretKeyRef`를 사용한다.

## 첫 적용 Task: auth-service pilot

auth를 먼저 끝낸 뒤 같은 패턴을 다른 서비스에 복제한다.

### 1. infra 담당자 작업

private-dev는 기존 파일을 보완한다.

```text
infra/infra/cluster/provision/ansible/environments/private-dev/playbooks/secrets.yml
```

auth 항목은 이미 있으므로 name/key를 변경하지 않는다. `secrets.yml`을 별도 실행할지 `playbooks/site.yml`에 import할지는 infra 담당자가 정한다.

AWS는 다음 신규 파일을 만들고 `site.yml` 실행 순서에 포함한다.

```text
infra/infra/cluster/provision/ansible/environments/aws-dev/playbooks/secrets.yml
infra/infra/cluster/provision/ansible/environments/aws-dev/playbooks/site.yml
```

AWS `secrets.yml`의 auth 계약은 private-dev와 동일하게 `dropmong-auth/postgres-auth-credentials`에 `password`, `database-url`을 생성하는 것이다. 실제 비밀번호는 `POSTGRES_AUTH_PASSWORD` 같은 실행 환경 입력으로 받고 Git에 기록하지 않는다.

### 2. app SealedSecret 작성

다음 두 파일을 각 클러스터 공개키로 별도 생성한다.

```text
e-gitops/platform/service-credentials/aws-dev/auth.sealedsecret.yaml
e-gitops/platform/service-credentials/private-dev/auth.sealedsecret.yaml
```

둘 다 최종 Kubernetes Secret 이름은 `auth-runtime-secrets`, namespace는 `dropmong-auth`이며 다음 key를 제공해야 한다.

```text
AUTH_JWT_SECRET              최소 32 bytes
AUTH_CREDENTIAL_HMAC_KEY     최소 32 bytes
AUTH_REPLAY_ENCRYPTION_KEY   정확히 32 bytes
```

기존 Git values에 있던 문자열은 이미 노출된 값으로 보고 재사용하지 않고 회전한다.

### 3. auth 환경 values 수정

수정 파일은 다음 두 개다.

```text
e-gitops/values/services/aws-dev/auth.yaml
e-gitops/values/services/private-dev/auth.yaml
```

두 파일의 `container.env`를 아래 계약에 맞는 최종 목록으로 만든다.

```yaml
container:
  env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: postgres-auth-credentials
          key: database-url
    - name: AUDIT_SINK_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: postgres-auth-credentials
          key: database-url
    - name: AUTH_JWT_SECRET
      valueFrom:
        secretKeyRef:
          name: auth-runtime-secrets
          key: AUTH_JWT_SECRET
    - name: AUTH_CREDENTIAL_HMAC_KEY
      valueFrom:
        secretKeyRef:
          name: auth-runtime-secrets
          key: AUTH_CREDENTIAL_HMAC_KEY
    - name: AUTH_REPLAY_ENCRYPTION_KEY
      valueFrom:
        secretKeyRef:
          name: auth-runtime-secrets
          key: AUTH_REPLAY_ENCRYPTION_KEY
    - name: AUTH_JWT_ISSUER
      value: auth-service
    - name: AUTH_TOKEN_TTL_SECONDS
      value: "900"
    - name: AUTH_REFRESH_TOKEN_TTL_SECONDS
      value: "604800"
    - name: AUTH_DEV_TEST_TOKEN_ENABLED
      value: "false"
```

AWS에서 token TTL을 7200으로 유지해야 하는 운영 요구가 있으면 해당 한 값만 7200으로 둔다. 중요한 점은 현재 values의 `JWT_SECRET`, `JWT_ISSUER`를 사용하지 않는다는 것이다. 소스가 읽는 정확한 이름은 `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER`다.

공통 파일도 정리한다.

```text
e-gitops/values/services/auth.yaml
```

이 파일의 `container.env`에서 DB URL과 세 애플리케이션 키 평문을 제거한다. aws-dev/private-dev가 모두 완전한 env 배열을 제공하므로 공통 파일에는 `AUTH_JWT_ISSUER`처럼 모든 환경에서 동일한 비밀이 아닌 값만 남기거나 빈 배열을 둔다. 단, local/scenario render에 필요한 개발값은 별도의 local/scenario values로 이동해야 하며 공유 환경용 평문을 공통 파일에 되돌려 넣지 않는다.

### 4. auth migration 활성화

환경별 auth values에 다음을 추가한다.

```yaml
migration:
  enabled: true
  command:
    - /app/migrate
  env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: postgres-auth-credentials
          key: database-url
    - name: AUDIT_SINK_DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: postgres-auth-credentials
          key: database-url
```

이 설정은 서비스 Deployment보다 먼저 같은 image의 `/app/migrate`를 실행한다. Job 실패 시 Argo PreSync가 실패하므로 새 Deployment로 넘어가면 안 된다.

### 5. auth render 검증

`e-gitops` 루트에서 실행한다.

```bash
task helm:lint
task helm:template:one SERVICE=auth ENV=aws-dev OUTPUT=auth-aws-dev.yaml
task helm:template:one SERVICE=auth ENV=private-dev OUTPUT=auth-private-dev.yaml
```

render 결과에서 확인한다.

```bash
rg -n "kind: Job|/app/migrate|postgres-auth-credentials|auth-runtime-secrets" auth-aws-dev.yaml auth-private-dev.yaml
rg -n "ticketing-dev-secret|dropmong-dev-|user:password|name: JWT_SECRET|name: JWT_ISSUER" auth-aws-dev.yaml auth-private-dev.yaml
```

첫 명령은 필요한 Job과 Secret 참조가 보여야 하고, 두 번째 명령은 출력이 없어야 한다. 생성한 render 파일은 검증용 임시 산출물이므로 커밋하지 않는다.

### 6. 클러스터 적용 전·후 검증

동기화 전에는 Secret과 DB가 먼저 존재하는지 확인한다.

```bash
kubectl -n dropmong-auth get secret postgres-auth-credentials auth-runtime-secrets
kubectl -n dropmong-auth get statefulset,svc auth-db
kubectl -n dropmong-auth get endpoints auth-db
```

Argo 동기화 후 migration과 rollout을 확인한다.

```bash
kubectl -n dropmong-auth get job,pod
kubectl -n dropmong-auth logs job/auth-service-migrate
kubectl -n dropmong-auth rollout status deployment/auth-service
kubectl -n dropmong-auth get pods
```

재동기화해 migration을 다시 실행했을 때도 성공해야 한다. 실패 검증은 DB URL을 망가뜨려 운영 Secret을 수정하는 방식으로 하지 말고, dev 전용 별도 Secret/namespace 또는 render된 테스트 release에서 수행한다.

rollback은 이전 image digest와 values commit으로 되돌리되 DB schema downgrade를 자동 수행하지 않는다. forward-compatible migration을 사용하고, 데이터 rollback이 필요한 경우 backup restore 절차를 따른다.

## auth 완료 gate

- AWS/private render에 DB/JWT/HMAC/replay 평문이 없다.
- `JWT_SECRET`, `JWT_ISSUER` 오타가 없고 소스 계약의 `AUTH_*` 이름을 사용한다.
- 두 환경 모두 DB Secret과 app Secret이 Deployment보다 먼저 존재한다.
- `/app/migrate`가 fresh DB와 재실행에서 성공한다.
- migration 성공 뒤 auth API와 worker가 Ready다.
- 기존 DB/PVC/Secret을 삭제하지 않았다.

auth가 이 gate를 통과하면 payment, order, catalog, notification, coupon 순으로 같은 패턴을 적용한다. interest는 명시적 migration command가 서비스 저장소에 추가될 때까지 migration 활성화를 보류하고, dropmong-web은 DB 없이 app SealedSecret만 적용한다.
