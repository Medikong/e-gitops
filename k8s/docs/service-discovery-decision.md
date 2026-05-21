# API Gateway 서비스 디스커버리 의사결정

## 배경

로컬 Docker Desktop Kubernetes 환경에서 Dashboard의 환자 등록 요청이 실패했다.

```text
POST http://localhost:8080/patient-service/patients
-> 500 Internal Server Error
```

처음에는 Dashboard나 patient-service의 환자 등록 로직 문제처럼 보였지만, 로그를 확인해보면 요청은 API Gateway까지 도착했고, API Gateway가 patient-service로 전달하는 단계에서 실패했다.

## 확인한 장애 원인

API Gateway 로그의 핵심 오류는 다음과 같았다.

```text
Failed to resolve 'patient-service-759586c68-qfkcc'
```

당시 API Gateway route는 다음처럼 Eureka 기반 서비스 디스커버리를 사용했다.

```yaml
uri: lb://patient-service
```

이 흐름에서는 API Gateway가 Eureka에서 `patient-service` 인스턴스를 조회하고, Eureka가 반환한 인스턴스 주소로 요청을 보낸다. 문제는 Eureka에 등록된 주소가 Kubernetes Service DNS가 아니라 Pod hostname이었다는 점이다.

```text
patient-service-759586c68-qfkcc
```

Kubernetes에서 안정적으로 사용할 수 있는 이름은 보통 Service DNS다.

```text
patient-service
patient-service.medical-platform.svc.cluster.local
```

따라서 실제 장애 흐름은 다음과 같다.

```text
Browser
-> api-gateway
-> lb://patient-service
-> Eureka에서 patient-service 인스턴스 조회
-> patient-service-759586c68-qfkcc 반환
-> Kubernetes DNS에서 해당 이름 해석 실패
-> 500 Internal Server Error
```

이후 Docker Desktop overlay에서 API Gateway route를 Kubernetes Service DNS로 바꾸자 같은 요청이 성공했다.

```text
POST /patient-service/patients
-> http://patient-service:8081/patients
-> 200 OK
```

## 선택지 1: Eureka 기반 디스커버리 유지

이 방식은 API Gateway route를 기존처럼 유지한다.

```yaml
uri: lb://patient-service
```

대신 각 서비스가 Eureka에 Kubernetes에서 접근 가능한 주소를 등록하도록 설정한다.

대표적으로 다음 설정을 고려한다.

```yaml
eureka:
  instance:
    prefer-ip-address: true
```

Kubernetes manifest에서는 환경변수로 줄 수 있다.

```yaml
env:
  - name: EUREKA_INSTANCE_PREFER_IP_ADDRESS
    value: "true"
```

필요하면 hostname, instance id, health check URL도 명시적으로 잡는다.

```yaml
env:
  - name: EUREKA_INSTANCE_PREFER_IP_ADDRESS
    value: "true"
  - name: EUREKA_INSTANCE_INSTANCE_ID
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
```

### 장점

- 기존 Spring Cloud Netflix/Eureka 구조를 유지할 수 있다.
- VM, Docker Compose, Kubernetes 밖의 환경까지 하나의 애플리케이션 디스커버리 모델로 설명할 수 있다.
- `lb://service-name` route 표현을 계속 사용할 수 있다.

### 단점

- Kubernetes Service와 Eureka가 서비스 디스커버리 역할을 중복 수행한다.
- Pod 재시작, readiness, endpoint 전환 상태를 Kubernetes와 Eureka가 각각 관리한다.
- Eureka에 잘못된 hostname이 등록되면 이번처럼 API Gateway가 Kubernetes DNS에서 해석할 수 없는 주소로 요청한다.
- Kubernetes 운영 모델을 배우는 관점에서는 추가 개념이 많아진다.

### 적합한 경우

- Eureka 자체를 학습하거나 유지하는 것이 목표일 때
- Kubernetes 외부 환경에서도 같은 서비스 디스커버리 구조를 유지해야 할 때
- 기존 Spring Cloud 기반 운영 모델을 최대한 보존해야 할 때

## 선택지 2: Kubernetes Service DNS 사용

이 방식은 API Gateway route에서 Eureka를 우회하고 Kubernetes Service DNS를 직접 사용한다.

