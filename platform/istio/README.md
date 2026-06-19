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
  podLabels:
    sidecar.istio.io/inject: "true"
  podAnnotations:
    sidecar.istio.io/inject: "true"
    sidecar.istio.io/proxyCPU: 25m
    sidecar.istio.io/proxyMemory: 64Mi
    sidecar.istio.io/proxyCPULimit: 200m
    sidecar.istio.io/proxyMemoryLimit: 256Mi
```

Istio's mutating webhook uses Kubernetes labels for object selector matching,
so the workload-level opt-in requires the Pod template label. The annotation is
kept as an explicit injection intent after the webhook is invoked. These fields
only affect newly created Pods. If `concert-service` was already running before
`istiod` became ready, restart the workload after the Istio control plane is
healthy:

The proxy resource annotations are intentionally low for the AWS dev cluster.
They prevent rollout stalls caused by Istio's default proxy CPU request in a
small test cluster. Production values must be recalculated from observed Envoy
CPU and memory metrics.

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

## Backend sidecar rollout

After the first `concert-service` and `reservation-service` mesh rollout, the
next backend services opted into workload-level sidecar injection are:

```text
payment-service
ticket-service
notification-service
```

Their service values set:

```yaml
deployment:
  podLabels:
    sidecar.istio.io/inject: "true"
  podAnnotations:
    sidecar.istio.io/inject: "true"
    sidecar.istio.io/proxyCPU: 25m
    sidecar.istio.io/proxyMemory: 64Mi
    sidecar.istio.io/proxyCPULimit: 200m
    sidecar.istio.io/proxyMemoryLimit: 256Mi
```

Excluded for this rollout:

```text
auth-service
dashboard
```

`auth-service` is the JWT issuing and authentication boundary, so keep it out
of this rollout until Kong JWT smoke tests and the other backend sidecar checks
are stable. `dashboard` is a frontend workload and is not required for the
first internal service mesh traffic validation.

Render validation:

```bash
task sidecar:render
```

Runtime validation:

```bash
task sidecar:check
```

Expected Pod readiness after the application dependencies are available:

```text
payment-service-...        2/2 Running
ticket-service-...         2/2 Running
notification-service-...   2/2 Running
```

The Pod count does not increase. Each existing Pod gets an additional
`istio-proxy` container.

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

It is applied by a separate Argo CD Application:

```text
argo/applications/aws-dev/platform/istio-traffic-reservation.yaml
```

Do not include the traffic policy directly in `platform/istio/kustomization.yaml`.
The traffic policy depends on Istio CRDs, so it must sync after `istio-base`
has installed `VirtualService` and `DestinationRule` CRDs.

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

## Reservation circuit breaker

`reservation-service` is also the first circuit breaker target because it
already has a `DestinationRule` and `VirtualService`.

Default policy:

```text
connectionPool.tcp.maxConnections = 100
connectionPool.http.http1MaxPendingRequests = 100
connectionPool.http.maxRequestsPerConnection = 50
outlierDetection.consecutive5xxErrors = 5
outlierDetection.interval = 10s
outlierDetection.baseEjectionTime = 30s
outlierDetection.maxEjectionPercent = 50
```

Stable route policy:

```text
timeout = 2s
retries.attempts = 2
retries.perTryTimeout = 1s
retries.retryOn = 5xx,connect-failure,refused-stream
```

Fault injection scenarios are stored but not included in the default GitOps
state:

```text
platform/istio/traffic/reservation/scenarios/fault-5xx
platform/istio/traffic/reservation/scenarios/fault-delay
```

Render validation:

```bash
task circuit-breaker:render
```

Runtime validation:

```bash
task circuit-breaker:check
```

## Notification failure isolation policy

`notification-service` keeps a default `DestinationRule` in GitOps so failure
isolation does not depend on a manual runtime patch. This policy is intentionally
lighter than the reservation policy because notification is an asynchronous
side-effect service and should not consume the same connection budget as core
reservation traffic.

Default policy:

```text
connectionPool.tcp.maxConnections = 50
connectionPool.http.http1MaxPendingRequests = 50
connectionPool.http.maxRequestsPerConnection = 20
outlierDetection.consecutive5xxErrors = 3
outlierDetection.interval = 10s
outlierDetection.baseEjectionTime = 30s
outlierDetection.maxEjectionPercent = 50
```

GitOps path:

```text
platform/istio/traffic/notification
```

Only the stable `DestinationRule` is included in the default GitOps state.
Fault injection resources that force `notification-service` to return HTTP 503
must remain test-only resources and should be applied only during validation.

The runtime ejection check requires at least two healthy `reservation-service`
endpoints with Envoy sidecars. If the application pods are failing because DB or
Kafka is unavailable, keep this as a manifest-level implementation until the
application layer is restored.
