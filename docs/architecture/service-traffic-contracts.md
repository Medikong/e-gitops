# 서비스 트래픽과 인증 계약

이 문서는 승인된 identity-only 인증 경계가 서비스 트래픽에 요구하는 목표 계약을 기록한다. 현재 stage worktree의 Auth 소스에는 `/internal/ext-authz` Handler와 router 등록이 구현되어 있지만 공개 OpenAPI에는 없고, 현재 GitOps runtime에는 배포·외부 route·Istio 연결이 없다. active values/Gateway도 legacy JWT 구성이므로 아래 GitOps 항목은 구현 완료 상태가 아니라 후속 manifest 작업의 검증 기준이다.

## 현재 active deployment blocker

2026-07-17 기준 active GitOps desired state는 RS256-ready가 아니다.

| Active surface | 현재 관찰 | 목표와의 차이 | 해소 owner |
| --- | --- | --- | --- |
| `values/services/auth.yaml` | base `container.env`에 `AUTH_JWT_SECRET` 선언 | active 환경 overlay가 목록 전체를 대체하므로 private-dev/aws-dev effective env에는 남지 않음 | 후속 GitOps Auth migration |
| private-dev/aws-dev effective Auth stack | 각 환경 overlay의 최종 `container.env`에 legacy `JWT_SECRET` 하나가 있고 `AUTH_JWT_PRIVATE_KEY_PEM`/`AUTH_JWT_KEY_ID`/`AUTH_JWT_ISSUER`는 없음 | 최신 Auth config 이름, signing 방식, issuer 공급과 불일치 | 후속 환경별 values migration |
| `values/services/dev/auth.yaml` | `JWT_SECRET` 선언 | private-dev/aws-dev active Application 어느 쪽에서도 참조하지 않는 repository overlay | 별도 dev 사용 여부를 확인한 뒤 후속 migration |
| `platform/kong/consumers/demo-users.yaml` | concrete HS256 JWT credential 선언 | RS256/JWKS와 identity-only 경계가 아님 | 후속 Gateway migration |
| private-dev/aws-dev Auth Applications | 공통 values와 해당 환경 overlay를 순서대로 참조 | Helm list replacement 뒤 환경별 `JWT_SECRET` 하나가 실제 effective desired input | 후속 Argo/GitOps migration |
| private-dev/aws-dev Kong shared resources | `platform/kong` 또는 그 overlay를 active source로 참조 | HS256 credential이 render됨 | 후속 Gateway/GitOps migration |
| Kong identity/role plugin | `dropmong-identity-headers`가 JWT `email`/`role`을 읽어 `X-User-Email`/`X-User-Role`을 만들고 `dropmong-role-*`가 role claim으로 `403`을 결정 | 세 identity header만 신뢰하는 목표와 충돌 | 후속 Gateway/GitOps migration |
| Active plugin attachments | Notification, Interest, Order, Payment ingress가 identity-header 또는 customer-role plugin을 참조 | role/email 생성과 role 기반 Gateway 인가가 active path에 남음 | 후속 서비스별 Gateway values migration |
| Notification/Interest runtime | 두 서비스가 `X-User-Role`을 입력으로 받아 role 기반 접근과 `403`을 결정 | role/email header를 신뢰하지 않는 목표와 충돌 | 후속 Notification/Interest 서비스 migration |
| Auth issuer config | 현재 코드가 미설정 시 `ServiceName`으로 fallback | 목표 운영 정책은 issuer 명시와 fallback 거부 | 후속 Auth runtime/config 작업 |
| Auth internal adapter | stage worktree 소스에 `/internal/ext-authz` Handler/router 등록 구현; 공개 OpenAPI 미노출 | active Auth 배포와 Istio provider/policy 연결 | 후속 GitOps/Istio migration |

안전한 render probe는 `platform/kong`에서 문서 17개와 HS256 JWT credential 1개를 확인했다. credential 값은 문서나 evidence에 복사하지 않는다. 안전한 effective-values probe는 private-dev/aws-dev 각각 `JWT_SECRET` 하나, 최신 RS256 key/key-ID/issuer 입력 0개, 최종 env 항목 6개를 확인했다. 이는 base 파일의 `AUTH_JWT_SECRET` 선언과 effective active stack을 구분한 결과다.

이 blocker들은 T2 문서 작업이나 stage worktree의 Handler 구현만으로 해소되지 않는다. 후속 GitOps 작업이 legacy values, Kong credential과 role/email plugin 경로를 제거하고 RS256 key/issuer의 Secret-backed 공급 경로와 Istio 연결을 구현·검증해야 한다. Notification/Interest 후속 작업도 role-header trust를 제거해야 한다. 그 전에는 현재 배포가 RS256/JWKS, identity-only 또는 ext_authz를 제공한다고 주장하거나 최신 Auth 이미지를 rollout하면 안 된다.

## 목표 책임 경계

| 참여자 | 책임 | 금지 |
| --- | --- | --- |
| Auth | RS256 access JWT 서명, JWKS, Session 상태 판정 | role/permission/email claim 또는 업무 인가 판정 |
| Istio Ingress | 외부 trusted header 제거, JWT 검증, HTTP ext_authz 호출, 성공 헤더 재생성 | 업무 resource ownership 판정 |
| 업무 서비스 | `X-User-Id`와 도메인 owner를 비교 | JWT parsing, JWKS/Redis/Auth DB 직접 조회 |
| User 후보 서비스 | canonical 사용자 ID와 계정 상태 후보 | 검증 gate 전 운영 canonical 승격 |
| Backoffice retention | 별도 비활성 보존 경계 | 외부 Route나 active workload 복원 |

