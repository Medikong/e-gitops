# Kubernetes 리소스 절감 실험 계획

이 문서는 로컬 VM Kubernetes 환경에서 MSA 앱, PostgreSQL, Kafka의 메모리 상한을 어디까지 낮출 수 있는지 실측하기 위한 기준이다.

목표는 성능 최적화가 아니라 로컬 실습 환경의 안정적인 최소 메모리 footprint를 찾는 것이다. 우선 낮게 잡고, OOM이나 readiness 실패가 확인되는 컴포넌트만 단계적으로 올린다.

## 기본 원칙

- Java 서비스는 Go 서비스의 idle RSS와 직접 비교하지 않는다. JVM은 heap 외에도 metaspace, code cache, thread stack, native memory를 사용한다.
- `-Xmx`는 heap 상한이고, Kubernetes `memory.limit`은 전체 컨테이너 메모리 상한이다.
- PostgreSQL은 로컬 CRUD 실습용이므로 OS/page cache나 DB cache를 크게 가져가지 않는다.
- 측정은 idle 상태와 간단한 CRUD 부하 상태를 나눠서 본다.

## 초기 실험값

| 대상 | 주요 설정 | request | limit | 의도 |
| --- | --- | ---: | ---: | --- |
| Spring Boot 서비스 | `-Xms48m -Xmx96m` | `128Mi` | `256Mi` | 160Mi에서 OOMKilled가 발생해 한 단계 상향한 값 |
| API Gateway | `-Xms64m -Xmx128m` | `160Mi` | `320Mi` | route/filter 비용과 startup 여유를 감안한 값 |
| PostgreSQL | `shared_buffers=16MB`, `work_mem=1MB`, `max_connections=20` | `96Mi` | `192Mi` | 캐시보다 최소 구동 안정성 우선 |
| Kafka | `KAFKA_LOG_DIRS=/var/lib/kafka/data`, replication factor `1` | `512Mi` | `1Gi` | 단일 브로커 KRaft 구동 안정성 우선 |

## 조정 파라미터

### Java 서비스

| 파라미터 | 1차 | 2차 | 3차 | 관찰 포인트 |
| --- | ---: | ---: | ---: | --- |
| `-Xmx` | `64m` | `96m` | `128m` | OOM, GC 빈도, 요청 실패 |
| `MaxMetaspaceSize` | `96m` | `128m` | `160m` | class loading 실패, startup 실패 |
| `ReservedCodeCacheSize` | `32m` | `48m` | `64m` | code cache full 경고 |
| `Xss` | `256k` | `512k` | `1m` | thread stack 관련 오류 |
| pod memory limit | `160Mi` | `192Mi` | `256Mi` | `OOMKilled`, restart 증가 |

Spring Boot 앱은 이 환경에서 `160Mi` limit로 startup OOMKilled가 발생했으므로 현재 기준은 `256Mi`다. 다시 낮춰 실험할 때는 한 서비스씩 줄이고 rollout과 `kubectl top`을 같이 확인한다.

### PostgreSQL

| 파라미터 | 1차 | 2차 | 3차 | 관찰 포인트 |
| --- | ---: | ---: | ---: | --- |
| `shared_buffers` | `16MB` | `32MB` | `64MB` | startup, CRUD 지연 |
| `effective_cache_size` | `64MB` | `128MB` | `256MB` | 쿼리 플랜 참고값 |
| `work_mem` | `1MB` | `2MB` | `4MB` | 정렬/해시 쿼리 실패 여부 |
| `maintenance_work_mem` | `16MB` | `32MB` | `64MB` | 초기화/DDL 작업 |
| `max_connections` | `20` | `30` | `50` | 연결 실패 여부 |
| pod memory limit | `192Mi` | `256Mi` | `384Mi` | `OOMKilled`, startup 실패 |

CRUD 실습에서는 `shared_buffers`를 크게 잡을 이유가 없다. 연결 수 부족이 보이면 pool 설정을 먼저 보고, DB 메모리를 무조건 올리지 않는다.

