#!/usr/bin/env bash
set -euo pipefail

timeout="${LOCAL_K8S_WAIT_TIMEOUT:-300s}"
targets="${APP_ROLLOUT_TARGETS:-ticketing-auth:deployment/auth-service ticketing-concert:deployment/concert-service ticketing-reservation:deployment/reservation-service ticketing-payment:deployment/payment-service ticketing-ticket:deployment/ticket-service ticketing-notification:deployment/notification-service ticketing-dashboard:deployment/dashboard}"

for target in $targets; do
  namespace="${target%%:*}"
  resource="${target#*:}"
  printf "== rollout: %s/%s ==\n" "$namespace" "$resource"
  kubectl -n "$namespace" rollout status "$resource" --timeout="$timeout"
done
