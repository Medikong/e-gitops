#!/usr/bin/env bash
set -euo pipefail

METALLB_VERSION="${METALLB_VERSION:-v0.15.3}"
METALLB_NAMESPACE="${METALLB_NAMESPACE:-metallb-system}"
METALLB_IP_POOL_NAME="${METALLB_IP_POOL_NAME:-medikong-pool}"
METALLB_L2_ADVERTISEMENT_NAME="${METALLB_L2_ADVERTISEMENT_NAME:-medikong-l2}"
METALLB_IP_RANGE="${METALLB_IP_RANGE:-10.10.10.240-10.10.10.250}"
METALLB_WAIT_TIMEOUT="${METALLB_WAIT_TIMEOUT:-300s}"

manifest_url="https://raw.githubusercontent.com/metallb/metallb/${METALLB_VERSION}/config/manifests/metallb-native.yaml"

kubectl apply -f "${manifest_url}"
kubectl -n "${METALLB_NAMESPACE}" rollout status deployment/controller --timeout="${METALLB_WAIT_TIMEOUT}"
kubectl -n "${METALLB_NAMESPACE}" rollout status daemonset/speaker --timeout="${METALLB_WAIT_TIMEOUT}"

cat <<YAML | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: ${METALLB_IP_POOL_NAME}
  namespace: ${METALLB_NAMESPACE}
spec:
  addresses:
    - ${METALLB_IP_RANGE}
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: ${METALLB_L2_ADVERTISEMENT_NAME}
  namespace: ${METALLB_NAMESPACE}
spec:
  ipAddressPools:
    - ${METALLB_IP_POOL_NAME}
YAML

kubectl -n "${METALLB_NAMESPACE}" get pods -o wide
kubectl -n "${METALLB_NAMESPACE}" get ipaddresspool,l2advertisement
