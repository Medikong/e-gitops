# AWS dev Chaos Mesh: one bounded network-delay round

This directory prepares, but does not automatically install or arm, Chaos Mesh
for one test-only path:

`one named istio-ingressgateway Pod -> one named order-service v1 Pod`

The fault is a `500ms` delay with `50ms` jitter for `30s`. The manifest does not
contain DNS, node, storage, DB, Kafka, external target, service, percentage, or
schedule selectors. Both Argo CD Applications are manual-sync only.

## Non-negotiable permission constraint

Do not sync `chaos-mesh-aws-dev` until the AWS dev platform owner explicitly
accepts this constraint:

- the source Pod is in `istio-system` and the destination Pod is in
  `dropmong-order`;
- Chaos Mesh 2.8.3 namespace-scoped mode supports one `targetNamespace` and
  rejects a selector for another namespace;
- therefore this cross-namespace experiment requires `clusterScoped: true`;
- the upstream 2.8.3 Helm chart then binds its controller target role
  cluster-wide. That role includes broad Pod/ConfigMap/Secret mutation and all
  verbs on all `chaos-mesh.org` resources. Its cluster-level role also reads
  nodes, PVs, PVCs, namespaces, and Services;
- Kubernetes RBAC cannot constrain the controller's required cluster-wide
  Pod `list`/`watch` operations to these two Pod names or labels.

`enableFilterNamespace: true` and the two GitOps-managed namespace annotations
bound *fault injection* to `istio-system` and `dropmong-order`; they do not
narrow the controller's API permissions. Exact selectors bound this committed
experiment, but anyone allowed to create another Chaos Mesh CR could still use
the controller's broader authority.

Smallest safe alternative if that authority is unacceptable: do not sync the
platform Application. Run the same experiment only in a disposable cluster
where the gateway and Order target share one isolated namespace, then use
Chaos Mesh namespace-scoped mode there. The current split namespace topology
cannot satisfy both the requested cross-namespace path and namespace-scoped
controller permissions. Istio service fault injection is not equivalent
because it cannot pin a dynamically named backend Pod after service load
balancing.

## Pinned/minimal platform contract

- Helm chart and application version: `2.8.3`.
- Runtime assumption: Linux worker nodes using containerd at
  `/run/containerd/containerd.sock`.
- Controller: one replica, leader election off for dev, admission webhook
  registration limited to NetworkChaos.
- Daemon: mTLS on and chart `privileged: false`; the reduced mode still needs
  host PID, the containerd socket and `/sys` host mounts, and elevated
  capabilities including `NET_ADMIN`, `NET_RAW`, `SYS_ADMIN`, and `SYS_PTRACE`.
  The `chaos-mesh` namespace therefore uses the privileged Pod Security level.
- Disabled: Dashboard, DNS server/DNSChaos helper, bundled Prometheus,
  BPF kernel helper, debugger, profiling, and daemon metric annotations.
- Chart-wide RBAC rendering is disabled because the pinned chart otherwise
  creates Dashboard principals even when the Dashboard workload is disabled.
  `controller-rbac/` supplies only the pinned controller ServiceAccount,
  Roles, and bindings; the chart continues to supply the daemon
  ServiceAccount.
- Kernel prerequisite: `NET_SCH_NETEM` must be present. Keep controller/daemon
  connectivity healthy until recovery and deletion complete.

The upstream chart installs its CRD bundle even though only NetworkChaos is
admitted here. Inert CRDs are not a permission boundary. The controller bundle
also cannot be safely narrowed with a documented single value because
NetworkChaos depends on internal PodNetworkChaos and common pipeline
controllers; `enabledControllers: ["*"]` is intentionally honest.
The pinned chart's validation-auth webhook retains an upstream wildcard Chaos
API rule while the mutation and ordinary validation webhooks are limited to
NetworkChaos. The custom controller RBAC intentionally matches the pinned
upstream controller rules; diff it against the next chart version before any
upgrade.

## Platform install preflight and sync

Use Argo CD for installation. Do not run `helm install` or apply upstream
manifests with `kubectl`.

First verify the cluster version is supported by Chaos Mesh 2.8 and every
worker reports containerd. Abort if either condition is false or if the socket
path differs on the node image:

