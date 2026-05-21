# 프로젝트 3

## 🔹 프로젝트 개요

- **기본 프로젝트**: 클라우드 스토리지 및 분산 DB 클러스터링 구축
- **심화 프로젝트**: 서비스 메시(Service Mesh) 도입 및 관측성(Observability) 강화
- **서비스 예시**: 단일 데이터베이스 환경 → 분산 추적 및 메쉬 네트워크 기반 MSA 확장

## 🔹 요약 (빠르게 보기)

| 구분 | 영역 | 필수 과업 | 선택 과업 |
| --- | --- | --- | --- |
| **기본** | **데이터** | RDS/NoSQL 클러스터링 구축, 백업/복구 정책 수립 | DB 프록시 도입, Read Replica 분산 설계 |
|  | **스토리지** | Object Storage 연동, 정적 웹 호스팅 환경 구성 | 스토리지 암호화 및 수명 주기 관리(Lifecycle) |
|  | **네트워크** | 프라이빗 서브넷 내 DB 격리, VPC Endpoint 구성 | 전용선(Direct Connect) 또는 VPN 연결 기획 |
| **심화** | **Service Mesh** | Istio/Linkerd 도입, 서비스 간 트래픽 제어 | 서비스 메시 기반 보안 통신(mTLS) 적용 |
|  | **관측성** | 프로메테우스/그라파나 메트릭 수집, 로그 중앙화 | Jaeger/Tempo 활용 분산 추적(Tracing) |
|  | **운영** | 커스텀 대시보드 제작 및 임계치 기반 알림(Slack) | 카오스 엔지니어링(장애 주입 테스트) |

## 🔹 상세 구현 기준

### **📖 기본 프로젝트 —** MSA 구조 설계 및 구현

> **서비스 예시**: 의료 정보 플랫폼 (환자기록·예약·처방·알림 서비스)
>

### (1) 마이크로서비스 분할 전략

**`필수`**

- 도메인별 서비스 경계를 이벤트 스토밍으로 도출하고, 각 서비스가 독립적으로 배포·확장·장애 격리 가능하도록 경계를 정의한다.
- 서비스 간 통신 구조(동기 REST API vs 비동기 이벤트)를 설계하고 각 방식의 적용 기준을 문서화한다.
- 각 서비스별 독립 데이터베이스(Database per Service 패턴)를 적용하고 데이터 공유는 API 또는 이벤트를 통해서만 가능하도록 아키텍처 원칙을 정의한다.

**`선택`**

- Kafka를 StatefulSet으로 배포하여 서비스 간 주요 이벤트(`appointment-confirmed`, `prescription-issued` 등)를 토픽으로 정의하고 비동기 이벤트 통신을 구현한다.
- 이벤트 소싱(Event Sourcing) 패턴을 1개 서비스에 적용하여 변경 이력을 이벤트 저장소에 보관한다.

---

### (2) 서비스 디스커버리 및 로드 밸런싱

**`필수`**

- Kubernetes ClusterIP + DNS로 기본 서비스 디스커버리를 구성하고 서비스 간 내부 통신을 검증한다.
- Kong Gateway 또는 Nginx Ingress를 API 게이트웨이로 배포하여 서비스별 경로 라우팅과 JWT 인증 필터를 구성한다.
- 서비스 장애 격리 시나리오(의존 서비스 다운 시 부분 응답 반환)를 설계 문서로 작성한다.

**`선택`**

- Python 서비스에서 Circuit Breaker 또는 Fallback 로직을 구현하여 처방 서비스 장애 시 환자기록 서비스가 처방 정보 없이도 부분 응답을 반환하도록 적용하고 실제 장애 주입으로 검증한다.
- Kong Gateway에 Rate Limiting(서비스별 분당 요청 제한)을 추가로 구성한다.

---

### (3) 통합 테스트 및 운영 관리

**`필수`**

