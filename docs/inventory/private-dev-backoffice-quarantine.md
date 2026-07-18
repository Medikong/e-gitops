# Private-dev Backoffice quarantine inventory

Status: **LIVE-NOT-APPLIED**

Run the command blocks sequentially in one POSIX shell so the protected
`inventory`, `projection`, `pinned_root`, and revision variables remain bound.
Block boundaries are review pauses, not new shell sessions.

This runbook retains the historical `backoffice-private-dev` Argo CD Application
boundary without restoring a Backoffice workload. The quarantine source renders
zero Kubernetes resources, automated pruning is temporarily disabled at the
private-dev parent, automated child sync is absent, and the desired child has no
resource finalizer. The `Prune=false` annotation on the child is defense in depth
for the parent-managed resource, not a child-wide prune contract. This state does
not create a Namespace, Deployment, StatefulSet, Service, Ingress, VirtualService,
Secret, image reference, database workload, or dependency on another service.

## Historical contract

- `f19cbb4ae64e5acfa62bcbdfc83c761084cd590d` introduced
  `Application/backoffice-private-dev`, destination Namespace
  `ticketing-backoffice`, release name `backoffice-private-dev`, workload name
  `backoffice-service`, and local database identifiers `backoffice-db` /
  `backoffice_service`.
- `296d690add40595f0059461109dd779d22d1425c` removed the Backoffice Application
  and values while `argo/applications/private-dev/root.yaml` retained
  `automated.prune: true`. A live child Application omitted from the root render is
  therefore a prune candidate; a resources finalizer on that child could cascade
  deletion to its managed resources.
- The historical database values were a local Helm input, not proof of the live
  private-dev resource names. Inventory live resources; do not synthesize a PVC,
  Secret, or database workload from those old values.
- `argo/setup-argocd.sh` installs Argo CD from the moving `stable` URL. The
  repository therefore does not prove the live controller version. Do not rely on
  an Application-wide `Prune=false` sync option; identify the live controller and
  use the version-independent parent `automated.prune: false` freeze below.

## Mandatory identity gate

Do not use a context name such as `minikube` as proof that a cluster is the intended
private-dev target. Obtain the expected context and API server identity from the
private-dev cluster owner, then run only the read-only gate first:

```sh
set -eu
EXPECTED_PRIVATE_DEV_CONTEXT="${EXPECTED_PRIVATE_DEV_CONTEXT:?set the owner-confirmed context}"
test "$(kubectl config current-context)" = "${EXPECTED_PRIVATE_DEV_CONTEXT}"
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
kubectl get namespace argocd -o name
kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.spec.destination.server}{"\t"}{.spec.destination.namespace}{"\n"}'
```

Stop if any value differs from the owner-confirmed inventory. At authoring time,
live kubeconfig access was unavailable and a separately reported `minikube` context
could not be proven to be private-dev. No live mutation or Argo sync was performed.

## Hard no-operation gate

Until every gate in this runbook passes, the following are forbidden for both the
root and child Applications: UI sync, CLI sync, manual prune, delete, rollback,
terminate-and-retry, and changes to an active operation. Only the explicitly listed
read-only inventory commands and protective patches are allowed.

First prove that no sync, prune, or delete operation is active and record the live
controller build. An unpinned `stable` or `latest` image, an empty image digest, a
deletion timestamp, or an in-flight operation is a hard stop.

```sh
set -eu
require_idle_application() {
  app="$1"
  deletion="$(kubectl -n argocd get application "${app}" \
    -o jsonpath='{.metadata.deletionTimestamp}')"
  operation="$(kubectl -n argocd get application "${app}" \
    -o jsonpath='{.operation}')"
  phase="$(kubectl -n argocd get application "${app}" \
    -o jsonpath='{.status.operationState.phase}')"
  test -z "${deletion}"
  test -z "${operation}"
  case "${phase}" in
    ''|Succeeded|Failed|Error) ;;
    *) printf 'STOP: Application/%s operation phase=%s\n' "${app}" "${phase}" >&2; exit 1 ;;
  esac
}

require_idle_application medikong-private-dev-apps
if kubectl -n argocd get application backoffice-private-dev >/dev/null 2>&1; then
  require_idle_application backoffice-private-dev
fi

controller_image="$(kubectl -n argocd get statefulset argocd-application-controller \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="argocd-application-controller")].image}')"
controller_image_id="$(kubectl -n argocd get pods \
  -l app.kubernetes.io/name=argocd-application-controller \
  -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="argocd-application-controller")].imageID}')"
test -n "${controller_image}"
test -n "${controller_image_id}"
case "${controller_image}" in
  *:stable|*:latest) printf 'STOP: unpinned controller image: %s\n' "${controller_image}" >&2; exit 1 ;;
esac
argocd version --short
printf 'controller image=%s\ncontroller imageID=%s\n' \
  "${controller_image}" "${controller_image_id}"
```