```bash
kubectl version -o yaml
kubectl get nodes \
  -o custom-columns='NAME:.metadata.name,OS:.status.nodeInfo.operatingSystem,RUNTIME:.status.nodeInfo.containerRuntimeVersion'
```

Review the exact chart render/RBAC, obtain the platform-owner acceptance, then
perform the one manual platform sync:

```bash
argocd app diff chaos-mesh-aws-dev
argocd app sync chaos-mesh-aws-dev
```

After sync, all commands below must succeed **before any test traffic**:

```bash
kubectl wait --for=condition=Established \
  crd/networkchaos.chaos-mesh.org \
  crd/podnetworkchaos.chaos-mesh.org \
  --timeout=120s
kubectl -n chaos-mesh rollout status deployment/chaos-controller-manager --timeout=120s
kubectl -n chaos-mesh rollout status daemonset/chaos-daemon --timeout=120s
kubectl -n chaos-mesh get pods \
  -l app.kubernetes.io/instance=chaos-mesh \
  -o custom-columns='NAME:.metadata.name,READY:.status.containerStatuses[*].ready,PHASE:.status.phase,NODE:.spec.nodeName'
kubectl get namespace istio-system dropmong-order \
  -o custom-columns='NAME:.metadata.name,CHAOS:.metadata.annotations.chaos-mesh\.org/inject'
kubectl get namespace \
  -o jsonpath='{.items[?(@.metadata.annotations.chaos-mesh\.org/inject=="enabled")].metadata.name}{"\n"}'
test -z "$(kubectl -n chaos-mesh get serviceaccount chaos-dashboard \
  --ignore-not-found -o name)"
test -z "$(kubectl get clusterrole,clusterrolebinding \
  -l app.kubernetes.io/component=chaos-dashboard -o name)"
```

Binary acceptance:

- both CRDs are `Established`;
- the controller Deployment and daemon DaemonSet complete rollout;
- every listed controller/daemon container is Ready and Running;
- the enabled-namespace set is exactly `dropmong-order istio-system`;
- no Dashboard ServiceAccount, ClusterRole, ClusterRoleBinding, workload, or
  Service exists;
- no DNS server, Prometheus, BPF, or debugger workload exists.

If any check fails, do not generate traffic and do not sync the experiment.

## Resolve and arm the two exact Pods

The committed placeholders are an inert safety catch. Resolve exactly one Ready
Pod for each selector:

```bash
mapfile -t INGRESS_PODS < <(
  kubectl -n istio-system get pod \
    -l 'app=istio-ingressgateway,istio=ingressgateway' \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
)
mapfile -t ORDER_PODS < <(
  kubectl -n dropmong-order get pod \
    -l 'app=order-service,app.kubernetes.io/instance=order-aws-dev,app.kubernetes.io/name=order-service,dropmong.io/service=order,dropmong.io/tier=api,version=v1' \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
)
test "${#INGRESS_PODS[@]}" -eq 1
test "${#ORDER_PODS[@]}" -eq 1
kubectl -n istio-system wait --for=condition=Ready "pod/${INGRESS_PODS[0]}" --timeout=60s
kubectl -n dropmong-order wait --for=condition=Ready "pod/${ORDER_PODS[0]}" --timeout=60s
printf 'INGRESS_POD=%s\nORDER_V1_POD=%s\n' "${INGRESS_PODS[0]}" "${ORDER_PODS[0]}"
```

Replace only the two `replace-with-ready-...-pod-name` values in
`network-delay.yaml` with that output. Commit and push the reviewed Git change
through the normal GitOps workflow. Do not use the `pods:` list selector:
Chaos Mesh documents that it ignores other selectors, which would defeat the
required `version: v1` check. `metadata.name` field selection and labels are
ANDed, so the exact name and v1 labels must all match.

Before arming, verify there is no prior fault and inspect Argo's desired
manifest. Both pod names printed by Argo must exactly match the current Ready
Pods:

```bash
test "$(kubectl get networkchaos -A --no-headers 2>/dev/null | wc -l)" -eq 0
test "$(kubectl get podnetworkchaos -A --no-headers 2>/dev/null | wc -l)" -eq 0
argocd app manifests chaos-mesh-order-delay-aws-dev
argocd app diff chaos-mesh-order-delay-aws-dev
```

