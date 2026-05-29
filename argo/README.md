# Argo CD

이 디렉터리는 `Medikong/gitops` repo를 감시하는 Argo CD Application 초안을 관리한다.

## 현재 초안

| 항목 | 값 |
| --- | --- |
| Git repo | `https://github.com/Medikong/gitops.git` |
| Revision | `HEAD` |
| Bootstrap Application | `argo/application.yaml` |
| Root path | `argo/applications/aws-dev/services` |
| Service chart | `charts/medikong-service` |
| Values order | `values/base.yaml -> values/env/<env>.yaml -> values/services/<service>.yaml -> optional override` |

`argo/application.yaml`은 `aws-dev` 서비스별 Application을 묶는 app-of-apps 초안이다. 기존 단일 Kustomize Application은 운영 경로에서 제외했고, reference는 `archive/k8s-kustomize`에 남긴다.

## 서비스별 Application

`argo/applications/aws-dev/services/*.yaml`은 서비스 하나를 Helm release 하나로 배포하는 구조를 보여준다.

각 Application은 Argo CD multi-source values 참조를 사용한다.

```yaml
sources:
  - path: charts/medikong-service
    helm:
      valueFiles:
        - $values/values/base.yaml
        - $values/values/env/aws-dev.yaml
        - $values/values/services/reservation.yaml
  - ref: values
```

이 초안은 실제 sync 수행 전 구조 검증용이다. sync wave, project 분리, prod 승인 정책, secret 연결은 후속 작업으로 분리한다.

## 적용

이미 Argo CD가 설치되어 있다면 bootstrap Application만 적용한다.

```bash
kubectl apply -f argo/application.yaml -n argocd
```

Argo CD 설치까지 한 번에 확인하려면 다음 스크립트를 사용한다.

```bash
./argo/setup-argocd.sh
```

원격 raw URL에서 실행해야 한다면 repo owner나 branch가 바뀌었을 때만 `GITOPS_REPO_RAW_URL`을 덮어쓴다.

```bash
GITOPS_REPO_RAW_URL=https://raw.githubusercontent.com/Medikong/gitops/main ./argo/setup-argocd.sh
```

## 확인

```bash
kubectl get application -n argocd
kubectl describe application medikong-aws-dev-apps -n argocd
```
