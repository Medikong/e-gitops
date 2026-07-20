# OpenTelemetry Collector trace/log pipeline

`platform/observability/collector`는 서비스 파드가 보낸 trace를 받고 Kubernetes container stdout/stderr JSON 로그를 Loki로 전달하는 OpenTelemetry Collector 배포 기준을 둔다.

## 범위

- `values/aws-dev.yaml`: aws-dev 기준 OpenTelemetry Collector Helm values다.
- `values/local.yaml`: Docker Desktop 로컬 렌더링과 수동 dev 배포용 values다.
- `image-mirror/aws-dev.yaml`: 관측성 image mirror workflow가 읽는 Collector image mirror 기준이다. OpenTelemetry Collector Helm chart는 values schema가 엄격해서 `imageMirror` 같은 chart 외부 key를 values 파일에 둘 수 없으므로 이 파일로 분리한다.
- `Taskfile.yml`: Helm chart 렌더링과 선택적 로컬 배포 명령을 둔다.

application/k6 log는 stdout/stderr JSON line을 기준으로 하고, Collector가 Kubernetes node의 container log 파일을 읽어 Loki로 전달한다. metric scrape, audit log pipeline, k6 Prometheus remote write는 이 범위에 포함하지 않는다.

## 배포 기준

```text
trace path
  DropMong service OpenTelemetry instrumentation
  -> OTLP
  -> OpenTelemetry Collector
  -> Tempo
  -> Grafana

log path
  application/k6 stdout/stderr JSON line
  -> Kubernetes container log
  -> OpenTelemetry Collector filelog receiver
  -> Loki OTLP endpoint
  -> Grafana
```

- namespace: `observability`
- Helm chart: `open-telemetry/opentelemetry-collector`
- chart version: `0.158.0`
- implementation: OpenTelemetry Collector contrib
- image: `otel/opentelemetry-collector-contrib:0.153.0`
- mode: DaemonSet
- private-dev scheduling: no `nodeSelector`; filelog needs one Collector agent on each worker that can run workloads
- aws-dev image registry: ECR
- receiver: OTLP gRPC `4317`, OTLP HTTP `4318`
- log receiver: `filelog` on `/var/log/pods/*/*/*.log`
- processor: `memory_limiter`, `batch`
- log processors: JSON body parsing, resource normalization, filter, aws-dev access-log sampling
- exporter: OTLP gRPC to `tempo.observability.svc.cluster.local:4317`
- log exporter: OTLP HTTP to `http://loki.observability.svc.cluster.local:3100/otlp`
- self-metrics: ServiceMonitor scrape on `:8888/metrics`
- health check: `:13133/`

초기 trace는 sampling 없이 Collector가 받은 trace를 Tempo로 전달한다. Tail sampling은 실제 span 양과 Tempo 저장량을 본 뒤 prod 안정화 단계에서 별도 정책으로 추가한다.

로그는 환경별로 다르게 다룬다.

- `local`: parsed JSON log를 Loki로 보내되 성공 probe 로그는 drop하고, 일반 2xx/3xx access log는 샘플링하지 않는다.
- `aws-dev`: 성공 probe는 drop, 일반 2xx/3xx access log는 10% sampling, 5xx/slow/warn/error 로그는 keep 경로로 보낸다.
- `prod`: 현재 prod Collector values가 없으므로 `platform/observability/log-policy.md`의 기준만 둔다.

`filelog` receiver와 log sampling processor를 쓰기 때문에 core image가 아니라 contrib image를 사용한다. Collector는 DaemonSet으로 실행해 각 노드의 `/var/log/pods`를 읽는다.

## 서비스 endpoint

서비스 파드는 trace 전용 환경변수를 먼저 사용한다.

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://opentelemetry-collector.observability.svc.cluster.local:4317
```

공통 endpoint만 사용하는 서비스 helper는 다음 값을 fallback으로 둔다.

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://opentelemetry-collector.observability.svc.cluster.local:4317
```

HTTP/protobuf exporter를 쓰는 서비스는 trace 전용 endpoint를 다음처럼 둔다.

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://opentelemetry-collector.observability.svc.cluster.local:4318/v1/traces
```

서비스별 Helm values에 endpoint를 넣을 때는 trace export가 구현되고 검증된 workload에만 추가한다. context 전달만 구현된 frontend에 exporter endpoint가 있다고 가정하지 않는다.

## NetworkPolicy

Collector NetworkPolicy는 다음 경로만 연다.

```text
DropMong API/frontend namespace pods
  -> opentelemetry-collector:4317/4318

opentelemetry-collector
  -> tempo:4317
  -> loki:3100

monitoring namespace
  -> opentelemetry-collector:8888
```

Collector egress는 Tempo service DNS 해석을 위해 kube-system DNS `53/UDP,TCP`도 허용한다.

## 운영 확인

Prometheus/Grafana에서는 Collector self-metrics로 수신량과 exporter 실패 상태를 본다.

```text
otelcol_receiver_accepted_spans
otelcol_receiver_refused_spans
otelcol_exporter_sent_spans
otelcol_exporter_send_failed_spans
otelcol_processor_batch_batch_send_size
otelcol_process_memory_rss
```

로그 정책의 운영 기준, Loki label/cardinality 기준, LogQL 예시는 `platform/observability/log-policy.md`에 둔다.

## 검증

```bash
task --taskfile platform/observability/collector/Taskfile.yml render
task observability:render
task platform:render
task validate
```

Collector config 자체는 contrib image로 검증할 수 있다.

```bash
docker run --rm --entrypoint /otelcol-contrib otel/opentelemetry-collector-contrib:0.153.0 validate --config=/conf/relay.yaml
```

live cluster 배포는 별도로 요청받았을 때만 실행한다.

```bash
task --taskfile platform/observability/collector/Taskfile.yml up
```
