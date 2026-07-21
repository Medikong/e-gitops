# AWS Dev CloudNativePG 3-Instance 배포 및 Failover 검증

## 1. 목적

AWS Dev Kubernetes 환경에서 CloudNativePG Operator를 설치하고 PostgreSQL 3-instance 클러스터를 구성한 뒤 다음 항목을 검증한다.

- 전용 노드 배치
- AWS EBS gp3 볼륨 프로비저닝
- Primary 및 Replica 구성
- Primary 장애 시 자동 failover
- Read-write Service의 새 Primary 자동 전환

## 2. 검증 환경

| 항목                     | 값                                                      |
| ------------------------ | ------------------------------------------------------- |
| Kubernetes               | v1.34.9                                                 |
| CloudNativePG Operator   | 1.30.0                                                  |
| CloudNativePG Helm chart | 0.29.0                                                  |
| PostgreSQL 이미지        | `ghcr.io/cloudnative-pg/postgresql:15.14-system-trixie` |
| Cluster namespace        | `cnpg-test`                                             |
| Cluster name             | `cnpg-test`                                             |
| 인스턴스 수              | 3                                                       |
| StorageClass             | `medikong-aws-gp3`                                      |
| 인스턴스당 스토리지      | 5Gi                                                     |
| Volume binding           | `WaitForFirstConsumer`                                  |
| Reclaim policy           | `Retain`                                                |

## 3. 노드 배치 정책

CloudNativePG Operator는 platform 노드에 배치했다.

```yaml
nodeSelector:
  medikong.io/workload: platform
```

실제 배치 결과:

```text
CloudNativePG Operator → worker-platform-1
```

PostgreSQL 인스턴스는 data 노드에만 배치했다.

```yaml
affinity:
  enablePodAntiAffinity: true
  podAntiAffinityType: preferred
  topologyKey: kubernetes.io/hostname
  nodeSelector:
    medikong.io/workload: data
```

data 노드가 2대이고 PostgreSQL 인스턴스가 3개이므로 `preferred` anti-affinity를 사용했다. 이에 따라 가능하면 인스턴스를 서로 다른 노드에 배치하고, 세 번째 인스턴스는 기존 data 노드 중 하나에 함께 배치할 수 있다.

## 4. GitOps 변경

적용 커밋:

```text
3719020 fix(aws-dev): pin CloudNativePG workloads to dedicated nodes
```

변경 파일:

```text
platform/cloudnative-pg/operator/aws-dev-values.yaml
platform/cloudnative-pg/clusters/aws-dev/test-postgres/cluster.yaml
```

정적 검증 결과:

```text
task cnpg:render → 성공
task validate → 성공
```

## 5. 배포 결과

CloudNativePG Operator:

```text
cloudnative-pg → worker-platform-1
READY: 1/1
STATUS: Running
```

PostgreSQL 인스턴스:

| Pod           | 초기 역할 | 노드            | 상태    |
| ------------- | --------- | --------------- | ------- |
| `cnpg-test-1` | Primary   | `worker-data-2` | Running |
| `cnpg-test-2` | Replica   | `worker-data-1` | Running |
| `cnpg-test-3` | Replica   | `worker-data-2` | Running |

모든 PostgreSQL Pod는 `worker-data-1` 또는 `worker-data-2`에만 배치됐다.

## 6. 스토리지 결과

각 PostgreSQL 인스턴스마다 독립적인 5Gi EBS gp3 볼륨이 생성됐다.

| PVC           | 상태  | 크기 | StorageClass       |
| ------------- | ----- | ---: | ------------------ |
| `cnpg-test-1` | Bound |  5Gi | `medikong-aws-gp3` |
| `cnpg-test-2` | Bound |  5Gi | `medikong-aws-gp3` |
| `cnpg-test-3` | Bound |  5Gi | `medikong-aws-gp3` |

총 할당 용량은 15Gi이다.

StorageClass의 reclaim policy가 `Retain`이므로 테스트 클러스터 삭제 후에도 PV 또는 EBS 볼륨이 남을 수 있다. 테스트 종료 시 별도 비용 정리가 필요하다.

## 7. 생성된 Service

CloudNativePG가 다음 Service를 자동 생성했다.

