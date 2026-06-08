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
