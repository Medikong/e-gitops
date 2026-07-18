---
id: ADR-0002
title: Istio Gateway 인증을 identity-only로 제한하고 Backoffice를 별도 비활성 경계로 유지한다
status: accepted
date: 2026-07-17
decision_owner: Medikong GitOps
related:
  - ../architecture/service-traffic-contracts.md
tags:
  - gitops
  - istio
  - auth
  - ext-authz
  - backoffice
---

# ADR-0002: Istio Gateway 인증을 identity-only로 제한하고 Backoffice를 별도 비활성 경계로 유지한다

## 배경

이전 계약은 공유 대칭키와 role/email claim/header를 전제로 업무 서비스가 인증과 인가를 함께 해석했다. 최신 Auth 설계는 RS256/JWKS로 서명을 검증하고 Session 상태까지 확인하되, 업무 인가는 서비스 소유 데이터로 판정하는 identity-only 경계다.

Backoffice와 User도 같은 배포 단위로 취급할 수 없다. User는 canonical 사용자 ID와 계정 상태를 제공할 후보지만 검증 gate가 남아 있다. Backoffice는 데이터 보존이 필요한 별도 경계이며 현재 active route/workload로 운영하지 않는다.

현재 stage worktree의 Auth 소스에는 `/internal/ext-authz` Handler와 router 등록이 구현되어 있지만 공개 OpenAPI에는 없다. active GitOps는 아직 이 결정 이전 상태다. 공통 Auth values에는 legacy `AUTH_JWT_SECRET` 선언이 있지만 active private-dev/aws-dev overlay가 `container.env` 목록 전체를 대체하므로, 두 effective stack에는 각각 `JWT_SECRET` 하나만 남고 RS256 private key/key ID/issuer 입력은 없다. repository dev overlay는 두 active Application에서 참조하지 않는다. Kong shared resources는 concrete HS256 JWT credential을 render하고, identity-header/role-guard plugin은 JWT email/role을 헤더와 `403` 결정에 사용한다. 관련 attachment가 Notification, Interest, Order, Payment ingress에 남고 Notification/Interest runtime도 `X-User-Role`을 신뢰한다. Istio 연결은 없으며 현재 Auth config도 issuer가 없으면 `ServiceName`으로 fallback한다. 따라서 이 ADR의 `accepted`는 목표 경계의 승인 상태이지 현재 배포 완료나 RS256/ext_authz/identity-only readiness를 뜻하지 않는다.

## 목표 결정

후속 구현에서 Istio Ingress는 RS256 access JWT를 Auth의 `GET /.well-known/jwks.json` 공개키로 검증한다. JWT protected header는 `alg=RS256`, `kid`, `typ=JWT`, claim allowlist는 `iss`, `sub`, `sid`, `aud`, `iat`, `exp`, `jti`다.

보호 Route는 Auth의 내부 경로 `/internal/ext-authz`에 HTTP check를 보내 Session 상태를 확인한다. stage worktree의 Handler와 router 등록은 구현되어 있고 공개 OpenAPI에는 없다. 외부 Gateway Route에 등록하지 않고 지정된 Ingress workload identity만 호출하게 하는 Istio manifest는 아직 없으므로, 이 결정은 source 구현 사실과 후속 GitOps 배포·연결 기준을 구분하며 현재 배포 성공을 선언하지 않는다.

check가 허용되면 Istio는 다음 세 헤더만 업무 서비스에 만든다.

- `X-User-Id` from `sub`
- `X-Session-Id` from `sid`
- `X-Token-Id` from `jti`

role, permission, email, membership 또는 업무 ACL claim/header는 만들지 않는다. 외부의 동일 이름 header는 제거한 뒤 검증 결과로 덮어쓴다.

상태 책임은 다음과 같이 나눈다.

| 결과 | 상태 | 소유자 |
| --- | --- | --- |
| JWT와 active Session 확인 | `200` check 허용 | Istio + Auth |
| JWT 오류, Session expired/revoked, 사용자 불일치 | `401` | Istio + Auth |
| Auth/JWKS/Redis/PostgreSQL 상태 미확정 | `503` fail closed | Istio + Auth |
| 인증 성공 뒤 resource ownership 불일치 | `403` | 업무 서비스 |

User는 후보 서비스로 유지하며 별도 검증 gate 전에는 canonical 승격을 선언하지 않는다. Backoffice는 별도 retention lane에서 비활성 상태와 prune 보호를 유지한다. Auth/User 배포를 위해 Backoffice route나 workload를 복구하지 않고 Backoffice를 User로 대체하지도 않는다.

## 결과

아래 결과는 후속 Auth/GitOps migration이 active legacy 입력을 제거하고 이 결정을 구현했을 때 성립하는 목표 결과다.

- 업무 서비스는 JWT parser, JWKS client와 Auth Session 저장소에 결합하지 않는다.
- role header 위조로 resource ownership 검사를 우회할 수 없다.
- 인증 실패 `401`, 업무 인가 실패 `403`, 상태 미확정 `503`의 소유자가 분리된다.
- JWKS/key rotation과 Session 폐기는 Auth 경계에서 일관되게 적용된다.
- Backoffice 데이터 보존과 User 후보 검증이 인증 rollout과 독립적으로 진행된다.

동시에 Auth와 Redis/PostgreSQL 장애는 보호 Route의 `503`으로 이어진다. 이를 가용성보다 인증 fail-closed를 우선하는 의도된 결과로 받아들인다.

## 대안

### 공유 대칭키 secret을 서비스에 배포한다

서비스마다 secret을 배포하고 JWT를 직접 parsing해야 하며 rotation과 폐기 상태가 분산된다. identity-only 경계와 맞지 않아 채택하지 않는다.

### role/permission claim과 header를 유지한다

Auth가 업무 정책을 소유하게 되고 오래된 JWT가 정책 변경을 지연시킨다. 업무 서비스의 resource ownership 판정을 우회할 입력도 늘어나므로 채택하지 않는다.

### ext_authz 장애를 fail open으로 처리한다

Session 폐기나 사용자 상태를 확정하지 못한 요청이 업무 서비스에 도달한다. 인증 보장보다 가용성을 우선하게 되므로 채택하지 않는다.

### Backoffice를 User로 대체하거나 함께 활성화한다

서로 다른 데이터와 lifecycle 경계를 합치고 검증되지 않은 workload를 복구한다. 별도 migration/승격 결정 없이 채택하지 않는다.

## 검증 기준

- 보호 Route만 JWT와 `/internal/ext-authz` check를 요구하고 공개/refresh/logout/JWKS Route는 명시적으로 분리된다.
- 성공 check의 upstream header allowlist가 정확히 세 개다.
- `/internal/ext-authz`가 공개 OpenAPI와 Gateway route에 없다.
- `401`/`403`/`503` 책임이 architecture 문서와 일치한다.
- Backoffice는 inactive/prune-protected이고 User는 candidate로 표시된다.
- active Auth values와 Kong render에서 legacy symmetric JWT secret/HS256 credential이 사라지고 RS256 key ID, private key와 명시적 issuer가 승인된 Secret-backed 경로로 공급된다.
- active Kong attachment에서 role/email 생성과 role-guard가 사라지고 Notification/Interest runtime이 `X-User-Role`을 더 이상 신뢰하지 않는다.