## Pre-sync inventory

Run this before the root Application observes the protected Git revision. Keep the
snapshot outside the repository. Secret values are deliberately not exported.

```sh
set -eu
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
inventory="${TMPDIR:-/tmp}/backoffice-private-dev-${stamp}"
mkdir -p "${inventory}"

argocd version --short >"${inventory}/argocd-version.txt"
kubectl -n argocd get statefulset argocd-application-controller -o yaml \
  >"${inventory}/application-controller.yaml"
kubectl -n argocd get application medikong-private-dev-apps -o yaml \
  >"${inventory}/root-application.yaml"
kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.status.sync.revisions}{"\n"}' \
  >"${inventory}/root-resolved-revisions.txt"
if kubectl -n argocd get application backoffice-private-dev -o yaml \
  >"${inventory}/backoffice-application.yaml"; then
  kubectl -n argocd get application backoffice-private-dev \
    -o jsonpath='{.metadata.finalizers}{"\n"}{.spec.syncPolicy.automated}{"\n"}'
else
  printf '%s\n' 'Application/backoffice-private-dev is absent; continue inventorying orphaned data.'
fi

if kubectl get namespace ticketing-backoffice >/dev/null 2>&1; then
  kubectl -n ticketing-backoffice get \
    deployment,statefulset,daemonset,job,cronjob,service,ingress,configmap,pvc,networkpolicy \
    -o yaml >"${inventory}/namespaced-resources.yaml"
  kubectl -n ticketing-backoffice get secret \
    -o custom-columns=NAME:.metadata.name,TYPE:.type \
    >"${inventory}/secret-metadata.txt"
  kubectl -n ticketing-backoffice get pvc \
    -o custom-columns=PVC:.metadata.name,PV:.spec.volumeName,CLASS:.spec.storageClassName,STATUS:.status.phase
  kubectl -n ticketing-backoffice get pvc -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
    | sort -u >"${inventory}/live-pvcs.txt"
else
  printf '%s\n' 'Namespace/ticketing-backoffice is absent' \
    >"${inventory}/namespace-absent.txt"
  : >"${inventory}/live-pvcs.txt"
fi
printf 'Sensitive inventory saved at %s\n' "${inventory}"
```

An absent Namespace is a valid zero-resource observation. Record it explicitly; do
not create the Namespace.

## Backup coverage gate

If `live-pvcs.txt` is non-empty, the storage owner must provide a tab-separated
backup map with exactly three non-empty fields per row: PVC name, immutable backup
or snapshot ID, and restore-test evidence. A snapshot ID without restore evidence
does not pass. This gate only checks coverage; the operator must also inspect the
referenced backup system.

```sh
set -eu
BACKUP_MAP="${BACKUP_MAP:?path to owner-approved PVC backup map}"
test -f "${BACKUP_MAP}"
if test -s "${inventory}/live-pvcs.txt"; then
  awk -F '\t' 'NF != 3 || $1 == "" || $2 == "" || $3 == "" { exit 1 }' "${BACKUP_MAP}"
  cut -f1 "${BACKUP_MAP}" | sort -u >"${inventory}/backed-up-pvcs.txt"
  if ! comm -23 "${inventory}/live-pvcs.txt" "${inventory}/backed-up-pvcs.txt" \
    >"${inventory}/missing-backups.txt"; then
    exit 1
  fi
  test ! -s "${inventory}/missing-backups.txt"
else
  printf '%s\n' 'NO-LIVE-PVC' >"${inventory}/backup-coverage.txt"
fi
cp "${BACKUP_MAP}" "${inventory}/owner-approved-backup-map.tsv"
```

## Live protection before root sync

Only after the identity, idle-controller, inventory, and backup gates pass, freeze
parent automated pruning and protect any live child boundary and storage. These
protective patches are not permission to sync, prune, or delete, and they are
reversible from the snapshot. The live parent patch removes the entire automated
policy so a moving `HEAD` cannot reconcile while the exact reviewed revision is
being pinned; the repository manifest's `prune: false` policy is not applied yet.