| Service        | 용도                          |
| -------------- | ----------------------------- |
| `cnpg-test-rw` | 현재 Primary 연결             |
| `cnpg-test-ro` | Replica 읽기 연결             |
| `cnpg-test-r`  | 모든 PostgreSQL 인스턴스 연결 |

애플리케이션의 일반 읽기·쓰기 연결에는 다음 주소를 사용한다.

```text
cnpg-test-rw.cnpg-test.svc.cluster.local:5432
```

읽기 전용 트래픽 분리가 필요한 경우 다음 주소를 사용한다.

```text
cnpg-test-ro.cnpg-test.svc.cluster.local:5432
```

## 8. Failover 실험

### 실험 전 상태

Primary:

```text
Pod: cnpg-test-1
IP: 192.168.46.74
Node: worker-data-2
```

Read-write Service endpoint:

```text
cnpg-test-rw → 192.168.46.74:5432
```

### 장애 주입

기존 Primary Pod를 삭제했다.

```bash
kubectl delete pod cnpg-test-1 -n cnpg-test
```

### 자동 복구 결과

CloudNativePG가 `cnpg-test-2`를 새 Primary로 자동 승격했다.

```text
새 Primary: cnpg-test-2
IP: 192.168.19.56
Node: worker-data-1
```

기존 Primary인 `cnpg-test-1`은 새 Pod로 재생성되어 Replica 역할로 복귀했다.

최종 인스턴스 상태:

| Pod           | Failover 이후 역할 | 노드            | 상태    |
| ------------- | ------------------ | --------------- | ------- |
| `cnpg-test-1` | Replica            | `worker-data-2` | Running |
| `cnpg-test-2` | Primary            | `worker-data-1` | Running |
| `cnpg-test-3` | Replica            | `worker-data-2` | Running |

클러스터 상태:

```text
INSTANCES: 3
READY: 3
STATUS: Cluster in healthy state
PRIMARY: cnpg-test-2
```

Read-write Service endpoint도 새 Primary로 자동 변경됐다.

```text
변경 전: 192.168.46.74:5432
변경 후: 192.168.19.56:5432
```

## 9. 검증 판정

| 검증 항목                   | 결과 |
| --------------------------- | ---- |
| Operator platform 노드 배치 | 성공 |
| PostgreSQL data 노드 배치   | 성공 |
| 3-instance 생성             | 성공 |
| PVC 및 EBS gp3 생성         | 성공 |
| Primary/Replica 구성        | 성공 |
| Primary 장애 감지           | 성공 |
| Replica 자동 승격           | 성공 |
| 기존 인스턴스 재생성        | 성공 |
| `-rw` Service endpoint 전환 | 성공 |
| 클러스터 3/3 복구           | 성공 |

## 10. 현재 제약사항

현재 data 노드는 2대이므로 PostgreSQL 인스턴스 2개가 동일한 노드에 함께 배치된다.

```text
worker-data-1 → PostgreSQL 1개
worker-data-2 → PostgreSQL 2개
```

`worker-data-2` 장애 시 두 인스턴스가 동시에 영향을 받는다. 테스트 환경에서는 failover 검증이 가능하지만, 운영 수준의 3중 노드 장애 격리를 위해서는 세 번째 data 노드가 권장된다.

## 11. Istio 적용 범위

CloudNativePG Operator와 PostgreSQL 인스턴스에는 Istio sidecar를 적용하지 않는다.

```text
애플리케이션 서비스 간 통신 → Istio mTLS
애플리케이션과 PostgreSQL → PostgreSQL TLS 및 NetworkPolicy
PostgreSQL 복제 통신 → CloudNativePG 인증서와 TLS
```

PostgreSQL Pod가 `READY 1/1`로 표시되는 것은 Istio sidecar 없이 PostgreSQL 컨테이너만 실행하는 의도된 상태다.

## 12. 결론

AWS Dev 환경에서 CloudNativePG 3-instance 클러스터의 배포, 전용 노드 배치, AWS EBS gp3 프로비저닝, 자동 Primary failover 및 Service endpoint 전환이 정상 동작함을 확인했다.

CloudNativePG 테스트 기반 구성은 완료됐으며, 다음 단계는 모든 애플리케이션 서비스를 Istio mesh에 편입하는 작업이다.
