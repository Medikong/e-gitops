# Platform policies

Gatekeeper, Falco, namespace 공통 보안 정책처럼 cluster-level 정책은 서비스 Helm release와 분리해 이 영역에서 관리한다.

서비스별 `NetworkPolicy`, `ServiceAccount`, `Role`, `RoleBinding`은 `charts/medikong-service` release가 관리한다.

기존 서비스별 NetworkPolicy는 `values/services/*`로 옮겨졌고, messaging/data 영역처럼 서비스 release 경계를 넘는 정책은 `platform/data` 이식 때 별도 정책으로 분리한다.

## Human RBAC

`human-rbac.yaml`은 서비스 namespace에 접근하는 사람 역할을 namespace-scoped `Role`과 `RoleBinding`으로 분리한다.

| Group | Role | 권한 |
| --- | --- | --- |
| `medikong:developers` | `medikong-developer-readonly` | Pod, log, Service, Deployment, Ingress, NetworkPolicy, HPA, PDB, ServiceMonitor 조회 |
| `medikong:operators` | `medikong-operator-deployment-manager` | 조회 권한 + Deployment/scale patch/update |
| `medikong:sres` | `medikong-sre-namespace-admin` | 각 namespace 안에서 전체 리소스 관리 |

의도:

- 사용자 역할은 `ClusterRole`/`ClusterRoleBinding` 대신 namespace별 `Role`/`RoleBinding`으로 제한한다.
- 서비스 Pod용 ServiceAccount는 서비스 Helm release가 계속 관리한다.
- 실제 사용자와 group 매핑은 kubeconfig, 인증서, OIDC, IAM 연동 방식에서 `medikong:*` group claim을 부여하는 쪽에서 처리한다.

검증 예시:

```bash
kubectl auth can-i get pods \
  -n dropmong-payment \
  --as=rbac-test \
  --as-group=medikong:developers

kubectl auth can-i patch deployment/payment-service \
  -n dropmong-payment \
  --as=rbac-test \
  --as-group=medikong:operators

kubectl auth can-i delete namespace dropmong-payment \
  --as=rbac-test \
  --as-group=medikong:sres
```

기대 결과:

- `medikong:developers`는 조회만 가능하다.
- `medikong:operators`는 Deployment patch/update와 scale 조정이 가능하지만 namespace 전체 admin은 아니다.
- `medikong:sres`는 개별 service namespace 안에서 admin이고, cluster-wide 권한은 갖지 않는다.
