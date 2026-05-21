# Installed Cluster Components

이 문서는 GitOps repo에서 확인하는 Kubernetes 운영 구성 요소를 정리합니다. 서버 패키지 설치와 OS 초기 설정은 infra repo 책임입니다.

## Kubernetes 운영 구성

| 항목 | 목적 |
|---|---|
| `containerd` | Kubernetes 노드의 container runtime |
| `kubelet` | 각 노드에서 Pod 실행 상태를 관리 |
| `kubeadm` | control-plane 초기화와 worker join에 사용 |
| `kubectl` | 클러스터 조작과 상태 확인에 사용 |
| Calico CNI | Pod network 구성과 노드 간 Pod 통신 활성화 |
| Metrics Server | HPA와 `kubectl top`에 필요한 resource metrics 제공 |
| Helm | Kong, observability 같은 운영 add-on 설치에 사용 |
| local registry | 로컬 클러스터에서 반복 가능한 image pull 경로 제공 |

## 이 repo의 확인 명령

```bash
make ANSIBLE_INVENTORY=/path/to/inventory.ini cluster-verify
make ANSIBLE_INVENTORY=/path/to/inventory.ini metrics-verify
make ANSIBLE_INVENTORY=/path/to/inventory.ini registry-verify
kubectl get pods -A -o wide
kubectl get nodes -o wide
```

## 제외

서버 계정, SSH key, OS package, kernel module, swap, containerd 기본 설치는 이 repo에서 직접 관리하지 않습니다. 필요한 inventory와 서버 준비는 infra repo에서 완료한 뒤 이 repo의 playbook과 manifest를 사용합니다.
