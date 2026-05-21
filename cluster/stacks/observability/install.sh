#!/usr/bin/env bash
set -euo pipefail

OBSERVABILITY_NAMESPACE="${OBSERVABILITY_NAMESPACE:-observability}"
KUBE_PROMETHEUS_STACK_RELEASE="${KUBE_PROMETHEUS_STACK_RELEASE:-kube-prometheus-stack}"
KUBE_PROMETHEUS_STACK_CHART="${KUBE_PROMETHEUS_STACK_CHART:-kube-prometheus-stack}"
KUBE_PROMETHEUS_STACK_REPO="${KUBE_PROMETHEUS_STACK_REPO:-https://prometheus-community.github.io/helm-charts}"
LOKI_RELEASE="${LOKI_RELEASE:-loki}"
LOKI_CHART="${LOKI_CHART:-loki}"
LOKI_REPO="${LOKI_REPO:-https://grafana.github.io/helm-charts}"
ALLOY_RELEASE="${ALLOY_RELEASE:-alloy}"
ALLOY_CHART="${ALLOY_CHART:-alloy}"
ALLOY_REPO="${ALLOY_REPO:-https://grafana.github.io/helm-charts}"
TEMPO_RELEASE="${TEMPO_RELEASE:-tempo}"
TEMPO_CHART="${TEMPO_CHART:-tempo}"
TEMPO_REPO="${TEMPO_REPO:-https://grafana.github.io/helm-charts}"

helm_flags=()
if [ -n "${HELM_FLAGS:-}" ]; then
  read -r -a helm_flags <<< "${HELM_FLAGS}"
fi

helm_upgrade() {
  local release="$1"
  local chart="$2"
  local repo="$3"
  local values_file="$4"

  for attempt in 1 2 3; do
    if helm upgrade --install "${helm_flags[@]}" "${release}" "${chart}" \
      --repo "${repo}" \
      --namespace "${OBSERVABILITY_NAMESPACE}" \
      -f "${values_file}"; then
      return 0
    fi

    if [ "${attempt}" -eq 3 ]; then
      return 1
    fi

    sleep "$((attempt * 10))"
  done
}

apply_grafana_dashboards() {
  if [ ! -d dashboards ] || ! find dashboards -type f -name '*.json' | grep -q .; then
    return 0
  fi

  kubectl -n "${OBSERVABILITY_NAMESPACE}" create configmap cloudnative-grafana-dashboards \
    --from-file=dashboards \
    --dry-run=client \
    -o yaml \
    | kubectl label --local -f - \
      grafana_dashboard=1 \
      app.kubernetes.io/name=grafana-dashboard \
      app.kubernetes.io/part-of=medical-platform \
      -o yaml \
    | kubectl apply -f -
}

kubectl apply -f manifests/namespace.yaml
kubectl apply -f manifests/local-pv.yaml
apply_grafana_dashboards

helm_upgrade "${KUBE_PROMETHEUS_STACK_RELEASE}" "${KUBE_PROMETHEUS_STACK_CHART}" "${KUBE_PROMETHEUS_STACK_REPO}" values/kube-prometheus-stack.yaml
helm_upgrade "${LOKI_RELEASE}" "${LOKI_CHART}" "${LOKI_REPO}" values/loki.yaml
helm_upgrade "${ALLOY_RELEASE}" "${ALLOY_CHART}" "${ALLOY_REPO}" values/alloy.yaml
helm_upgrade "${TEMPO_RELEASE}" "${TEMPO_CHART}" "${TEMPO_REPO}" values/tempo.yaml
