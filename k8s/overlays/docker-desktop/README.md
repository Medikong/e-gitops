# Docker Desktop Kubernetes 로컬 실행

이 overlay는 별도 `kind` CLI 없이 Docker Desktop에 내장된 Kubernetes에서 빠르게 확인하기 위해 만들었던 실험용 구성이다. 현재 루트 `Makefile`의 로컬 Kubernetes 경로는 `cluster`의 Vagrant VM 기반 직접 배포 흐름으로 통일했기 때문에, Docker Desktop용 Make target은 제공하지 않는다.

## 전제

Docker Desktop의 Kubernetes가 켜져 있어야 한다. 기본 context 이름은 `docker-desktop`이다.

```bash
kubectl config get-contexts docker-desktop
kubectl --context docker-desktop cluster-info
```

## 배포

필요하면 manifest를 직접 적용한다.

```bash
kubectl --context docker-desktop apply -k k8s/overlays/docker-desktop
```

Docker Desktop overlay에서는 API Gateway route가 Eureka `lb://...`를 쓰지 않고 Kubernetes Service DNS를 직접 바라본다.

```text
/patient-service/**      -> http://patient-service:8081
/appointment-service/**  -> http://appointment-service:8082
/prescription-service/** -> http://prescription-service:8083
/notification-service/** -> http://notification-service:8084
```

이 결정의 배경과 Eureka 유지안과의 비교는 `../../docs/service-discovery-decision.md`를 본다.

## 상태 확인

```bash
kubectl --context docker-desktop -n medical-platform get pods,svc,pvc -o wide
```

## 접속

Dashboard와 API Gateway는 Docker Desktop overlay에서만 LoadBalancer로 열어 둔다.

```text
Dashboard: http://localhost:8088
API Gateway: http://localhost:8080
```

나머지 Service는 ClusterIP로 유지한다.

```bash
kubectl --context docker-desktop -n medical-platform get svc api-gateway dashboard
```

## Pod 일괄 종료

Deployment와 StatefulSet의 replicas를 `0`으로 내려서 앱, DB, Kafka Pod를 모두 종료한다. 리소스와 PVC는 남겨둔다.

```bash
kubectl --context docker-desktop -n medical-platform scale deployment/api-gateway deployment/patient-service deployment/appointment-service deployment/prescription-service deployment/notification-service deployment/dashboard --replicas=0
kubectl --context docker-desktop -n medical-platform scale statefulset/patient-db statefulset/appointment-db statefulset/prescription-db statefulset/kafka --replicas=0
```

## 정리

```bash
kubectl --context docker-desktop delete -k k8s/overlays/docker-desktop
```
