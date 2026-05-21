#!/usr/bin/env bash
set -euo pipefail

timeout="${LOCAL_K8S_WAIT_TIMEOUT:-300s}"
targets="${APP_ROLLOUT_TARGETS:-medical-auth:deployment/auth-service medical-patient:deployment/patient-service medical-appointment:deployment/appointment-service medical-prescription:deployment/prescription-service medical-notification:deployment/notification-service medical-dashboard:deployment/dashboard}"

for target in $targets; do
  namespace="${target%%:*}"
  resource="${target#*:}"
  printf "== rollout: %s/%s ==\n" "$namespace" "$resource"
  kubectl -n "$namespace" rollout status "$resource" --timeout="$timeout"
done
