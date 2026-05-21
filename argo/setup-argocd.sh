#!/bin/bash
set -euo pipefail

GITOPS_REPO_RAW_URL="${GITOPS_REPO_RAW_URL:-https://raw.githubusercontent.com/Medikong/gitops/main}"

echo "=== ArgoCD 설치 시작 ==="

# ArgoCD 네임스페이스 생성
kubectl create namespace argocd

# ArgoCD 설치
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# ArgoCD 파드 뜰 때까지 대기
echo "=== ArgoCD 파드 기다리는 중... ==="
kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=argocd-server -n argocd --timeout=120s

# application.yaml 적용
echo "=== Application 설정 적용 중... ==="
kubectl apply -f "${GITOPS_REPO_RAW_URL}/argo/application.yaml" -n argocd

# 초기 비밀번호 출력
echo "=== ArgoCD 초기 비밀번호 ==="
kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath="{.data.password}" | base64 -d && echo

echo "=== 완료! ==="
echo "포트포워딩: kubectl port-forward service/argocd-server 8090:443 -n argocd --address=0.0.0.0"
echo "접속: https://서버IP:8090"
