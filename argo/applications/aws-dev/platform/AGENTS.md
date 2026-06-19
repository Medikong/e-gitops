# AGENTS.md

이 디렉터리의 `loadtest.yaml`은 aws-dev Argo CD Application entrypoint다.

## Loadtest rollback

- 실행 트리거는 `platform/loadtest/values/runs/aws-dev/*.yaml`의 `manualRuns.read` 값으로 관리한다.
- 실험 후 되돌릴 때는 run 파일을 `enabled: false`, `runId: ""`로 되돌린다.
- 같은 실험을 다시 실행할 때는 `enabled: true`로 켜고 `runId`만 새 값으로 바꾼다.
- `loadtest.yaml`의 preset valueFile을 제거하면 다음 sync부터 해당 preset 조건도 빠진다.
