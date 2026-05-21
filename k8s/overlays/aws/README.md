# AWS smoke overlay

This overlay is for a prepared `smoke1` kubeadm cluster on EC2.

It intentionally differs from the local Vagrant overlay:

- Application images are pulled from ECR with the `smoke1` tag.
- MetalLB is not included.
- NodePort is not used.
- External HTTP traffic is expected to enter through the infra-managed load balancer and Kong.

## Smoke scaling baseline

Application Deployments run with two replicas in this overlay. Each application container starts with:

```yaml
resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

This is a small smoke-test baseline for the current two-worker EC2 cluster, not a production sizing result. Treat it as suitable for a demo or light functional test, roughly tens of concurrent users depending on endpoint behavior and database/Kafka load.

Use load testing and metrics before claiming a real user capacity. For a production-like setup, add Metrics Server, HPA, Prometheus/Grafana, and tune the requests from measured CPU and memory usage.

HPA is enabled for the application Deployments with:

```yaml
minReplicas: 2
maxReplicas: 5
averageUtilization: 60
```

Metrics Server must be running before HPA can make decisions. In this kubeadm environment, install it with the AWS inventory:

```bash
cd cluster
make ANSIBLE_INVENTORY=/path/to/aws-smoke1.ini metrics-bootstrap
make ANSIBLE_INVENTORY=/path/to/aws-smoke1.ini metrics-verify
```

## Smoke storage model

PostgreSQL and Kafka still use static `hostPath` PersistentVolumes. This is acceptable for a short-lived smoke environment, but it is not an AWS production storage design.

To reduce scheduling drift in this smoke cluster, the AWS `all` overlay pins the database and Kafka StatefulSets to:

```text
ip-172-31-57-62
```

The DB `hostPath` volumes are patched with `DirectoryOrCreate` so the expected data directories are created on that node.

For a shared or long-running AWS environment, replace this with one of these options:

- RDS for PostgreSQL and MSK for Kafka.
- EBS-backed dynamic provisioning with the AWS EBS CSI driver.
- Explicit backup and restore handling before destroying EC2 nodes.

## Image sources

Application images come from ECR:

```text
941141115079.dkr.ecr.ap-northeast-2.amazonaws.com/medikong-smoke1-*:smoke1
```

Create an ECR pull secret named `ecr-registry` in each application namespace before or immediately after applying this overlay. The Deployments reference that secret through `imagePullSecrets`.

PostgreSQL, Kafka, and BusyBox currently come from public registries. If Docker Hub rate limits or offline repeatability become a problem, mirror those dependency images into ECR as a separate task.