- pytest로 각 Python 서비스의 단위 테스트를 작성하고 CI 파이프라인에서 자동 실행한다.
- Postman Collection으로 서비스 간 연계 시나리오(환자 예약 → 예약 확정 이벤트 → 알림 발송)를 E2E 테스트로 작성한다.
- Prometheus + Grafana로 서비스별 에러율과 API 응답 시간을 수집하고 배포 후 기본 Observability 확인 체계를 수립한다.

**`선택`**

- Testcontainers로 실제 DB/Kafka 컨테이너를 활용한 통합 테스트 환경을 구성하여 Mock 없는 신뢰도 높은 테스트를 작성한다.
- Newman CLI로 Postman E2E 테스트를 CI 파이프라인에서 자동 실행한다.
- Kafka consumer lag을 Prometheus Kafka Exporter로 수집하여 이벤트 처리 지연을 조기 감지하는 알림을 설정한다.

### **📖 심화 프로젝트 —** 시스템 확장성과 보안 강화를 위한 아키텍처 재설계

> **서비스 예시**: 기본 프로젝트의 서비스를 이어서 고도화
>

### (1) 마이크로서비스 확장성 설계

**`필수`**

- 서비스별 독립 배포 파이프라인을 분리하고, 한 서비스의 배포가 다른 서비스에 영향을 주지 않음을 E2E 테스트로 검증한다.
- API 게이트웨이와 서비스 메시의 협업 구조를 검토하고 최적 구조를 선택하여 적용한다.
- PodDisruptionBudget(PDB)으로 클러스터 유지보수 중에도 각 서비스의 최소 Pod 수(2개)를 보장한다.

**`선택`**

- KEDA(Kafka consumer lag 기반)를 적용하여 이벤트 급증 시 서비스가 자동 확장되도록 ScaledObject를 구성한다.
- ArgoCD Rollouts로 주요 서비스에 Canary 배포(단계별 에러율 확인 후 자동 롤백)를 적용한다.

---

### (2) DevSecOps 파이프라인 강화

**`필수`**

- CI 파이프라인에 SonarQube 정적 분석을 통합한다. 코드 커버리지 80% 미만 또는 Critical 이슈 발견 시 파이프라인을 중단하고 결과를 PR 코멘트로 자동 게시한다.
- Trivy로 Kubernetes 매니페스트 스캔(`trivy config`)을 추가하여 privileged 컨테이너, 루트 실행 등 보안 위반 설정을 배포 전에 차단한다.
- 보안 스캔 결과를 Slack `#security-report` 채널에 연동한다.

**`선택`**

- OWASP ZAP으로 staging 환경 배포 후 DAST 동적 분석을 수행하고 취약점 보고서를 GitHub Security 탭에 SARIF 형식으로 업로드한다.
- OPA Gatekeeper ConstraintTemplate을 배포하여 `runAsNonRoot: true`, `readOnlyRootFilesystem: true`를 Namespace 전체에 강제하고 정책 위반 시 배포가 거부됨을 테스트로 검증한다.

---

### (3) 보안 아키텍처 재설계

**`필수`**

- Kubernetes RBAC을 정의하여 개발자(조회 전용)·운영자(Deployment 수정)·SRE(Namespace 전체 권한)로 역할을 분리한다.
- 서비스별 ServiceAccount를 분리하고 최소 권한 원칙에 따라 ClusterRole 대신 Role + RoleBinding을 사용한다.
- NetworkPolicy로 서비스 간 접근 제어 정책을 구현하고 의도하지 않은 통신이 차단됨을 테스트로 검증한다.

**`선택`**

- 보안 사고 대응(Incident Response) 프로세스를 탐지 → 격리 → 분석 → 복구 → 회고 5단계로 정의하고 각 단계를 자동화 스크립트로 구현한다.
- Falco를 DaemonSet으로 배포하여 컨테이너 런타임 이상 행위(비정상 shell 실행 등)를 실시간 탐지하고 Slack 알림을 연동한다.
