#!/usr/bin/env bash
set -euo pipefail

namespaces="${APP_STATUS_NAMESPACES:-medical-auth medical-messaging medical-patient medical-appointment medical-prescription medical-notification medical-dashboard}"

printf "== pods across all namespaces ==\n"
kubectl get pods -A -o wide

printf "\n== services by application namespace ==\n"
for namespace in $namespaces; do
  printf "\n-- namespace: %s --\n" "$namespace"
  kubectl get svc -n "$namespace" || true
done

printf "\n== ingress by application namespace ==\n"
for namespace in $namespaces; do
  printf "\n-- namespace: %s --\n" "$namespace"
  kubectl get ingress -n "$namespace" || true
done

printf "\n== pvc by stateful namespace ==\n"
for namespace in medical-auth medical-messaging medical-patient medical-appointment medical-prescription medical-notification; do
  printf "\n-- namespace: %s --\n" "$namespace"
  kubectl get pvc -n "$namespace" || true
done

printf "\n== Kong auth resources ==\n"
kubectl get kongconsumers -n medical-auth || true
kubectl get kongclusterplugins || true

printf "\n== recent application events ==\n"
for namespace in $namespaces; do
  printf "\n-- namespace: %s --\n" "$namespace"
  kubectl get events -n "$namespace" --sort-by=.lastTimestamp | tail -n 20 || true
done
