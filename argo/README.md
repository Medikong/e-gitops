# Argo CD

이 디렉터리는 `Medikong/gitops` repo를 감시하는 Argo CD Application을 관리합니다.

## 대상

| 항목 | 값 |
| --- | --- |
| Git repo | `https://github.com/Medikong/gitops.git` |
| Revision | `HEAD` |
| Path | `k8s/overlays/aws/all` |
| Application | `medical-platform` |

## 설치

이미 Argo CD가 설치되어 있다면 Application만 적용합니다.

```bash
kubectl apply -f argo/application.yaml -n argocd
```

Argo CD 설치까지 한 번에 확인하려면 다음 스크립트를 사용합니다.

```bash
./argo/setup-argocd.sh
```

원격 raw URL에서 실행해야 한다면 repo owner나 branch가 바뀌었을 때만 `GITOPS_REPO_RAW_URL`을 덮어씁니다.

```bash
GITOPS_REPO_RAW_URL=https://raw.githubusercontent.com/Medikong/gitops/main ./argo/setup-argocd.sh
```

## 확인

```bash
kubectl get application -n argocd
kubectl describe application medical-platform -n argocd
kubectl get pods -A
```

UI를 볼 때는 포트포워딩을 사용합니다.

```bash
kubectl port-forward service/argocd-server 8090:443 -n argocd --address=0.0.0.0
```