## 실험 순서

1. 리소스 설정을 낮춘 manifest를 `k8s/base/apps`, `k8s/base/deps`, `k8s/overlays/local/apps`, `k8s/overlays/local/deps` 중 해당 범위에 반영한다.
2. `kubectl kustomize k8s/overlays/local/all` 또는 `make render-local-all`로 렌더링을 확인한다.
3. 앱 리소스는 `kubectl apply -k k8s/overlays/local/apps`, PostgreSQL/Kafka 리소스는 `kubectl apply -k k8s/overlays/local/deps`로 직접 적용한다.
4. 앱은 `cluster/scripts/verify-local-k8s-apps.sh`, PostgreSQL/Kafka는 `cluster/scripts/verify-local-k8s-deps.sh`로 Ready 상태를 확인한다.
5. idle 상태로 3분 대기한다.
6. `kubectl top pod` 값을 기록한다.
7. Dashboard 또는 API Gateway를 통해 CRUD 요청을 반복한다.
8. 부하 직후 `kubectl top pod`, restart count, 이벤트를 기록한다.
9. OOM이나 readiness 실패가 난 컴포넌트만 한 단계 올린다.

## 측정 명령

클러스터 상태는 현재 kubeconfig 대상에서 확인한다.

```bash
kubectl config current-context
```

```bash
kubectl top pod -n medical-platform
kubectl get pods -n medical-platform -o wide
kubectl get events -n medical-platform --sort-by=.lastTimestamp | tail -n 40
```

repo 루트에서는 다음 흐름을 짧게 실행할 수 있다.

```bash
kubectl apply -k k8s/overlays/local/apps
cluster/scripts/verify-local-k8s-apps.sh
cluster/scripts/show-local-k8s-status.sh
cluster/scripts/local-k8s-crud-smoke.sh
```

특정 pod가 재시작되면 원인을 본다.

```bash
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl describe pod -n medical-platform <pod-name>
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl logs -n medical-platform <pod-name> --previous
```

JVM이 실제로 옵션을 받았는지 확인한다.

```bash
sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl exec -n medical-platform <java-pod-name> -- printenv JAVA_TOOL_OPTIONS
```

## 판정 기준

다음 조건을 모두 만족하면 해당 단계는 통과로 본다.

- 모든 pod가 Ready 상태다.
- 3분 idle 동안 restart count가 증가하지 않는다.
- CRUD 요청 반복 중 5xx가 반복적으로 발생하지 않는다.
- `OOMKilled` 이벤트가 없다.
- peak memory가 limit의 80%를 계속 넘지 않는다.

다음 상황이면 해당 컴포넌트만 한 단계 올린다.

- Java 서비스가 `OutOfMemoryError` 또는 `OOMKilled`로 재시작된다.
- Spring Boot startup 중 metaspace/code cache 관련 오류가 난다.
- PostgreSQL이 startup 직후 종료되거나 연결을 안정적으로 받지 못한다.
- Kafka producer/consumer 요청이 반복 실패하면 `statefulset/kafka` 상태, `pod/kafka-0` 로그, 앱의 `SPRING_KAFKA_BOOTSTRAP_SERVERS` 값을 함께 확인한다.

## 기록 양식

| 날짜 | 이미지 태그 | 대상 | 설정 단계 | idle memory | peak memory | restart | 판정 | 메모 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
|  |  | api-gateway | Java 1차 |  |  |  |  |  |
|  |  | patient-service | Java 1차 |  |  |  |  |  |
|  |  | appointment-service | Java 1차 |  |  |  |  |  |
|  |  | prescription-service | Java 1차 |  |  |  |  |  |
|  |  | notification-service | Java 1차 |  |  |  |  |  |
|  |  | patient-db | PostgreSQL 1차 |  |  |  |  |  |
|  |  | appointment-db | PostgreSQL 1차 |  |  |  |  |  |
|  |  | prescription-db | PostgreSQL 1차 |  |  |  |  |  |
|  |  | kafka | Kafka 1차 |  |  |  |  |  |
