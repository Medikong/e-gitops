# Tempo trace backend

`platform/observability/tempo`는 trace 저장소인 Tempo의 GitOps 배포 기준을 둔다.

## 범위

- `values/aws-dev.yaml`: aws-dev 기준 Tempo Helm values다.
- `values/local.yaml`: Docker Desktop 로컬 렌더링과 수동 dev 배포용 values다.
- `Taskfile.yml`: Helm chart 렌더링과 선택적 로컬 배포 명령을 둔다.

OpenTelemetry Collector의 OTLP receiver, processor, exporter는 `platform/observability/collector`의 `gitops#18` 범위다. 이 디렉터리는 Collector가 보낼 trace backend와 Grafana 조회 연결 기준만 다룬다.

## 배포 기준

```text
trace path
  FastAPI OpenTelemetry instrumentation
  -> OTLP
  -> OpenTelemetry Collector
  -> Tempo
  -> Grafana
```

- namespace: `observability`
- Helm chart: `grafana/tempo`
- chart version: `1.24.4`
- app version: `2.9.0`
- mode: single binary
- aws-dev image registry: ECR
- storage: filesystem PVC
- aws-dev retention: `72h`
- local retention: `6h`

초기 aws-dev는 실제 span 양을 보기 전이므로 단일 binary와 filesystem PVC로 시작한다. S3 같은 object storage, HA 구성, prod retention은 infra/storage 기준이 정해진 뒤 별도 작업으로 올린다.

aws-dev values는 `205623789422.dkr.ecr.ap-northeast-2.amazonaws.com/grafana/tempo:2.9.0`을 바라본다. 배포 전 `.github/workflows/observability-image-mirror.yml`로 `docker.io/grafana/tempo:2.9.0`을 ECR에 mirror해야 한다. 미러링 대상과 버전은 이 values 파일의 `imageMirror.images`에서 함께 관리한다.

## Grafana datasource

Grafana 자체는 `platform/monitoring`의 `kube-prometheus-stack`이 관리한다. Tempo datasource도 Grafana를 소유한 values에 선언한다.

```text
platform/monitoring/values/kube-prometheus-stack.yaml
platform/monitoring/values/kube-prometheus-stack-local.yaml
```

Tempo datasource URL은 Kubernetes service DNS를 기준으로 둔다.

```text
http://tempo.observability.svc.cluster.local:3200
```

Tempo의 trace-to-logs 연결은 Loki log field의 `trace_id`를 검색에 사용한다. `trace_id`, `request_id`, `user_id`, reservation/payment/ticket 같은 업무 객체 ID는 Loki label이나 metric label로 올리지 않는다.

## 검증

```bash
task --taskfile platform/observability/tempo/Taskfile.yml render
task observability:render
task validate
```

live cluster 배포는 별도로 요청받았을 때만 실행한다.

```bash
task --taskfile platform/observability/tempo/Taskfile.yml up
```