## 목표 Route allowlist

Route는 prefix 추측이 아니라 배포 manifest의 명시적 allowlist로 분류한다.

| Route 종류 | Ingress/Auth 규칙 | 실패 상태와 소유자 |
| --- | --- | --- |
| 공개 Auth Route | JWT/Session 검사를 붙이지 않고 Auth flow credential을 전달한다. | Auth flow 오류는 Auth 소유 |
| 업무 보호 Route와 `GET /api/v1/auth/context` | RS256 JWT와 Session 상태 검사가 모두 필수다. | 인증 거부 `401`, 미확정 `503`: Istio/Auth |
| refresh/logout Route | Bearer JWT를 요구하지 않고 refresh cookie/header credential을 Auth에 전달한다. | refresh 인증 거부 `401`: Auth |
| `GET /.well-known/jwks.json` | 사용자 JWT를 요구하지 않고 허용된 mesh caller만 접근한다. | JWKS 제공 상태: Auth |
| `/internal/ext-authz` | 외부 Gateway Route에 등록하지 않고 Ingress workload identity만 호출한다. | check 결과 `200`/`401`/`503`: Auth adapter |

새 보호 Route가 JWT 검증이나 ext_authz Session 확인 없이 등록되면 render/배포 검증을 실패시켜야 한다.

## 목표 보호 Route 처리

1. Ingress가 외부 요청의 `X-User-*`, `X-Session-*`, `X-Token-*`을 제거한다.
2. `RequestAuthentication`이 `alg=RS256`, `kid`, `typ=JWT`, signature와 `iss/sub/sid/aud/iat/exp/jti`를 검증한다.
3. Istio HTTP ext_authz가 request body 없이 `Authorization`, `X-Request-Id`, 원래 method/path를 Auth `/internal/ext-authz`로 전달한다.
4. Auth가 JWT를 독립적으로 다시 검증하고 공유 Redis와 PostgreSQL 원장으로 Session 상태를 확인한다.
5. 허용 시 세 내부 헤더만 원래 요청에 덮어쓰고 mTLS mesh로 업무 서비스에 전달한다.

목표 설정은 `failOpen=false`, `statusOnError=503`, timeout 200ms, 자동 재시도 없음이다. `includeRequestHeadersInCheck`는 `authorization`, `x-request-id`만, `headersToUpstreamOnAllow`는 `x-user-id`, `x-session-id`, `x-token-id`만 허용한다.

## Route/status/header matrix

| Route class | 인증 rule | 성공 | 인증 실패 | 상태 미확정 | 업무 인가 실패 |
| --- | --- | --- | --- | --- | --- |
| 공개 Auth | Auth flow credential | Route별 Auth 응답 | Auth 소유 응답 | Auth 소유 `503` | 해당 없음 |
| 보호 업무/Auth context | JWT + `/internal/ext-authz` Session | 업무 응답; upstream header 세 개 | Istio/Auth `401` | Istio/Auth `503` | 업무 서비스 `403` |
| refresh/logout | refresh credential | Auth 응답 | Auth `401` | Auth `503` | 해당 없음 |
| JWKS | mesh caller policy | Auth `200` JWK Set | 네트워크 정책 거부 | Auth/JWKS `503` | 해당 없음 |
| internal ext_authz | Ingress workload identity | Auth `200` + header 세 개 | Auth `401` | Auth `503` | 반환하지 않음 |

성공 시 생성 가능한 헤더는 `X-User-Id <- sub`, `X-Session-Id <- sid`, `X-Token-Id <- jti`뿐이다. role, permission, email, membership과 업무 ACL claim/header는 금지한다. 외부가 보낸 동일 이름 헤더를 병합하거나 보존하지 않는다.

업무 서비스는 인증 성공 후 `X-User-Id`가 리소스 owner와 다르면 `403`을 반환한다. 이 상태는 JWT/Session 인증 거부 `401`이나 Auth/Redis/PostgreSQL/JWKS 상태를 확정할 수 없는 `503`과 합치지 않는다.

## 공개 surface 제한

- 공개 OpenAPI `paths`에는 `/internal/ext-authz`를 넣지 않는다.
- Gateway Route에는 `/internal/ext-authz`를 등록하지 않는다.
- JWKS는 공개 업무 Route가 아니며 허용된 mesh 구성요소만 접근시킨다.
- Backoffice는 별도 비활성 retention 경계다. 인증 배포를 이유로 Backoffice route/workload를 복구하지 않는다.

## GitOps 구현 전 검증 기준

- 모든 보호 Route가 JWT, audience 제한, HTTP ext_authz와 trusted header 재생성을 함께 가진다.
- 외부 header 주입, JWT 없음/변조/만료/잘못된 audience, Session 폐기와 ext_authz timeout이 fail closed로 끝난다.
- 공개 OpenAPI와 Gateway render 어디에도 `/internal/ext-authz`가 없다.
- User 후보 서비스의 승격과 Backoffice retention 상태는 인증 구성 변경과 분리한다.
- active effective Auth stack에서 legacy `JWT_SECRET`이 제거되고 RS256 private key, key ID와 명시적 issuer가 Secret-backed 입력으로 공급된다. Base 선언과 비활성 dev overlay도 별도로 정리한다.
- active Kong render에서 HS256 JWT credential이 제거된 뒤에만 Istio RS256/JWKS 경계를 ready로 판정한다.
- active Kong identity/role plugin attachment와 Notification/Interest의 `X-User-Role` trust가 제거된 뒤에만 identity-only 경계를 ready로 판정한다.
