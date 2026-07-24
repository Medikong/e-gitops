# DropMong 부하 테스트 API 목록

이 문서는 현재 서비스 코드와 `platform/loadtest/values/scenarios/service-static-replica-capacity-load-test.yaml`을 함께 확인해 만든 측정 계약이다. 단순히 TicketMong의 API 이름을 바꾼 목록이 아니다. 각 k6 workload는 표의 **측정 여부**가 `측정`인 요청만 공식 요청 수와 latency(응답 시간)에 포함한다.

route 기준은 service 저장소의 Auth `internal/interface/http/*/routes.go`, User `internal/domain/user/routes.go`, Coupon `internal/transport/http/router.go`, 각 Python 서비스의 `app/main.py`와 cancellation router, Web의 `app/api/web/**/route.ts`다. workload와 가중치 기준은 단일 실험 YAML과 `workloads/*.js`다.

## 분류 기준

| 분류 | 뜻 | 측정 원칙 |
| --- | --- | --- |
| readiness 전용 | Pod가 요청을 받을 준비가 됐는지 확인하는 경로 | 실행 전에만 호출하고 성능 수치에서 제외 |
| 조회 부하 | 저장된 상태를 읽는 사용자 요청 | endpoint별 latency와 오류를 측정 |
| 상태 변경 부하 | DB, outbox, Kafka 등에 상태를 남기는 사용자 요청 | 독립 fixture 범위와 idempotency key를 사용 |
| 내부 API | 운영자 또는 workload 사이에서만 쓰는 경로 | 이번 사용자 API 용량 측정에서 제외 |
| Kafka 유입 기반 | HTTP 대신 Kafka 메시지가 쓰기 입력인 기능 | k6 밖의 producer Job으로 만들고 consumer lag를 별도 판정 |
| 개발 mock | 실제 하위 서비스의 저장·결제를 대신한 개발 구현 | 실제 Order·Payment 용량과 구분 |
| 이번 측정 제외 | 실제 API이지만 현재 workload의 질문과 데이터 범위를 벗어남 | 요청 수와 percentile에서 제외 |

`/healthz`, `/readyz`, `/metrics`는 모든 서비스에서 준비 상태 또는 관측 전용이다. readiness 확인 요청, 인증 setup, fixture 준비 시간은 공식 latency에 포함하지 않는다.

profile에서 `fixtureAccess: read`는 존재가 확인된 fixture를 반복 조회해도 된다는 뜻이고, `fixtureAccess: write`는 해당 시행에만 쓸 비중복 범위를 배정한다는 뜻이다. HTTP 메서드나 `상태 변경 부하` 분류만으로 fixture 소모 여부를 추측하지 않는다. 예를 들어 Auth email sign-in은 세션을 만들지만 사용자 fixture는 `read`이고, Payment approve·fail과 Web checkout confirm은 `write`다. 상태 변경 또는 Kafka 유입이 있는 서비스는 calibration, 각 candidate, confirmation 반복 전에 target DB와 쓰기 cursor를 초기화하며, DB가 없는 Web은 쓰기 cursor만 초기화한다.

## Auth

