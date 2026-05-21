# Kubernetes Cluster Operations

이 문서는 준비된 서버나 클러스터 위에서 Kubernetes 운영 add-on을 확인하는 최소 흐름을 정리합니다. 서버 생성, 네트워크 구성, VM topology, OS 초기 설정은 infra repo 책임입니다.

## 이 repo가 다루는 것

| 영역 | 파일 |
|---|---|
| 클러스터 bootstrap 확인 | `cluster/ansible/playbooks/bootstrap-cluster.yml`, `cluster/ansible/playbooks/verify-cluster.yml` |
| Helm | `cluster/ansible/playbooks/bootstrap-helm.yml` |
| Metrics Server | `cluster/ansible/playbooks/bootstrap-metrics-server.yml`, `cluster/ansible/playbooks/verify-metrics-server.yml` |
| Local registry | `cluster/ansible/playbooks/bootstrap-registry.yml`, `cluster/ansible/playbooks/verify-registry.yml` |
| Observability storage | `cluster/ansible/playbooks/bootstrap-observability-storage.yml` |

## Inventory

Inventory는 이 repo에 두지 않습니다. infra repo에서 만든 inventory를 지정합니다.

```bash
make ANSIBLE_INVENTORY=/path/to/inventory.ini cluster-verify
make ANSIBLE_INVENTORY=/path/to/inventory.ini helm-bootstrap
make ANSIBLE_INVENTORY=/path/to/inventory.ini metrics-bootstrap
make ANSIBLE_INVENTORY=/path/to/inventory.ini metrics-verify
```

## 직접 확인

```bash
kubectl get nodes -o wide
kubectl get pods -n kube-system -o wide
kubectl get pods -A -o wide
```

## Observability

Prometheus, Grafana, Loki, Alloy, Tempo는 `cluster/stacks/observability`에서 관리합니다.

```bash
make ANSIBLE_INVENTORY=/path/to/inventory.ini observability-storage-bootstrap
make observability-install
kubectl get pods -n observability -o wide
```
