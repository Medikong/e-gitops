#!/usr/bin/env sh
set -eu

context="${LOCAL_K8S_CONTEXT:-docker-desktop}"
registry_name="${LOCAL_K8S_REGISTRY_NAME:-local-k8s-registry}"
registry_port="${LOCAL_K8S_REGISTRY_PORT:-5001}"
registry_network="${LOCAL_K8S_REGISTRY_NETWORK:-kind}"

if [ "$(docker inspect -f '{{.State.Running}}' "${registry_name}" 2>/dev/null || true)" != "true" ]; then
  if docker ps --format '{{.Ports}}' | grep -q "127.0.0.1:${registry_port}->5000/tcp"; then
    registry_name="$(docker ps --filter "publish=${registry_port}" --format '{{.Names}}' | head -n 1)"
  else
    docker run \
      -d \
      --restart=always \
      -p "127.0.0.1:${registry_port}:5000" \
      --network bridge \
      --name "${registry_name}" \
      registry:3 >/dev/null
  fi
fi

if [ -z "${registry_name}" ]; then
  printf '%s\n' "Could not resolve local registry container for port ${registry_port}." >&2
  exit 1
fi

if ! docker network inspect "${registry_network}" >/dev/null 2>&1; then
  printf '%s\n' "Docker network '${registry_network}' was not found. Is Docker Desktop Kubernetes running?" >&2
  exit 1
fi

if [ "$(docker inspect -f "{{json .NetworkSettings.Networks.${registry_network}}}" "${registry_name}")" = "null" ]; then
  docker network connect "${registry_network}" "${registry_name}"
fi

registry_dir="/etc/containerd/certs.d/localhost:${registry_port}"
nodes="$(kubectl --context "${context}" get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"

for node in ${nodes}; do
  if ! docker inspect "${node}" >/dev/null 2>&1; then
    printf '%s\n' "Kubernetes node '${node}' is not a Docker container; cannot configure local registry automatically." >&2
    exit 1
  fi

  docker exec "${node}" mkdir -p "${registry_dir}"
  cat <<EOF | docker exec -i "${node}" cp /dev/stdin "${registry_dir}/hosts.toml"
server = "http://localhost:${registry_port}"

[host."http://${registry_name}:5000"]
  capabilities = ["pull", "resolve", "push"]
EOF
done

cat <<EOF | kubectl --context "${context}" apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${registry_port}"
    help: "Local registry is served by Docker container '${registry_name}' and mapped in node containerd hosts.toml."
EOF