```sh
set -eu
test -z "$(kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.metadata.deletionTimestamp}{.operation}')"
kubectl -n argocd patch application medikong-private-dev-apps --type=merge -p \
  '{"spec":{"syncPolicy":{"automated":null}}}'

if kubectl -n argocd get application backoffice-private-dev >/dev/null 2>&1; then
  test -z "$(kubectl -n argocd get application backoffice-private-dev \
    -o jsonpath='{.metadata.deletionTimestamp}{.operation}')"
  kubectl -n argocd patch application backoffice-private-dev --type=merge -p \
    '{"metadata":{"annotations":{"argocd.argoproj.io/sync-options":"Prune=false"},"finalizers":null},"spec":{"syncPolicy":{"automated":null,"syncOptions":["CreateNamespace=false"]}}}'
fi

if kubectl get namespace ticketing-backoffice >/dev/null 2>&1; then
  kubectl -n ticketing-backoffice get pvc -o name | while IFS= read -r pvc; do
    test -n "${pvc}" || continue
    kubectl -n ticketing-backoffice annotate --overwrite "${pvc}" \
      argocd.argoproj.io/sync-options=Prune=false
  done

  kubectl -n ticketing-backoffice get pvc \
    -o jsonpath='{range .items[*]}{.spec.volumeName}{"\n"}{end}' | while IFS= read -r pv; do
    test -n "${pv}" || continue
    kubectl patch persistentvolume "${pv}" --type=merge \
      -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
  done
fi
```

## Diff and authorization gate

Do not sync the historical child Application. Do not use `argocd app sync --prune`
on the root. Never apply `argo/applications/private-dev/root.yaml` directly because
its `HEAD` sources can move after review. Require a full commit SHA that is already
pushed to an explicitly named remote branch, render that exact revision outside the
repository, and generate an automation-off root manifest whose every source is
pinned to that SHA. Review both the pinned root-object diff and every child
Application diff. `kubectl diff` exit code `1` means a diff was found and is not an
error; any code greater than `1` is a hard stop.

```sh
set -eu
PROTECTED_REVISION="${PROTECTED_REVISION:?full reviewed commit SHA}"
PROTECTED_REMOTE_REF="${PROTECTED_REMOTE_REF:?remote branch, for example refs/heads/main}"
test "${#PROTECTED_REVISION}" -eq 40
case "${PROTECTED_REVISION}" in *[!0-9a-f]*) exit 1 ;; esac
case "${PROTECTED_REMOTE_REF}" in refs/heads/*) ;; *) exit 1 ;; esac
git cat-file -e "${PROTECTED_REVISION}^{commit}"

remote_tip="$(git ls-remote --exit-code origin "${PROTECTED_REMOTE_REF}" | awk 'NR == 1 { print $1 }')"
test "${#remote_tip}" -eq 40
case "${remote_tip}" in *[!0-9a-f]*) exit 1 ;; esac
git fetch --no-tags origin "${PROTECTED_REMOTE_REF}"
fetched_tip="$(git rev-parse FETCH_HEAD)"
test "${fetched_tip}" = "${remote_tip}"
git cat-file -e "${remote_tip}^{commit}"
git merge-base --is-ancestor "${PROTECTED_REVISION}" "${remote_tip}"

projection="${inventory}/protected-projection"
mkdir -p "${projection}"
git show "${PROTECTED_REVISION}:argo/applications/private-dev/root.yaml" \
  >"${projection}/reviewed-root.yaml"
git archive "${PROTECTED_REVISION}" \
  argo/applications/private-dev/platform \
  argo/applications/private-dev/services \
  argo/applications/private-dev/quarantine \
  | tar -x -C "${projection}"

pinned_root="${inventory}/pinned-root-${PROTECTED_REVISION}.yaml"
cleanup_pinned_root() { rm -f -- "${pinned_root}"; }
trap cleanup_pinned_root EXIT HUP INT TERM
pin_patch="$(printf \
  '[{"op":"replace","path":"/spec/sources/0/targetRevision","value":"%s"},{"op":"replace","path":"/spec/sources/1/targetRevision","value":"%s"},{"op":"replace","path":"/spec/sources/2/targetRevision","value":"%s"},{"op":"remove","path":"/spec/syncPolicy/automated"}]' \
  "${PROTECTED_REVISION}" "${PROTECTED_REVISION}" "${PROTECTED_REVISION}")"
kubectl patch --local -f "${projection}/reviewed-root.yaml" --type=json \
  -p "${pin_patch}" -o yaml >"${pinned_root}"

if grep -q 'HEAD' "${pinned_root}"; then
  printf '%s\n' 'STOP: pinned root still contains HEAD' >&2
  exit 1
fi
test "$(grep -Ec "targetRevision: ${PROTECTED_REVISION}$" "${pinned_root}")" -eq 3
if grep -q 'automated:' "${pinned_root}"; then
  printf '%s\n' 'STOP: pinned root must keep automation disabled' >&2
  exit 1
fi

set +e
kubectl diff -f "${pinned_root}" >"${inventory}/root.diff"
root_diff_rc="$?"
kubectl diff -R -f "${projection}/argo/applications/private-dev" \
  >"${inventory}/children.diff"
children_diff_rc="$?"
set -e
test "${root_diff_rc}" -le 1
test "${children_diff_rc}" -le 1

grep -q 'path: argo/applications/private-dev/quarantine' "${pinned_root}"
test -z "$(kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.spec.syncPolicy.automated}')"
test -z "$(kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.metadata.deletionTimestamp}{.operation}')"

if kubectl get namespace ticketing-backoffice >/dev/null 2>&1; then
  kubectl -n ticketing-backoffice get pvc -o name | while IFS= read -r pvc; do
    test -n "${pvc}" || continue
    test "$(kubectl -n ticketing-backoffice get "${pvc}" \
      -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/sync-options}')" = 'Prune=false'
    pv="$(kubectl -n ticketing-backoffice get "${pvc}" -o jsonpath='{.spec.volumeName}')"
    test -n "${pv}"
    test "$(kubectl get persistentvolume "${pv}" \
      -o jsonpath='{.spec.persistentVolumeReclaimPolicy}')" = 'Retain'
  done
fi

test "${CONTROLLER_VERSION_APPROVED:-}" = 'YES'
test "${BACKUP_COVERAGE_APPROVED:-}" = 'YES'
test "${DIFF_APPROVED:-}" = 'YES'
```

