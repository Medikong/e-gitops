# Istio security scenarios

This directory stores Istio security policy candidates that are intentionally
kept outside the default `platform/istio` kustomization.

Kong is currently the external API gateway and is not part of the Istio mesh.
Applying `PeerAuthentication` `STRICT` directly to Kong-routed backend app ports
can break external API traffic because non-mesh Kong clients cannot present
Istio mTLS.

Use the manifests here only for controlled mesh-internal validation, or after
one of these traffic-path changes is in place:

- Kong participates in the mesh with an Envoy sidecar.
- External traffic enters through an Istio ingress gateway path.
- Backend app ports that must accept Kong traffic are explicitly separated from
  mesh-internal ports.

Default GitOps state remains non-STRICT until the ingress path decision is made.
