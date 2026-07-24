# Metrics Server selector migration

The aws-dev cluster has a legacy Deployment selector, while chart 3.13.1 uses the app.kubernetes.io selector pair. The repair is a bounded two-phase GitOps migration.

## Phase 1: enable, sync, verify

In one temporary Git change, add this value file to the metrics-server chart source in `argo/applications/aws-dev/platform/metrics-server.yaml`:

```yaml
- $values/platform/metrics-server/values/aws-dev-selector-migration.yaml
```

The overlay is intentionally not part of the steady-state Application. Validate the phase-one shape and render it:

```powershell
task --taskfile platform/metrics-server/Taskfile.yml migration:enable:render
```

After an approved Argo sync, run the executable read-only verification gate:

```powershell
task --taskfile platform/metrics-server/Taskfile.yml migration:verify
```

The gate checks Argo `Synced/Healthy`, APIService availability, a ready EndpointSlice address on named port `https`, chart selector labels on the Deployment, and a `NodeMetricsList` response from the metrics API.

## Phase 2: cleanup gate

After phase-one verification, remove the temporary value-file line in a follow-up Git change. The cleanup validator is required and rejects both a lingering force/replace annotation in ordinary aws-dev values and a lingering migration value-file reference:

```powershell
task --taskfile platform/metrics-server/Taskfile.yml migration:cleanup:validate
```

`task ... render` runs this cleanup gate before ordinary renders, so steady-state validation cannot pass while the one-time replacement control remains enabled. An unsuccessful phase-one sync must be rolled back by removing the temporary value-file line and rerunning the cleanup gate; do not mutate the Deployment with kubectl.

The migration overlay remains as the explicit phase-one input and is not referenced by the steady-state Argo Application.