The approver must inspect `root.diff`, `children.diff`, the remote proof, captured
controller version/image digest, and backup map. Expected T1 changes are only an
automation-off parent pinned to the reviewed SHA, the new quarantine source, and
the inactive child Application. Any `HEAD`, deletion, workload, route, Secret data,
image, database resource, or unrelated Application change is a hard stop.

Only after all three explicit approvals and a final idle check may the operator
apply the generated pinned root. Applying the repository root manifest directly is
forbidden. Because the pinned manifest has no automated policy, this apply cannot
start reconciliation:

```sh
set -eu
test -z "$(kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.metadata.deletionTimestamp}{.operation}')"
kubectl apply -f "${pinned_root}"

live_source_revisions="$(kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{range .spec.sources[*]}{.targetRevision}{"\n"}{end}')"
printf '%s\n' "${live_source_revisions}" | awk -v revision="${PROTECTED_REVISION}" '
  NF { count += 1; if ($0 != revision) exit 1 }
  END { if (count != 3) exit 1 }
'

resolved_ok=false
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  resolved_revisions="$(kubectl -n argocd get application medikong-private-dev-apps \
    -o jsonpath='{range .status.sync.revisions[*]}{.}{"\n"}{end}')"
  if printf '%s\n' "${resolved_revisions}" | awk -v revision="${PROTECTED_REVISION}" '
    NF { count += 1; if ($0 != revision) exit 1 }
    END { if (count != 3) exit 1 }
  '; then
    resolved_ok=true
    break
  fi
  sleep 2
done
test "${resolved_ok}" = 'true'
test -z "$(kubectl -n argocd get application medikong-private-dev-apps \
  -o jsonpath='{.spec.syncPolicy.automated}{.metadata.deletionTimestamp}{.operation}')"

printf '%s\n' 'Pinned source and resolved revisions verified; root sync without prune is now the only allowed action.'
argocd app sync medikong-private-dev-apps \
  --revisions "${PROTECTED_REVISION}" --source-positions 1 \
  --revisions "${PROTECTED_REVISION}" --source-positions 2 \
  --revisions "${PROTECTED_REVISION}" --source-positions 3
argocd app wait medikong-private-dev-apps --operation --timeout 300

kubectl -n argocd get application backoffice-private-dev \
  -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/sync-options}{"\n"}{.metadata.finalizers}{"\n"}{.spec.source.path}{"\n"}{.spec.syncPolicy.automated}{"\n"}{.spec.syncPolicy.syncOptions}{"\n"}'
kubectl -n ticketing-backoffice get deployment,statefulset,service,ingress 2>/dev/null || true
cleanup_pinned_root
trap - EXIT HUP INT TERM
```

Expected: `Prune=false`; no finalizer; source path
`argo/quarantine/private-dev/backoffice-retention`; no automated policy; child
sync options contain only `CreateNamespace=false`; the live parent remains
automation-off and pinned to the reviewed SHA; no Backoffice workload or route is
created; and the temporary pinned manifest is deleted. Keep the parent automation
freeze and child quarantine until an explicit, reviewed retirement or restore plan
inventories the real live data and defines rollback. Applying the repository
`HEAD` root or re-enabling parent automation is a separate change and approval, not
part of this procedure.

## Argo CD behavior references

- [No-prune sync option](https://argo-cd.readthedocs.io/en/latest/user-guide/sync-options/#no-prune-resources)
- [Non-cascading Application deletion and resource finalizers](https://argo-cd.readthedocs.io/en/latest/user-guide/app_deletion/)
- [`argocd app diff` exit codes and multi-source revisions](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_diff/)