```yaml
routes:
  - id: patient-service
    uri: http://patient-service:8081
    predicates:
      - Path=/patient-service/**
    filters:
      - StripPrefix=1
```

다른 서비스도 같은 방식으로 연결한다.

```text
/patient-service/**      -> http://patient-service:8081
/appointment-service/**  -> http://appointment-service:8082
/prescription-service/** -> http://prescription-service:8083
/notification-service/** -> http://notification-service:8084
```

여기서 `patient-service:8081`은 특정 Pod가 아니라 Kubernetes Service를 가리킨다.

```text
api-gateway
-> patient-service Service
-> Ready 상태인 patient-service Pod 중 하나
```

즉 로드밸런싱은 Kubernetes Service가 담당한다. 특정 Pod 이름이나 Pod IP로 직접 요청하는 방식이 아니다.

### 장점

- Kubernetes의 기본 서비스 디스커버리와 로드밸런싱 모델을 그대로 사용한다.
- Pod 이름, Pod IP 변화에 API Gateway가 직접 의존하지 않는다.
- readiness, endpoint, Service selector가 트래픽 대상을 결정하므로 Kubernetes 운영 모델과 잘 맞는다.
- Eureka 서버와 Eureka client 설정을 줄이거나 제거할 수 있다.

### 단점

- Spring Cloud Eureka 기반 서비스 디스커버리 학습 범위에서는 벗어난다.
- Kubernetes 밖에서 같은 설정을 그대로 쓰기 어렵다.
- 서비스 포트와 Service 이름이 API Gateway 설정에 명시된다.

### 적합한 경우

- Kubernetes를 주 실행 환경으로 보고 있을 때
- Service, Deployment, readiness, endpoint 중심의 운영 모델을 익히고 싶을 때
- 로컬 Docker Desktop, VM Kubernetes, local registry 배포 흐름을 Kubernetes-native하게 유지하고 싶을 때

## 비교

| 기준 | Eureka 유지 | Kubernetes Service DNS |
|---|---|---|
| Gateway route | `lb://patient-service` | `http://patient-service:8081` |
| 주소 발견 주체 | Eureka | Kubernetes DNS / Service |
| 로드밸런싱 주체 | Spring Cloud LoadBalancer | Kubernetes Service |
| Pod 재시작 대응 | Eureka 등록/해제 타이밍에 의존 | Service endpoint 갱신에 의존 |
| Kubernetes 학습 적합성 | 중간 | 높음 |
| Spring Cloud 학습 적합성 | 높음 | 낮음 |
| 운영 단순성 | 낮음 | 높음 |
| 현재 장애 재발 가능성 | 설정을 잘못 잡으면 있음 | 낮음 |

## 권장 결정

이 프로젝트의 현재 목표가 Docker Desktop Kubernetes, VM Kubernetes, local registry, Service/Deployment 운영 흐름을 익히는 것이라면 Kubernetes Service DNS 방식을 기본 방향으로 잡는 것이 더 낫다.

권장 방향은 다음과 같다.

```text
Kubernetes 환경
-> API Gateway는 Kubernetes Service DNS로 라우팅
-> Eureka는 제거하거나, 학습 목적의 선택 컴포넌트로 분리

Docker Compose / 순수 Spring Cloud 학습 환경
-> Eureka 기반 lb:// 라우팅을 별도 예제로 유지 가능
```

현재 Kubernetes manifest는 이 권장 방향을 적용한 상태다.

```text
k8s/base
-> eureka-server manifest를 기본 배포 경로에서 제외

k8s/overlays/local
-> VM kubeadm 클러스터에서 API Gateway route를 Kubernetes Service DNS로 덮어씀
-> Dashboard/API Gateway를 NodePort로 노출

k8s/overlays/docker-desktop
-> Docker Desktop Kubernetes에서도 API Gateway route를 Kubernetes Service DNS로 덮어씀
```

## 다음 작업 제안

1. VM Kubernetes 직접 배포 후 `http://10.10.10.10:30080` API Gateway 경로를 smoke test한다.
2. Docker Compose / 순수 Spring Cloud 학습 환경에서도 Eureka를 제거할지 별도로 결정한다.
3. 결정이 확정되면 Spring app 기본 설정과 Gradle 의존성에서도 Eureka client를 정리한다.
