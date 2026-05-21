#!/usr/bin/env bash
set -euo pipefail

timeout="${LOCAL_K8S_WAIT_TIMEOUT:-300s}"
targets="${DEPENDENCY_ROLLOUT_TARGETS:-medical-auth:statefulset/auth-db medical-patient:statefulset/patient-db medical-appointment:statefulset/appointment-db medical-prescription:statefulset/prescription-db medical-notification:statefulset/notification-db medical-messaging:statefulset/kafka}"

timeout_seconds() {
  case "$timeout" in
    *s) printf "%s\n" "${timeout%s}" ;;
    *m) printf "%s\n" "$(( ${timeout%m} * 60 ))" ;;
    *) printf "%s\n" "$timeout" ;;
  esac
}

show_diagnostics() {
  local namespace="$1"
  kubectl -n "$namespace" get pods -o wide || true
  kubectl -n "$namespace" get statefulset || true
  kubectl -n "$namespace" get pvc || true
  kubectl -n "$namespace" get events --sort-by=.lastTimestamp | tail -n 60 || true
}

fail_on_blocked_pods() {
  local namespace="$1"
  local blocked
  blocked="$(
    kubectl -n "$namespace" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.initContainerStatuses[*]}{.state.waiting.reason}{" "}{.state.waiting.message}{" "}{end}{range .status.containerStatuses[*]}{.state.waiting.reason}{" "}{.state.waiting.message}{" "}{end}{"\n"}{end}' \
      | awk '/ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|CreateContainerError|CrashLoopBackOff/'
  )"

  if [ -n "$blocked" ]; then
    printf "%s\n" "dependency pod is blocked:"
    printf "%s\n" "$blocked"
    show_diagnostics "$namespace"
    exit 1
  fi
}

wait_for_statefulset() {
  local namespace="$1"
  local resource="$2"
  local deadline ready replicas
  deadline=$(( SECONDS + $(timeout_seconds) ))

  printf "== rollout: %s/%s ==\n" "$namespace" "$resource"

  while [ "$SECONDS" -lt "$deadline" ]; do
    fail_on_blocked_pods "$namespace"

    read -r ready replicas < <(
      kubectl -n "$namespace" get "$resource" -o jsonpath='{.status.readyReplicas}{" "}{.spec.replicas}{"\n"}'
    )
    ready="${ready:-0}"
    replicas="${replicas:-0}"

    if [ "$replicas" != "0" ] && [ "$ready" = "$replicas" ]; then
      printf "%s/%s ready: %s/%s\n" "$namespace" "$resource" "$ready" "$replicas"
      return 0
    fi

    printf "%s/%s waiting: %s/%s ready\n" "$namespace" "$resource" "$ready" "$replicas"
    sleep 5
  done

  printf "%s/%s timed out after %s\n" "$namespace" "$resource" "$timeout"
  show_diagnostics "$namespace"
  return 1
}

for target in $targets; do
  namespace="${target%%:*}"
  resource="${target#*:}"
  kubectl -n "$namespace" get pods -o wide
  wait_for_statefulset "$namespace" "$resource"
done
kubectl get pods -A -o wide
