# Loki log backend

`platform/observability/loki`는 애플리케이션/시스템 기술 로그 저장소인 Loki의 GitOps 배포 기준을 둔다.

## 범위

- `values/aws-dev.yaml`: aws-dev 기준 Loki Helm values다.
- `values/local.yaml`: Docker Desktop 로컬 렌더링과 수동 dev 배포용 values다.
- `Taskfile.yml`: Helm chart 렌더링과 선택적 로컬 배포 명령을 둔다.

## 배포 기준

```text
log path
  stdout/stderr JSON
  -> Kubernetes container log
  -> OpenTelemetry Collector filelog receiver
  -> Loki
  -> Grafana
```

## Label 정책

Loki label은 낮은 cardinality 값만 허용한다.

```text
허용 후보
  - cluster
  - namespace
  - pod
  - container
  - app
  - service_name
  - deployment_environment
  - level
```

다음 값은 label로 올리지 않는다.

```text
금지
  - trace_id
  - span_id
  - request_id
  - user_id
  - reservation_id
  - payment_id
  - ticket_id
  - seat_id
  - raw URL path
  - query string
```

`trace_id`와 `request_id`는 JSON log field로 남겨 Grafana Explore에서 검색하거나 Tempo 이동 링크에만 사용한다. 업무 객체 ID는 기술 로그 label이 아니라 감사 로그/업무 검색 파이프라인에서 다룬다.

## Grafana datasource

Grafana 자체는 `platform/monitoring`의 `kube-prometheus-stack`이 관리한다. Loki datasource도 Grafana를 소유한 values에 선언한다.

```text
platform/monitoring/values/kube-prometheus-stack.yaml
platform/monitoring/values/kube-prometheus-stack-local.yaml
```

Loki datasource URL은 Kubernetes service DNS를 기준으로 둔다.

```text
http://loki.observability.svc.cluster.local:3100
```

## 검증

```bash
task --taskfile platform/observability/loki/Taskfile.yml render
task observability:render
task validate
```

live cluster 배포는 별도로 요청받았을 때만 실행한다.

```bash
task --taskfile platform/observability/loki/Taskfile.yml up
```
