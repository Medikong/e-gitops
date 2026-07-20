# DropMong alert runbooks

모든 조사에서 비밀번호, token, cookie, webhook, 개인정보, DB 연결 문자열과 원문 payload를 출력하지 않는다. 먼저 metric으로 영향 범위와 시간을 잡고, LogQL로 `request_id`/`trace_id`를 찾고, Tempo에서 실패 또는 지연 span을 확인한다.

## DropMongSLOFastBurn

의미: 5분과 1시간 창에서 모두 `14.4x`를 넘었다. 급격한 5xx 증가다.

1. `dropmong:http_requests:rate5m`, `dropmong:http_5xx_ratio:rate5m`로 실제 traffic과 영향 서비스를 확인한다.
2. LogQL 라이브러리의 API 5xx 쿼리에서 route, request/trace ID를 찾는다.
3. Tempo에서 같은 trace의 첫 오류 span과 DB/HTTP/Kafka 의존성 span을 확인한다.
4. 최근 배포와 동시에 시작됐다면 해당 서비스의 안전한 rollback/traffic 차단 절차를 우선한다.
5. 두 burn-rate 창이 임계치 아래로 회복되고 실제 요청 표본이 존재하는지 확인한다.

30일 달성률이나 남은 Error Budget은 실제 30일 요청 자료 없이 계산하지 않는다.

## DropMongSLOSlowBurn

의미: 30분과 6시간 창에서 모두 `6x`를 넘었다. 작지만 계속되는 5xx 증가다.

1. service와 route별 5xx 비율을 정상 시간대와 비교한다.
2. 배포 version, 특정 route, 특정 의존성에 오류가 몰리는지 확인한다.
3. sample trace와 같은 request 로그로 재현 조건을 찾는다.
4. 용량 부족이면 HPA/Pod/Node 포화를, 기능 회귀면 최근 배포를 각각 조치한다.
5. 6시간 창이 내려갈 때까지 관찰하되 실측 SLO 달성으로 과장하지 않는다.

## DropMongServiceP99LatencyHigh

의미: API p99가 초기 slow-request 경계인 1초를 10분 동안 넘었다.

1. Traffic 증가와 동시에 발생했는지, 한 route 또는 전체 서비스인지 확인한다.
2. slow request LogQL에서 `trace_id`가 있는 표본을 고른다.
3. Tempo에서 가장 긴 span이 애플리케이션, DB, downstream HTTP, Kafka 중 어디인지 확인한다.
4. CPU throttling, active requests, connection/resource saturation을 함께 확인한다.
5. 1초는 부하·실사용 자료로 보정 전인 임시 경고선임을 incident 기록에 남긴다.

## DropMongServiceNotReady

의미: 한 서비스의 scrape target 중 하나 이상이 `service_ready=0`을 5분간 보고했다.

1. namespace, Pod, version, readiness probe 상태를 확인한다.
2. readiness가 검사하는 DB/Valkey/Kafka/필수 설정 중 실패 항목을 안전한 상태 정보로 확인한다.
3. 같은 Pod의 restart/OOM/CPU throttling과 최근 배포를 확인한다.
4. 준비되지 않은 Pod를 traffic에 강제로 넣지 말고 원인 의존성 또는 설정을 복구한다.
5. 모든 target이 `service_ready=1`이고 Kubernetes Ready 상태도 회복됐는지 확인한다.

## DropMongCollectorLogExportFailure

의미: Collector가 Loki exporter로 log record를 지속적으로 보내지 못했다. retry 중일 수 있으므로 바로 유실로 단정하지 않는다.

1. `otelcol_exporter_send_failed_log_records_total`, sent count, queue size/capacity를 exporter별로 확인한다.
2. Loki Service/Pod/PVC/network 상태와 Collector egress NetworkPolicy를 확인한다.
3. queue가 차면 수집량·batch/retry 설정과 Collector 자원을 확인한다.
4. Collector 자기 로그는 현재 filelog 제외 대상이므로 Loki 빈 결과를 정상 증거로 쓰지 않는다.
5. failure rate가 0으로 돌아오고 sent count가 다시 증가하는지 확인한다.

## DropMongCollectorTraceExportFailure

의미: Collector가 Tempo exporter로 span을 지속적으로 보내지 못했다. retry 중일 수 있으므로 바로 유실로 단정하지 않는다.

1. `otelcol_exporter_send_failed_spans_total`, sent spans, queue size/capacity를 확인한다.
2. Tempo distributor/service/PVC/network 상태와 OTLP `4317` egress를 확인한다.
3. tail-sampling decision wait와 Collector memory pressure를 확인한다.
4. 통제된 trace를 새로 보내기 전에 운영 승인 범위와 개인정보 제외를 확인한다.
5. failure rate가 0으로 돌아오고 Tempo에서 새 trace가 조회되는지 확인한다.

## DropMongDeploymentReplicasUnavailable

의미: DropMong/monitoring/observability Deployment의 desired replica보다 available replica가 적다.

1. Deployment rollout 상태와 unavailable Pod의 phase/reason을 확인한다.
2. image pull, scheduling, readiness, Secret/Config 누락을 구분한다.
3. 최근 values/image 변경과 node capacity를 확인한다.
4. 안전한 이전 revision이 있으면 서비스 배포 절차에 따라 rollback한다.
5. desired와 available replica가 같고 새 Pod가 안정적으로 Ready인지 확인한다.

## DropMongPodOOMKilled

의미: 컨테이너가 memory limit을 넘어 종료됐다.

1. 해당 Pod/container의 memory working set, limit, restart 시점을 확인한다.
2. traffic/배치/Kafka 처리량 증가와 배포 version을 대조한다.
3. profile 또는 heap 자료가 수집돼 있으면 민감정보 없이 증가 지점을 확인한다.
4. 단순 limit 상향 전에 leak, unbounded queue/cache, batch 크기를 점검한다.
5. 수정 뒤 restart 증가가 멈추고 memory가 안정 범위인지 확인한다.

## DropMongContainerCpuThrottlingHigh

의미: 5분 CPU period 중 throttled 비율이 25%를 15분간 넘었다.

1. container CPU usage/request/limit과 Pod replica를 확인한다.
2. Traffic, p99, active requests와 같은 시간대인지 확인한다.
3. HPA가 scale-out하지 못한 이유와 node CPU 여유를 확인한다.
4. CPU profile이 있으면 hot path를 확인한 뒤 code, replica, limit 중 근거 있는 조치를 선택한다.
5. throttling과 p99가 함께 회복됐는지 확인한다.

## DropMongNodeMemoryPressure

의미: Kubernetes Node가 MemoryPressure를 10분간 보고했다.

1. 영향 node의 allocatable/request/working set과 eviction event를 확인한다.
2. memory 상위 Pod를 식별하되 Secret/env 원문은 출력하지 않는다.
3. OOMKilled, pending Pod, observability backend queue/PVC 상태를 함께 확인한다.
4. workload 이동, replica 조정, node 증설 또는 leak 수정 중 영향이 가장 작은 조치를 선택한다.
5. Node condition이 해제되고 eviction/restart가 멈췄는지 확인한다.
