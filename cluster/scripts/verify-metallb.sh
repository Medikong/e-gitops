#!/usr/bin/env bash
set -euo pipefail

METALLB_NAMESPACE="${METALLB_NAMESPACE:-metallb-system}"
METALLB_IP_POOL_NAME="${METALLB_IP_POOL_NAME:-medikong-pool}"
METALLB_L2_ADVERTISEMENT_NAME="${METALLB_L2_ADVERTISEMENT_NAME:-medikong-l2}"
METALLB_WAIT_TIMEOUT="${METALLB_WAIT_TIMEOUT:-300s}"

kubectl -n "${METALLB_NAMESPACE}" rollout status deployment/controller --timeout="${METALLB_WAIT_TIMEOUT}"
kubectl -n "${METALLB_NAMESPACE}" rollout status daemonset/speaker --timeout="${METALLB_WAIT_TIMEOUT}"
kubectl -n "${METALLB_NAMESPACE}" get ipaddresspool "${METALLB_IP_POOL_NAME}"
kubectl -n "${METALLB_NAMESPACE}" get l2advertisement "${METALLB_L2_ADVERTISEMENT_NAME}"
kubectl -n "${METALLB_NAMESPACE}" get pods -o wide
