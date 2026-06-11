# Operating log collection policy

이 문서는 `Medikong/workspace#32`, `Medikong/service#17`, `Medikong/gitops#25`의 운영 로그 수집/보존 기준이다.

## 원칙

Loki는 모든 request/access log 원장이 아니다. 운영 신호는 다음 경계를 지킨다.

```text
metric
  /metrics -> Prometheus

trace
  OTLP trace -> OpenTelemetry Collector -> Tempo

technical log
  stdout/stderr JSON -> OpenTelemetry Collector filelog -> Loki

audit evidence
  business event/outbox -> 별도 검색/증적 파이프라인
```

서비스 코드는 Loki, Collector, drop, sampling 정책을 알지 않는다. 서비스는 구조화 JSON log field만 남기고, 어떤 로그를 Loki에 보낼지는 GitOps Collector pipeline이 결정한다.

## Service 책임

`packages/observability`의 request/access log는 `event="http.request.completed"`를 유지하고 다음 field를 일관되게 남긴다.

```text
service.name
service.version
service.environment
severity
severity_text
http.method
http.route
http.route.kind
http.status_code
duration_ms
request_id
trace_id
span_id
client_action_id
http.request.is_probe
log.kind
log.policy
```

분류 기준:

| 조건 | service field | Collector 정책 |
| --- | --- | --- |
| `/health`, `/healthz`, `/readyz`, `/metrics` 성공 | `http.route.kind=probe`, `log.policy=drop` | local/aws-dev에서 drop |
| 일반 2xx/3xx API | `http.route.kind=api`, `log.policy=sample` | aws-dev에서 10% sampling |
| `duration_ms >= 1000` | `duration_ms`, `log.policy=keep` | keep |
| 5xx | `severity_text=ERROR`, `log.policy=keep` | keep |
| 4xx 또는 debug route | `severity_text=WARN` 또는 `http.route.kind=debug`, `log.policy=keep` | keep |
| synthetic 실행 로그 | `synthetic_run_id`, scenario/step field | keep 후보 |

reservation/payment/ticket/user id, `request_id`, `trace_id`, `span_id`, `synthetic_run_id`는 JSON body field로만 둔다. 감사성 증적이 필요한 도메인 이벤트는 Loki access log가 아니라 별도 파이프라인에서 다룬다.

## GitOps Collector 책임

Collector는 contrib distribution을 쓴다. `filelog` receiver와 로그 sampling processor가 contrib/k8s distribution 구성요소이기 때문이다.

```text
image: otel/opentelemetry-collector-contrib:0.153.0
command: otelcol-contrib
mode: daemonset
```

DaemonSet을 쓰는 이유는 Kubernetes container stdout/stderr 파일이 노드별 `/var/log/pods` 아래에 있기 때문이다. 단일 Deployment는 자신이 스케줄된 노드의 로그만 볼 수 있어 운영 수집 경로로 충분하지 않다.

환경별 정책:

| 환경 | 정책 |
| --- | --- |
| local | JSON parsing과 Loki 전송을 검증하되 성공 probe 로그는 drop하고, 일반 2xx/3xx access log는 샘플링하지 않는다. |
| aws-dev | probe 성공 로그는 drop, 일반 2xx/3xx access log는 10% sampling, 5xx/slow/warn/error/synthetic 로그는 keep 경로를 유지한다. |
| prod | 현재 repo에 `platform/observability/collector/values/prod.yaml`가 없으므로 문서 기준만 둔다. 실제 강한 정책 적용은 prod values 경로가 생긴 뒤 별도 변경으로 한다. |

## Loki label 정책

Loki label은 낮은 cardinality만 허용한다.

```text
허용
  - namespace / k8s.namespace.name
  - pod / k8s.pod.name
  - container / k8s.container.name
  - service / service.name / service_name
  - environment / deployment.environment.name
  - scenario
  - step
```

다음 값은 label로 올리지 않는다.

```text
금지
  - trace_id
  - span_id
  - request_id
  - client_action_id
  - synthetic_run_id
  - user_id
  - reservation_id
  - payment_id
  - ticket_id
  - seat_id
  - raw URL path
  - query string
```

## LogQL 예시

5xx request:

```logql
{service_name="reservation-service"} | json | event="http.request.completed" | http_status_code >= 500
```

slow request:

```logql
{service_name="payment-service"} | json | event="http.request.completed" | duration_ms >= 1000
```

trace id로 기술 로그 찾기:

```logql
{service_name="ticket-service"} | json | trace_id="0242ac120002..."
```

synthetic 실행 단위 확인:

```logql
{scenario="reservation-payment-ticket"} | json | synthetic_run_id="run-20260611-001"
```

## 검증

정책 변경 후 기본 검증은 다음 순서로 한다.

```bash
task --taskfile platform/observability/collector/Taskfile.yml render
task observability:render
task validate
git diff --check
```

live cluster 배포와 Argo CD sync는 별도 요청이 있을 때만 수행한다.
