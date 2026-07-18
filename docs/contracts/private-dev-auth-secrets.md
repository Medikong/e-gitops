# Private-dev Auth Secret contract

The private-dev Auth release consumes Secret references only. This repository does not create the Secrets, commit their values, or carry placeholder `encryptedData`. Provision them through the approved private-dev bootstrap path before syncing `auth-private-dev`.

## `postgres-auth-credentials`

This existing Secret remains the PostgreSQL contract in namespace `dropmong-auth`.

| Key | Consumers |
| --- | --- |
| `password` | `auth-db` PostgreSQL container |
| `database-url` | Auth API, worker, and `/app/migrate` as `DATABASE_URL` and `AUDIT_SINK_DATABASE_URL` |

`database-url` must address the private-dev `auth-db` service. PostgreSQL is the source of truth for Auth and Session state; Redis is only a disposable status projection/cache.

## `auth-runtime-credentials`

Create this Secret in namespace `dropmong-auth` with all keys below.

| Key | Runtime input | Constraint |
| --- | --- | --- |
| `jwt-private-key-pem` | `AUTH_JWT_PRIVATE_KEY_PEM` | RSA private key PEM used for RS256; never commit it |
| `jwt-key-id` | `AUTH_JWT_KEY_ID` | non-empty active key ID matching JWKS |
| `jwt-issuer` | `AUTH_JWT_ISSUER` | explicit non-empty issuer approved for private-dev |
| `credential-hmac-key` | `AUTH_CREDENTIAL_HMAC_KEY` | at least 32 bytes |
| `replay-encryption-key` | `AUTH_REPLAY_ENCRYPTION_KEY` | exactly 32 bytes |
| `auth-proof-private-key` | `AUTH_PROOF_PRIVATE_KEY` | Auth-to-User Ed25519 private key in the runtime encoding |
| `auth-proof-key-id` | `AUTH_PROOF_KEY_ID` | non-empty Auth proof key ID |
| `user-proof-public-key` | `AUTH_USER_PROOF_PUBLIC_KEY` | User-to-Auth Ed25519 public key in the runtime encoding |
| `user-proof-key-id` | `AUTH_USER_PROOF_KEY_ID` | non-empty User proof key ID |
| `allowed-origins` | `AUTH_ALLOWED_ORIGINS` | comma-separated approved HTTPS origins |

The non-sensitive `AUTH_JWT_AUDIENCES=dropmong-api` and `AUTH_USER_PROOF_ISSUER=user-service` remain explicit values in Helm. Rotation adds retiring public keys only through an approved runtime Secret update; no private key or token belongs in Git.

## Private-dev Redis boundary

`auth-session-redis` is an unauthenticated, single-replica, ephemeral Redis deployment limited to private-dev. It has only a `ClusterIP` Service and an ingress NetworkPolicy allowing pods labeled `dropmong.io/service=auth` in `dropmong-auth`; there is no Ingress, NodePort, LoadBalancer, or external Service. Avoiding a Redis password prevents credentials from appearing in process arguments. This network-policy-only choice is acceptable only for the isolated private-dev namespace and must not be copied to shared or production environments.

The local image cache did not provide a RepoDigest during implementation, so the manifest uses the explicit `redis:7.4.2-alpine` tag. Pin an approved immutable digest before promotion beyond private-dev.
