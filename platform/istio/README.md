# Istio Platform Layer

This layer bootstraps the minimum service mesh control-plane resources used by
the Medikong GitOps workflow.

## Scope

Included:

- `istio-system` namespace
- Istio CRDs through the official `istio/base` Helm chart
- Istio control plane through the official `istiod` Helm chart
- Kiali server through the official `kiali-server` Helm chart

Excluded for the first rollout:

- `istio-ingressgateway`
- namespace-wide mTLS `STRICT`
- AuthorizationPolicy
- global sidecar injection

Kong remains the external API Gateway. Istio starts as the internal service
mesh for service-to-service traffic.

## Apply order

The resources are ordered with Argo CD sync waves:

1. `istio-base` (`-20`)
2. `istiod` (`-10`)
3. `kiali` (`0`)

This follows the official Istio Helm installation order: install `base` first,
then `istiod`.

## Local validation

After sync, verify:

```bash
kubectl get ns istio-system
kubectl get pods -n istio-system
kubectl get crd virtualservices.networking.istio.io
kubectl get svc -n istio-system kiali
```

Then follow `sidecar-injection/README.md` before enabling sidecar injection for
application workloads.

## First workload verification

`concert-service` is the first workload-level sidecar opt-in target. Its values
file sets:

```yaml
deployment:
  podAnnotations:
    sidecar.istio.io/inject: "true"
```

The annotation only affects newly created Pods. If `concert-service` was already
running before `istiod` became ready, restart the workload after the Istio
control plane is healthy:

```bash
kubectl rollout restart deployment/concert-service -n ticketing-concert
kubectl rollout status deployment/concert-service -n ticketing-concert --timeout=180s
kubectl get pods -n ticketing-concert
```

Expected result:

```text
concert-service-...   2/2   Running
```

Keep this first rollout limited to `concert-service`. Do not enable namespace
wide injection until Kong-routed concert API smoke tests still pass.

## Kiali access

Kiali is intentionally not exposed through Kong or a public LoadBalancer during
the first rollout.

Use port-forwarding:

```bash
kubectl port-forward -n istio-system svc/kiali 20001:20001
```

Then open:

```text
http://localhost:20001
```

## Prometheus dependency

Kiali is configured to read Prometheus from:

```text
http://kube-prometheus-stack-prometheus.monitoring:9090
```

If the monitoring stack uses a different service name, update
`argocd/kiali.yaml`.

Mesh metric collection is owned by the monitoring platform layer, not this
Istio bootstrap layer. The first rollout adds PodMonitors in:

```text
platform/monitoring/manifests/istio-mesh-podmonitors.yaml
```

Initial scrape scope:

- `istiod` metrics from `istio-system`
- `concert-service` Envoy sidecar metrics from `ticketing-concert`

This keeps the first mesh monitoring rollout aligned with the first sidecar
target. Expand the PodMonitor selector only after additional service namespaces
are opted into sidecar injection.

## Reservation canary routing

`reservation-service` is the first canary routing target. The default GitOps
state keeps traffic stable:

```text
reservation-service -> subset v1 100%
```

The stable policy is included in:

```text
platform/istio/traffic/reservation
```

The canary scenario manifests are stored but not included in the default
`platform/istio` kustomization:

```text
platform/istio/traffic/reservation/scenarios/canary-20
platform/istio/traffic/reservation/scenarios/canary-50
platform/istio/traffic/reservation/scenarios/canary-100
platform/istio/traffic/reservation/scenarios/rollback
```

The scenarios render only the `VirtualService` for each traffic weight. The
base `DestinationRule` remains in `platform/istio/traffic/reservation` and must
exist before applying a scenario.

The subsets are based on Pod labels:

```text
version=v1 -> stable reservation-service Deployment
version=v2 -> optional reservation-service-v2 canary Deployment
```

The shared service chart supports the v2 workload through `canary.enabled`.
Keep it disabled in normal stable state. Enable it only for a canary rollout or
a dedicated validation branch.

The v2 workload scenario values are stored in:

```text
values/scenarios/istio/reservation-canary-v2.yaml
```

Render validation:

```bash
task canary:render
```

Runtime validation:

```bash
task canary:check
```

The VirtualService uses the `mesh` gateway. If Kong remains outside the mesh,
weight-based routing is verified from mesh-internal clients first. To route
external Kong traffic through the same Istio weights, Kong must participate in
the mesh or forward through an Istio gateway path.