## Run exactly one 30-second round

The following manual Argo sync is the sole arming action:

```bash
argocd app sync chaos-mesh-order-delay-aws-dev
kubectl -n istio-system wait \
  --for=condition=Selected \
  networkchaos/ingressgateway-to-order-v1-delay \
  --timeout=30s
kubectl -n istio-system wait \
  --for=condition=AllInjected \
  networkchaos/ingressgateway-to-order-v1-delay \
  --timeout=30s
```

Only after `AllInjected=True` may the approved Order ingress QA request run.
The experiment recovers automatically at `30s`:

```bash
kubectl -n istio-system wait \
  --for=condition=AllRecovered \
  networkchaos/ingressgateway-to-order-v1-delay \
  --timeout=90s
```

Do not sync the experiment Application a second time.

## Mandatory cleanup and receipt

Keep controller and daemon healthy while cleanup runs. Never remove finalizers
to force deletion; that can strand traffic-control rules.

```bash
kubectl -n istio-system delete \
  networkchaos/ingressgateway-to-order-v1-delay \
  --wait=true \
  --timeout=90s
kubectl -n istio-system wait \
  --for=delete \
  networkchaos/ingressgateway-to-order-v1-delay \
  --timeout=90s

receipt_dir="artifacts/chaos-mesh"
mkdir -p "$receipt_dir"
receipt="$receipt_dir/$(date -u +%Y%m%dT%H%M%SZ)-cleanup.txt"
{
  date -u
  kubectl get networkchaos -A
  kubectl get podnetworkchaos -A
  kubectl -n chaos-mesh get deployment/chaos-controller-manager daemonset/chaos-daemon
  kubectl -n istio-system get "pod/${INGRESS_PODS[0]}" -o name
  kubectl -n dropmong-order get "pod/${ORDER_PODS[0]}" -o name
} | tee "$receipt"

test "$(kubectl get networkchaos -A --no-headers 2>/dev/null | wc -l)" -eq 0
test "$(kubectl get podnetworkchaos -A --no-headers 2>/dev/null | wc -l)" -eq 0
printf 'CLEANUP_RECEIPT=%s\n' "$receipt"
```

The two empty chaos-resource listings plus healthy controller/daemon and both
surviving Pods are the cleanup receipt. Remove the armed manifest from Git (or
restore the inert placeholders) before any future Argo sync.

## Rollback

Experiment rollback is always the `kubectl delete` sequence above; the manual
Application has no self-heal, so Argo will not recreate the deleted fault.

Platform rollback is allowed only after the cleanup receipt proves that all
Chaos Mesh resources are gone. Then delete the `chaos-mesh-aws-dev` Application
through Argo CD with cascading cleanup. The two namespace resources carry
`Prune=false`, so rollback must not delete `istio-system` or `dropmong-order`.
CRDs are retained by Helm/Argo; remove them only in a separately reviewed
cluster-wide cleanup after confirming no Chaos Mesh CR remains.

## Official contract sources

- [Chaos Mesh 2.8.3 Helm install, runtime socket and health checks](https://chaos-mesh.org/docs/production-installation-using-helm/)
- [NetworkChaos direction, delay/jitter model, netem prerequisite and recovery warning](https://chaos-mesh.org/docs/simulate-network-chaos-on-kubernetes/)
- [Selector AND semantics, exact `metadata.name`, and `pods:` override behavior](https://chaos-mesh.org/docs/define-chaos-experiment-scope/)
- [FilterNamespace annotation boundary](https://chaos-mesh.org/docs/configure-enabled-namespace/)
- [Cleanup-before-uninstall contract](https://chaos-mesh.org/docs/uninstallation/)
- [Chaos Mesh/Kubernetes support matrix](https://chaos-mesh.org/supported-releases/)
- [Pinned 2.8.3 Helm values and privilege/runtime defaults](https://github.com/chaos-mesh/chaos-mesh/blob/v2.8.3/helm/chaos-mesh/values.yaml)
- [Pinned 2.8.3 controller RBAC template](https://github.com/chaos-mesh/chaos-mesh/blob/v2.8.3/helm/chaos-mesh/templates/controller-manager-rbac.yaml)
