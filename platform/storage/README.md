# Storage platform resources

`platform/storage`는 서비스 Helm release보다 먼저 필요한 cluster-level storage 전제를 관리한다.

## private-dev

private-dev는 6개 실습 노드 안에서 반복 재구성이 쉬운 구성을 우선하므로 Longhorn 대신 local-path provisioner를 사용한다. 이 경로에서 관리하는 StorageClass는 `medikong-local-path`이며, 데이터/관측성 PVC는 이 이름을 명시해 클러스터 default StorageClass에 의존하지 않는다.

local-path provisioner는 `argo/applications/private-dev/platform/storageclass-local-path.yaml`의 `storageclass-private-dev` Application이 먼저 배포한다. 동적 PV는 선택된 노드의 `/var/lib/medikong/local-path` 아래에 생성되고, StorageClass는 `WaitForFirstConsumer`를 사용해 Pod의 `nodeSelector`와 같은 노드에 바인딩되도록 둔다.

### private-dev 전환 절차

기존 `medikong-longhorn` PVC는 StorageClass 이름만 바꿔서 제자리 전환할 수 없다. private-dev는 데이터 보존을 목표로 두지 않는 실습 환경이므로, 전환 시 기존 StatefulSet/Deployment와 PVC를 명시적으로 삭제한 뒤 Argo CD가 local-path 기준 리소스를 다시 만들게 한다.

삭제는 운영 데이터를 지우는 작업이므로 자동화하지 않는다. 실행자가 전환을 승인한 뒤 다음 순서로 진행한다. Argo CD UI를 사용해도 되고, CLI가 준비되어 있으면 `argocd app sync <app-name>`으로 같은 작업을 수행한다.

`medikong-private-dev-apps`는 자동 sync/prune가 켜진 app-of-apps다. 이 변경분을 push하면 `longhorn-helm-private-dev` Application prune가 바로 시작될 수 있으므로, 승인된 private-dev reset 창에서만 push/sync한다. 아래 순서는 기존 Longhorn PVC 데이터를 보존하지 않는 reset 절차다.

```bash
argocd app sync medikong-private-dev-apps --prune
argocd app sync storageclass-private-dev
argocd app sync data-private-dev
argocd app sync auth-private-dev
argocd app sync concert-private-dev
argocd app sync notification-private-dev
argocd app sync payment-private-dev
argocd app sync reservation-private-dev
argocd app sync ticket-private-dev
argocd app sync dashboard-private-dev
argocd app sync monitoring-private-dev
argocd app sync loki-private-dev
argocd app sync tempo-private-dev
argocd app sync opentelemetry-collector-private-dev

kubectl delete statefulset --ignore-not-found -n ticketing-auth auth-db
kubectl delete statefulset --ignore-not-found -n ticketing-concert concert-db
kubectl delete statefulset --ignore-not-found -n ticketing-reservation reservation-db
kubectl delete statefulset --ignore-not-found -n ticketing-payment payment-db
kubectl delete statefulset --ignore-not-found -n ticketing-ticket ticket-db
kubectl delete statefulset --ignore-not-found -n ticketing-notification notification-db
kubectl delete statefulset --ignore-not-found -n ticketing-messaging kafka
kubectl delete deployment --ignore-not-found -n ticketing-payment pgadmin
kubectl delete job --ignore-not-found -n ticketing-messaging kafka-create-topics
kubectl delete deployment --ignore-not-found -n monitoring kube-prometheus-stack-grafana
kubectl delete statefulset --ignore-not-found -n monitoring prometheus-kube-prometheus-stack-prometheus
kubectl delete statefulset --ignore-not-found -n observability loki tempo

kubectl delete pvc --ignore-not-found -n ticketing-auth data-auth-db-0
kubectl delete pvc --ignore-not-found -n ticketing-concert data-concert-db-0
kubectl delete pvc --ignore-not-found -n ticketing-reservation data-reservation-db-0
kubectl delete pvc --ignore-not-found -n ticketing-payment data-payment-db-0 pgadmin-data
kubectl delete pvc --ignore-not-found -n ticketing-ticket data-ticket-db-0
kubectl delete pvc --ignore-not-found -n ticketing-notification data-notification-db-0
kubectl delete pvc --ignore-not-found -n ticketing-messaging data-kafka-0
kubectl delete pvc --ignore-not-found -n monitoring kube-prometheus-stack-grafana prometheus-kube-prometheus-stack-prometheus-db-prometheus-kube-prometheus-stack-prometheus-0
kubectl delete pvc --ignore-not-found -n observability storage-loki-0 storage-tempo-0

argocd app sync data-private-dev
argocd app sync auth-private-dev
argocd app sync concert-private-dev
argocd app sync notification-private-dev
argocd app sync payment-private-dev
argocd app sync reservation-private-dev
argocd app sync ticket-private-dev
argocd app sync dashboard-private-dev
argocd app sync monitoring-private-dev
argocd app sync loki-private-dev
argocd app sync tempo-private-dev
argocd app sync opentelemetry-collector-private-dev
```

`longhorn-helm-private-dev` live Application에는 cleanup finalizer가 있으므로 Application prune 시 하위 Longhorn 리소스 정리도 함께 진행된다. 삭제 승인 없이 이 단계만 먼저 실행하지 않는다.

전환 후 다음 조건을 확인한다.

```bash
kubectl get sc,pvc -A
kubectl get pods -A -o wide
```

- 신규 PVC는 `medikong-local-path`를 사용한다.
- DB/Kafka/pgAdmin Pod는 `medikong.io/workload=data` 라벨이 있는 node5에 배치된다.
- 앱 서비스 Pod는 node3 또는 node4에 배치된다.
- 관측성 핵심 Pod는 node6에 배치된다.
- Prometheus node-exporter는 노드별 메트릭 수집용 DaemonSet이므로 전체 노드에 유지된다.
- OpenTelemetry Collector는 filelog 수집용 DaemonSet이므로 전체 worker 노드에 유지된다.
- Kong은 node2에 유지된다.

## aws-dev

aws-dev의 관측성 저장소는 AWS EBS CSI driver가 제공하는 동적 PVC를 사용한다. 이 경로에서 관리하는 StorageClass는 `medikong-aws-gp3`이며, Loki/Tempo/Grafana/Prometheus values는 이 이름을 명시해 클러스터 default StorageClass에 의존하지 않는다.

EBS CSI driver 자체는 `argo/applications/aws-dev/platform/aws-ebs-csi-driver.yaml`의 Helm Application이 먼저 배포한다. Helm chart의 기본 StorageClass 생성은 끄고, `platform/storage/storageclass-aws-gp3.yaml`이 StorageClass를 소유한다.

정적 `hostPath` PV는 aws-dev 운영 경로에서 사용하지 않는다. `cluster/stacks/observability`의 local PV 설정은 reference 경로이며, 현재 GitOps 운영 판단 기준은 `platform/storage`, `platform/observability/<component>`, `platform/monitoring`이다.

## 전제

`medikong-aws-gp3` StorageClass는 EBS CSI provisioner(`ebs.csi.aws.com`)를 호출한다. Terraform/EC2 노드에는 EBS CSI driver가 EBS volume을 만들 수 있는 IAM 권한과 IMDS 접근 조건이 먼저 준비되어 있어야 한다.

StorageClass 정책은 다음 기준을 따른다.

```text
provisioner: ebs.csi.aws.com
volume type: gp3
binding: WaitForFirstConsumer
reclaim: Retain
expansion: enabled
encryption: enabled
```