workload: `auth-intent-and-email-signin`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `POST /api/v1/auth/intents` | 상태 변경 부하 | 측정 | 50% | 모바일 채널 intent와 auth flow token을 새로 만든다. |
| `GET /api/v1/auth/methods` | 조회 부하 | 측정 | 20% | 앞서 만든 auth flow token을 사용한다. |
| `POST /api/v1/auth/signins/email` | 상태 변경 부하 | 측정 | 30% | Secret에서 주입한 비밀번호와 fixture 사용자를 사용하고 세션·쿠키 생성 비용을 포함한다. |
| `POST /api/v1/auth/sessions/{refresh,logout}`, `GET /api/v1/auth/context` | 이번 측정 제외 | 제외 | - | 세션 수명주기는 이번 email sign-in 용량 질문과 분리한다. |
| `POST /api/v1/auth/signins/phone/challenges*` | 이번 측정 제외 | 제외 | - | 외부 검증 메시지 의존성이 있는 별도 기능이다. |
| `POST /api/v1/auth/registrations*` | 이번 측정 제외 | 제외 | - | 가입 fixture 소진과 검증 절차가 별도다. |
| `POST /api/v1/auth/password-resets*`, `PUT .../password` | 이번 측정 제외 | 제외 | - | 보안 민감 상태 변경을 일반 부하에 섞지 않는다. |
| `POST /api/v1/auth/reauthentications/email`, `/method-links*`, `/phone-replacements*` | 이번 측정 제외 | 제외 | - | 재인증·인증수단 변경은 별도 시험 대상이다. |
| `/api/v1/operator/auth/*` | 내부 API | 제외 | - | 운영자 권한 경계가 다른 API다. |
| `GET /.well-known/jwks.json` | 조회 부하 | 제외 | - | 공개 조회지만 이번 workload의 핵심 경로가 아니다. |
| `GET /api/v1/dev/auth/verification-messages/{challengeId}` | 개발 mock | 제외 | - | 개발 검증 메시지 조회다. |

## User

