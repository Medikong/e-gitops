# DropMong namespace 계약

`platform/namespaces`는 로컬과 GitOps 배포가 사용하는 활성 namespace 원본이다. 백엔드 서비스는 `dropmong-<service>`, 공용 data release metadata는 `dropmong-system`, Kafka는 `dropmong-messaging`을 사용한다.

Kubernetes는 manifest 이름을 바꿔도 기존 namespace를 새 이름으로 바꾸지 않는다. 따라서 이 저장소가 DropMong 계약으로 이동한 뒤에도 이전 Helm release나 PVC가 클러스터에 남을 수 있다.

로컬 환경을 이전할 때는 다음 순서를 따른다.

1. `task dev:check`로 클러스터를 변경하지 않고 목표 manifest를 렌더링한다.
2. 이전 system·messaging namespace의 Helm release, StatefulSet, PVC, Kafka 데이터를 확인한다.
3. 이전 data release를 제거하거나 namespace를 삭제하기 전에 데이터를 백업하거나 폐기 여부를 명시적으로 결정한다.
4. `task dev`로 DropMong namespace와 release를 만든다.
5. `dropmong-system`, `dropmong-messaging`, 각 `dropmong-<service>` namespace의 workload를 확인한다.

Namespace를 삭제하면 그 안의 PVC 객체와 stateful resource도 함께 삭제될 수 있으므로 자동 정리 명령은 제공하지 않는다. 정적 렌더링 성공은 실제 데이터 이전 성공을 뜻하지 않는다.
