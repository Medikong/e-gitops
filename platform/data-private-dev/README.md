# Private-dev data platform

`platform/data-private-dev` is the on-prem private-dev data path. It is separate from `platform/data`, which remains the Docker Desktop local development data path.

## Secrets

This path does not commit database or pgAdmin passwords. Prepare the referenced Secrets in the private-dev cluster before syncing this Application.

The infra repo has a bootstrap playbook for this:

```bash
cd ../infra/infra/cluster/provision/ansible-lab
ansible-playbook -i inventories/lab/dev.ini playbooks/bootstrap-private-dev-secrets.yml
```

It reads passwords from environment variables and applies Kubernetes Secrets without writing plaintext values to Git.

```bash
kubectl -n ticketing-auth create secret generic postgres-auth-credentials --from-literal=password='<value>'
kubectl -n ticketing-concert create secret generic postgres-concert-credentials --from-literal=password='<value>'
kubectl -n ticketing-reservation create secret generic postgres-reservation-credentials --from-literal=password='<value>'
kubectl -n ticketing-payment create secret generic postgres-payment-credentials --from-literal=password='<value>'
kubectl -n ticketing-ticket create secret generic postgres-ticket-credentials --from-literal=password='<value>'
kubectl -n ticketing-payment create secret generic pgadmin-private-dev-credentials --from-literal=email='<admin-email>' --from-literal=password='<value>'
```

Use SSH to node1 or an admin workstation with the private-dev kubeconfig when the pgAdmin password is needed.

```bash
kubectl -n ticketing-payment get secret pgadmin-private-dev-credentials -o jsonpath='{.data.password}' | base64 -d
```

All StatefulSet and PVC resources in this path use `storageClassName: medikong-longhorn`.

## NetworkPolicy

`networkpolicies.yaml` mirrors the service/data access model used by the shared data path:

- service pods can access only their own DB ports.
- event-driven services can access Kafka on `9092`.
- Kafka can talk to itself on `9092` and `9093`.
- pgAdmin is reachable only through Kong and can egress only to PostgreSQL services plus DNS.

Keep this file aligned with `platform/data/networkpolicies.yaml` when the data access model changes.