workload: `profile-read-and-update`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /api/v1/users/me/profile` | 조회 부하 | 측정 | 75% | fixture `userId`에 대응하는 개발용 Bearer session을 사용한다. |
| `PATCH /api/v1/users/me/profile` | 상태 변경 부하 | 측정 | 25% | `Origin`, idempotency key, `expectedUserVersion`을 사용한다. 같은 candidate의 `profileWrite` 범위를 겹치지 않게 배정한다. |
| `POST /api/v1/users` | 이번 측정 제외 | 제외 | - | 사용자 생성 수명주기는 현재 profile 조회·수정 질문과 분리한다. |
| `PUT /api/v1/users/me/profile-image` | 상태 변경 부하 | 제외 | - | 파일·이미지 저장 비용을 현재 JSON profile workload와 섞지 않는다. |
| `/api/v1/operator/users/{userId}/*` | 내부 API | 제외 | - | 운영자 권한 경계가 다르다. |

## Catalog

workload: `drop-list-and-detail`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /drops` | 조회 부하 | 측정 | 60% | 공개 목록 조회다. |
| `GET /drops/{dropId}` | 조회 부하 | 측정 | 40% | `drops` fixture의 현재 조회 가능한 ID만 쓴다. 응답 안의 상품은 하나의 drop에 속한다. |

Catalog에는 상품 등록 API가 없다. 따라서 부하 테스트가 임의의 상품을 HTTP로 만들지 않으며, 결정론적 seeder가 넣은 상품만 사용한다.

`inventory.changed` consumer는 별도 worker Deployment가 아니라 Catalog 앱 프로세스의 lifespan task다. Kafka 연결은 데이터셋 준비 시 consumer group readiness 확인에 필요하지만, 현재 읽기 부하는 Kafka 메시지를 만들지 않는다. 로컬 Kafka Chart에도 JMX exporter가 없으므로 Kafka lag·처리량 부재는 이 workload의 API 용량 실패로 판정하지 않고 `unavailable` 이유로 보존한다.

## Coupon

workload: `coupon-wallet-and-issuance`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /api/v1/users/me/coupons` | 조회 부하 | 측정 | 50% | `couponWallet` 사용자의 지갑을 조회한다. |
| `GET /api/v1/users/me/coupons/{userCouponId}` | 조회 부하 | 측정 | 25% | 사용자와 쿠폰 소유 관계가 확인된 fixture만 쓴다. |
| `POST /api/v1/coupon-campaigns/{campaignId}/claims` | 상태 변경 부하 | 측정 | 15% | 같은 candidate의 `couponClaim` 범위와 idempotency key를 사용한다. |
| `POST /api/v1/coupon-code-redemptions` | 상태 변경 부하 | 측정 | 10% | 같은 candidate의 `couponRedeem` 범위와 Secret 파일 참조를 사용한다. |
| `/api/v1/internal/coupon-validations` | 내부 API | 제외 | - | Order·Payment workload가 사용하는 검증 경계다. |
| `/api/v1/internal/coupon-redemptions/{redemptionId}/{reserve,commit,release,revoke}` | 내부 API | 제외 | - | redemption 상태 전이 용량은 별도 서비스 간 시험 대상이다. |
| `/api/v1/internal/coupon-campaigns*` | 내부 API | 제외 | - | 캠페인 생성·정책·심사·성과 API는 운영자 계약이다. |
| `/api/v1/internal/bulk-coupon-issue-jobs*` | 내부 API | 제외 | - | 대량 작업은 장시간 worker 시험으로 분리한다. |
| `/api/v1/internal/coupon-operational-controls*`, `/coupon-event-recoveries*`, `/coupon-incidents/status` | 내부 API | 제외 | - | 장애 대응·복구 기능은 일반 사용자 API 부하가 아니다. |
| `/api/v1/internal/users/{userId}/coupon-timeline`, `/coupon-cost-attributions`, `/compensation-coupon-issue-requests` | 내부 API | 제외 | - | 운영 조사·보상 계약이다. |

현재 로컬 external adapter가 claim 검증을 fail-closed로 거부하면 이를 성능 저하가 아니라 `API 계약 미연결` 실패로 기록한다. 성공률을 맞추기 위해 오류를 지우거나 threshold를 낮추지 않는다.

## Interest

workload: `interest-and-ranking`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /v1/users/me/interests` | 조회 부하 | 측정 | 30% | `existingInterests` 사용자로 목록을 읽는다. |
| `GET /v1/rankings/drops/upcoming` | 조회 부하 | 측정 | 20% | 찜 집계 순위를 읽는다. |
| `GET /v1/rankings/drops/trending` | 조회 부하 | 측정 | 20% | 조회 이벤트 기반 순위를 읽는다. |
| `POST /v1/drops/{dropId}/views` | 상태 변경 부하 | 측정 | 15% | `viewEvents` fixture로 조회 이벤트와 누적 집계를 만든다. |
| `PUT /v1/users/me/interests/{dropId}` | 상태 변경 부하 | 측정 | 10% | 같은 candidate의 `interestAdd` 범위를 사용한다. |
| `DELETE /v1/users/me/interests/{dropId}` | 상태 변경 부하 | 측정 | 5% | 실제 기존 찜만 사용한다. |
| `GET /v1/operator/drops/{dropId}/interest-stats` | 내부 API | 제외 | - | 운영자용 집계 조회다. |

## Order

workload: `order-create-read-cancel`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /orders/{orderId}` | 조회 부하 | 측정 | 60% | 소유 사용자가 일치하는 `orderRead` fixture만 사용한다. |
| `POST /orders` | 상태 변경 부하 | 측정 | 25% | 주문당 상품 하나라는 현재 계약을 따르고 `orderCreate`와 고유 idempotency key를 사용한다. |
| `POST /orders/{orderId}/cancellations` | 상태 변경 부하 | 측정 | 15% | 취소 가능한 `orderCancel` 범위를 같은 candidate 안에서 분리한다. |
| `GET /orders/{orderId}/cancellations` | 조회 부하 | 제외 | - | 취소 상태 조회는 이번 endpoint mix에 넣지 않았다. |

주문 생성은 재고 예약과 outbox side effect를 포함한다. 같은 candidate의 warmup과 measurement에서는 fixture를 재사용하지 않으며, 다음 독립 candidate 전에는 Order DB를 같은 seed로 다시 시드한다. Order만 선택해도 취소 이벤트를 소비하는 Payment의 `payment-refund-consumer`를 필수 downstream으로 함께 배포하고, `dropmong-payment` 자원과 Kafka lag를 같은 시행 자료에 포함한다.

## Payment

workload: `payment-read-approve-fail`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /payments/{paymentId}` | 조회 부하 | 측정 | 60% | 소유 사용자가 일치하는 terminal payment를 조회한다. |
| `POST /payments/mock-approvals` | 상태 변경 부하 | 측정 | 25% | terminal payment가 아직 없는 `paymentReady` 주문만 사용한다. |
| `POST /payments/mock-failures` | 상태 변경 부하 | 측정 | 15% | approve와 겹치지 않는 `paymentReady` 범위를 사용한다. |

Payment는 주문 하나에 terminal payment 하나만 허용한다. 짧은 시행이라도 동일 주문을 approve와 fail에 동시에 쓰지 않으며, fixture가 부족하면 임의 재사용 대신 실패한다.

## Notification

workload: `notification-read-with-kafka-ingress`

| 요청 경로 또는 입력 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /notifications` | 조회 부하 | 측정 | 100% | `notificationRead` 사용자의 저장된 알림을 읽는다. |
| Kafka `notification.requested` | Kafka 유입 기반 | 별도 측정 | 별도 producer | `notificationEvents`를 k6 밖의 producer Job이 발행한다. HTTP latency와 섞지 않고 consumer lag와 저장 결과를 본다. |

알림을 직접 등록하는 HTTP API는 없다. 따라서 notification 쓰기 용량을 HTTP RPS로 표현하지 않는다. producer는 k6의 측정 시작 표식을 기다린 뒤 `notificationEvents`의 비중복 slice를 측정 시간 전체에 고르게 발행한다. 시작하자마자 이벤트를 한꺼번에 보내는 burst와 지속 처리 능력을 혼동하지 않고, HTTP 조회 latency와 Kafka 처리량·lag를 따로 판정한다.

## Dropmong Web

workload: `web-home-product-development-checkout`

| 요청 경로 | 분류 | 측정 여부 | profile 비중 | 인증·상태 변화 |
| --- | --- | --- | ---: | --- |
| `GET /api/web/home` | 조회 부하 | 측정 | 45% | Catalog upstream을 포함한 BFF 응답을 측정한다. |
| `GET /api/web/products/{productId}` | 조회 부하 | 측정 | 35% | `webProducts`의 실제 product ID를 사용한다. |
| `GET /api/web/checkouts/{checkoutId}` | 개발 mock | 측정하되 별도 표기 | 15% | 개발 session과 `webCheckouts`를 사용한다. 실제 Order·Payment DB 용량이 아니다. |
| `POST /api/web/checkouts/{checkoutId}/confirm` | 개발 mock | 측정하되 별도 표기 | 5% | development session, same-origin, CSRF, idempotency 계약을 지킨다. |
| `GET /api/web/auth/development-session` | 개발 mock | setup만 | - | 측정 전에 session cookie를 만들며 공식 latency에서 제외한다. |
| `GET /api/web/orders/{orderId}` | 개발 mock | 제외 | - | 이번 endpoint mix에는 포함하지 않았다. |
| `/api/web/seller/*`, 개발 seller session·reauth | 개발 mock | 제외 | - | 판매자 작업공간은 이번 9개 사용자 API 비교 범위가 아니다. |

`DEV_MOCK_MODE=false`인 환경에서도 public home·product 측정은 계속한다. checkout 계약이 연결되지 않았다면 해당 endpoint만 `개발 mock 미활성화` 실패로 남긴다. 이 수치를 실제 결제 처리량으로 해석하지 않는다.

## 인증과 비밀값 경계

- 인증이 필요한 외부 Istio 요청은 fixture `userId`와 1:1로 발급한 개발용 Bearer session을 사용한다. `X-Principal`과 `X-User-Id`로 인증을 우회하지 않는다.
- email sign-in 비밀번호, password hash, access token, refresh token, 쿠키는 fixture, k6 JSON, Loki, Markdown 보고서에 기록하지 않는다.
- 인증 값은 Kubernetes Secret으로 주입하고, 로그에는 참조 방식과 설정 여부만 남긴다.
- Coupon code 원문도 결과물에 넣지 않는다. fixture는 `secretFileRef`만 보관하고 Dataset·k6 Job이 같은 read-only Kubernetes Secret을 마운트한다.
- setup 요청과 토큰 발급은 공식 요청 수, 실제 RPS, latency percentile에서 제외한다.
