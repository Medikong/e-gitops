# Service Bottleneck Ramp Load Test

이 scenario는 replica 1개인 서비스에 `ramping-arrival-rate`를 한 번 실행해 `startRps`부터 `maxRps`까지 RPS를 연속으로 올린다. 목표는 가장 높은 숫자를 억지로 찾는 일이 아니라, 처음 성능이 나빠지는 구간을 정확히 기록하는 일이다.

## 이 scenario가 소유하는 것

- `dropmong-web`을 제외한 8개 backend 서비스의 순서, endpoint mix, 결정론적 주소가 필요한 API 계약
- 서비스별 ramp schedule과 reference RPS 기반 rolling window 판정 의미
- endpoint별 실제 RPS, 오류율, check, p50, p95, p99 원본
- peak·reference·실측 RPS, 연속 저하에 따른 조기 종료 이유
- 필요한 관측성 metric specification과 `result.json` 형식

`execute.js`는 RUN·scenario·preset·dataset·environment 참조를 읽고 계약을 검증한다. `runner.js`는 이 scenario의 Dataset 한 번 준비, ramp k6 실행, window 감시를 수행한다. `window.js`는 k6 point를 최근 window 단위로 판단한다. `report.js`는 이 scenario의 raw k6 결과와 observability snapshot을 최종 보고서로 합친다.

공통 실행기는 Job을 만들고 기다리며 artifact를 전달하고 replica를 적용·원복한다. endpoint별 판정, rolling window, 결과 필드는 공통 실행기의 책임이 아니다.

## preset과 RUN

scenario는 “어떤 API를 어떻게 판정할지”를 갖고, preset은 “얼마나 약하고 짧게 실행할지”를 갖는다. 예를 들어 `values/presets/service-bottleneck-ramp-load-test/local-smoke-1day-low-rps.yaml`은 1~4 RPS, 짧은 duration, 5초 window를 지정한다.

RUN은 이를 실제 dataset·environment와 함께 고른다.

```yaml
run:
  scenario: ../scenarios/service-bottleneck-ramp-load-test.yaml
  preset: ../presets/service-bottleneck-ramp-load-test/local-smoke-1day-low-rps.yaml
  dataset: ../datasets/smoke-1day.yaml
  environment: ../environments/local.yaml
  deployment: { replicas: 1 }
```

`local-baseline-90days-ramp-replicas-1`은 `baseline-90days`와 `baseline-90days-replicas-1` preset을 쓴다. `local-bottleneck-ramp-replicas-1`은 같은 조합을 유지하는 호환 RUN이다. 두 RUN 모두 preset을 명시한다.

## rolling window와 조기 종료

k6는 누적 평균 대신 최근 window의 표본만 제공한다. `target_rps`는 합격선이 아니라 계속 올라가는 실험 기준점이다. 첫 정상 window의 실제 RPS를 reference로 삼고, 이후 목표는 증가하는데 실제 RPS가 직전 정상 reference를 넘지 못하면 저하로 기록한다. HTTP 오류, check 실패, dropped iteration도 저하다. p50/p95/p99는 reference와의 차이를 기록하지만 고정 SLO로 중단하지 않는다. 충분한 표본을 가진 저하 window가 RUN이 정한 횟수만큼 연속되면 k6에 중단 신호를 보낸다.

예를 들어 실제 처리량이 20 RPS까지 올라간 뒤 목표가 35, 45 RPS로 계속 증가해도 실제가 20 RPS에 머문 window가 두 번 연속이면 멈춘다. 첫 번째 저하 뒤 정상적으로 다시 증가하면 연속 횟수는 0으로 돌아가므로 계속 측정한다. 병목을 찾아 조기 종료한 결과는 실험 성공이며, Dataset Job·k6 실행·결과 저장의 실제 실패와 다르다.

서비스마다 Dataset Job은 ramp 시작 전에 한 번만 실행한다. window나 ramp 구간마다 데이터셋을 다시 만들지 않는다. 로컬 snapshot cache는 동일한 dataset 계약을 빠르게 복원할 뿐, 이미지·서비스 배포를 준비하지 않는다.

## 서비스와 결정론적 주소 경계

이미 배포된 dev Helm release가 서비스 이미지, 환경 변수, Secret, migration, 기본 설정을 소유한다. 이 scenario는 layered values로 replica만 일시 override하고, 끝나면 같은 values를 replica override 없이 다시 적용한다.

Dataset Job과 k6는 profile·seed에서 같은 데이터 ID를 계산한다. 인증 token은 k6 `setup()`에서 정상 Auth 로그인으로 발급해 메모리에만 둔다. 비밀번호, token, cookie, Authorization 값, coupon 값은 artifact나 Secret으로 전달하지 않는다. 직접 DB Dataset 입력 참조가 빠진 서비스는 민감한 값 없이 `configuration` 실패로 남긴다.

## 관측성과 결과

별도 resource collector Job이나 반복 polling은 없다. k6 종료 후 한 번만 GitOps 관측성 원본을 읽기 전용으로 조회한다. 어떤 metric을 조회하고 어떤 의미로 보관할지는 scenario의 metric specification이 정한다.

관측성 조회 실패는 `null`과 `unavailable` 및 정제된 이유로 남긴다. HTTP k6 결과가 성공했다면 그 사실만으로 ramp 판정을 실패로 바꾸지 않는다.

`result.json`에는 endpoint별 HTTP 결과와 서비스/Pod 단위 관측성 결과를 따로 둔다.

```json
{
  "apis": {
    "GET /drops": { "actual_rps": 3.2, "p95_ms": 40, "error_rate": 0 }
  },
  "observability": {
    "service": { "cpu_utilization": 28.7, "memory_utilization": null, "pod_restarts": 0 },
    "status": "unavailable"
  }
}
```

위 예에서 `memory_utilization: null`은 메모리가 0이라는 뜻이 아니라 수집할 수 없었다는 뜻이다. CPU나 Pod 재시작은 API 하나에 정확히 귀속하지 않는다.

## 저부하 smoke 실행 조건

`local-smoke-1day-ramp-replicas-1`은 1일 데이터와 낮은 RPS로 모든 서비스를 순차 실행하는 구조 검증용 RUN이다. Kubernetes Dataset Job과 k6 Job, replica 적용·원복이 필요하므로 Docker만으로 전체 smoke를 완료할 수 없다. Kubernetes 변경이 금지된 환경에서는 이 RUN을 실행하지 않는다.
