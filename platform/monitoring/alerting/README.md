# Alert notification Secret contract

Alertmanager는 cluster 내부 `alertmanager-discord` adapter로만 전송한다. 외부 알림 endpoint는 adapter의 `DISCORD_WEBHOOK` 환경 변수로 주입하며 Git에 원문을 저장하지 않는다.

## Secret 계약

```text
namespace: monitoring
Secret name: alertmanager-discord-webhook
Secret key: webhook-url
consumer: Deployment/alertmanager-discord
env: DISCORD_WEBHOOK
```

`kube-prometheus-stack.yaml`과 `kube-prometheus-stack-private-dev.yaml`은 모두 `secretKeyRef`만 추적한다. `optional: false`이므로 Secret이 없으면 adapter가 불완전한 설정으로 조용히 실행되지 않고 Pod 생성 단계에서 드러난다.

Secret 값은 승인된 cluster bootstrap/secret manager 경로로 환경별 생성한다. 이 저장소에는 평문 Secret, 임시 placeholder, `encryptedData`를 임의로 추가하지 않는다. 검증할 때도 Secret 값, Pod env, webhook 응답 body를 출력하지 않는다.

## 기존 endpoint 조치

이전에 추적된 평문 webhook은 노출된 자격 증명으로 간주한다.

1. 외부 Discord 관리 화면에서 기존 webhook을 폐기한다.
2. 새 webhook을 재발급한다.
3. 환경별 Secret manager에서 `monitoring/alertmanager-discord-webhook`의 `webhook-url`을 갱신한다.
4. adapter Pod를 재시작하고 Secret 값이 아닌 Pod 준비 상태와 Alertmanager 내부 delivery 상태만 확인한다.

기존 endpoint와 새 endpoint 모두 `curl`이나 테스트 메시지로 이 작업에서 호출하지 않는다. 폐기·재발급은 저장소 수정만으로 완료되지 않는 외부 운영 작업이다.
