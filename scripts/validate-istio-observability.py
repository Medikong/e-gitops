#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML==6.0.2"]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run from the GitOps repository root:
#      uv run scripts/validate-istio-observability.py
# 3. Or validate an isolated repository copy:
#      uv run scripts/validate-istio-observability.py --repo <PATH>
# ──────────────────

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeAlias

import yaml


YamlValue: TypeAlias = None | bool | int | float | str | list["YamlValue"] | dict[str, "YamlValue"]
YamlMapping: TypeAlias = dict[str, YamlValue]
MappingIndex: TypeAlias = dict[str, YamlMapping]

APP_NAMESPACE_PAIRS: Final = (
    ("auth-service", "dropmong-auth"), ("user-service", "dropmong-user"), ("catalog-service", "dropmong-catalog"),
    ("coupon-service", "dropmong-coupon"), ("interest-service", "dropmong-interest"), ("order-service", "dropmong-order"),
    ("payment-service", "dropmong-payment"), ("notification-service", "dropmong-notification"), ("dropmong-web", "dropmong-web"),
)
APPS: Final = tuple(app for app, _namespace in APP_NAMESPACE_PAIRS)
NAMESPACES: Final = tuple(namespace for _app, namespace in APP_NAMESPACE_PAIRS)
NAMESPACE_REGEX: Final = f"({'|'.join(NAMESPACES)})"
HCM_FILTER: Final = "envoy.filters.network.http_connection_manager"
ENVOY_ENDPOINT: Final[YamlMapping] = {
    "port": "http-envoy-prom", "path": "/stats/prometheus", "interval": "30s",
    "relabelings": [{"action": "keep", "sourceLabels": ["__meta_kubernetes_pod_container_name"], "regex": "istio-proxy"}],
}
MESH_SELECTOR: Final = re.compile(r"istio_(?:requests_total|request_duration_milliseconds_bucket)\{([^{}]*)\}")
DOCUMENTS: Final = ("platform/istio/README.md", "platform/monitoring/README.md", "platform/monitoring/slo/README.md")


@dataclass(frozen=True, slots=True)
class ContractError(Exception):
    category: str
    detail: str

    def __str__(self) -> str:
        return f"{self.category}: {self.detail}"


def require(condition: bool, category: str, detail: str) -> None:
    if not condition:
        raise ContractError(category, detail)


def mapping(value: YamlValue, context: str) -> YamlMapping:
    if isinstance(value, dict):
        return value
    raise ContractError("malformed_input", f"{context} must be a mapping")


def sequence(value: YamlValue, context: str) -> list[YamlValue]:
    if isinstance(value, list):
        return value
    raise ContractError("malformed_input", f"{context} must be a sequence")


def scalar(value: YamlValue, context: str) -> str:
    if isinstance(value, str):
        return value
    raise ContractError("malformed_input", f"{context} must be a string")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError("malformed_input", f"{path}: unreadable") from error


def parse_yaml(source: str, context: str) -> YamlValue:
    try:
        value: YamlValue = yaml.safe_load(source)
    except yaml.YAMLError as error:
        raise ContractError("malformed_input", f"{context}: invalid YAML") from error
    return value


def load_yaml(path: Path) -> YamlMapping:
    return mapping(parse_yaml(read_text(path), str(path)), str(path))


def load_documents(path: Path) -> list[YamlMapping]:
    try:
        values: list[YamlValue] = list(yaml.safe_load_all(read_text(path)))
    except yaml.YAMLError as error:
        raise ContractError("malformed_input", f"{path}: invalid YAML") from error
    return [mapping(value, str(path)) for value in values if value is not None]


def load_json(path: Path) -> YamlMapping:
    try:
        value: YamlValue = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        raise ContractError("malformed_input", f"{path}: invalid JSON") from error
    return mapping(value, str(path))


def validate_gateway(repo: Path) -> None:
    istio = repo / "platform/istio"
    gateway = istio / "gateway"
    request_id_filter = gateway / "request-id-response.yaml"
    require(request_id_filter.is_file(), "gateway_filter_count", "request-ID EnvoyFilter is missing")
    filters = [
        resource
        for resource in load_documents(request_id_filter)
        if resource.get("kind") == "EnvoyFilter"
    ]
    require(len(filters) == 1, "gateway_filter_count", f"expected one EnvoyFilter, found {len(filters)}")
    resource = filters[0]
    metadata = mapping(resource.get("metadata"), "EnvoyFilter.metadata")
    identity_matches = metadata.get("name") == "ingressgateway-request-id-response" and metadata.get("namespace") == "istio-system"
    require(identity_matches, "gateway_filter_scope", "EnvoyFilter identity differs")
    spec = mapping(resource.get("spec"), "EnvoyFilter.spec")
    selector = mapping(mapping(spec.get("workloadSelector"), "workloadSelector").get("labels"), "selector.labels")
    require(selector == {"istio": "ingressgateway"}, "gateway_filter_scope", "selector must be ingress only")
    patches = sequence(spec.get("configPatches"), "EnvoyFilter.configPatches")
    require(len(patches) == 1, "gateway_request_id", "expected one HCM patch")
    patch = mapping(patches[0], "EnvoyFilter.configPatches[0]")
    match = mapping(patch.get("match"), "configPatch.match")
    listener = mapping(match.get("listener"), "configPatch.match.listener")
    chain_filter = mapping(mapping(listener.get("filterChain"), "filterChain").get("filter"), "filter")
    hcm_scope_matches = patch.get("applyTo") == "NETWORK_FILTER" and match.get("context") == "GATEWAY" and chain_filter.get("name") == HCM_FILTER
    require(hcm_scope_matches, "gateway_filter_scope", "patch must target gateway HCM")
    patch_value = mapping(mapping(patch.get("patch"), "configPatch.patch").get("value"), "patch.value")
    typed_config = mapping(patch_value.get("typed_config"), "patch.value.typed_config")
    request_id_matches = (
        mapping(patch.get("patch"), "configPatch.patch").get("operation") == "MERGE" and patch_value.get("name") == HCM_FILTER
        and typed_config.get("@type") == "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager"
        and typed_config.get("generate_request_id") is True and typed_config.get("always_set_request_id_in_response") is True
    )
    require(request_id_matches, "gateway_request_id", "request ID generation/response fields differ")
    resources = sequence(load_yaml(gateway / "kustomization.yaml").get("resources"), "gateway resources")
    require(resources.count("request-id-response.yaml") == 1, "gateway_filter_count", "EnvoyFilter is not rendered once")

    istiod = load_yaml(repo / "platform/istio/argocd/istiod.yaml")
    source = mapping(mapping(istiod.get("spec"), "istiod.spec").get("source"), "istiod.spec.source")
    helm = mapping(source.get("helm"), "istiod.spec.source.helm")
    values = mapping(parse_yaml(scalar(helm.get("values"), "istiod helm values"), "istiod helm values"), "istiod values")
    mesh_config = mapping(values.get("meshConfig"), "istiod meshConfig")
    require(mesh_config.get("accessLogFile") == "/dev/stdout", "gateway_access_log", "stdout access log is required")


def monitor_index(repo: Path) -> MappingIndex:
    path = repo / "platform/monitoring/manifests/istio-mesh-podmonitors.yaml"
    index: MappingIndex = {}
    for resource in load_documents(path):
        require(resource.get("kind") == "PodMonitor", "monitor_count", "only PodMonitor documents are allowed")
        metadata = mapping(resource.get("metadata"), "PodMonitor.metadata")
        name = scalar(metadata.get("name"), "PodMonitor.metadata.name")
        require(name not in index, "monitor_count", f"duplicate PodMonitor {name}")
        index[name] = resource
    require(set(index) == {"istiod", "dropmong-envoy-sidecars", "istio-ingressgateway"}, "monitor_count", f"unexpected PodMonitor set {sorted(index)}")
    return index


def validate_monitors(repo: Path) -> None:
    monitors = monitor_index(repo)
    for name, monitor in monitors.items():
        metadata = mapping(monitor.get("metadata"), f"{name}.metadata")
        labels = mapping(metadata.get("labels"), f"{name}.metadata.labels")
        require(metadata.get("namespace") == "monitoring" and labels.get("release") == "kube-prometheus-stack", "monitor_targets", f"{name} metadata differs")

    istiod = mapping(monitors["istiod"].get("spec"), "istiod.spec")
    istiod_matches = (istiod.get("namespaceSelector") == {"matchNames": ["istio-system"]} and istiod.get("selector") == {"matchLabels": {"app": "istiod"}}
                       and istiod.get("podMetricsEndpoints") == [{"port": "http-monitoring", "path": "/metrics", "interval": "30s"}])
    require(istiod_matches, "monitor_targets", "istiod target differs")
    sidecars = mapping(monitors["dropmong-envoy-sidecars"].get("spec"), "sidecars.spec")
    expected_selector: YamlMapping = {"matchExpressions": [{"key": "app", "operator": "In", "values": list(APPS)}]}
    targets_match = sidecars.get("namespaceSelector") == {"matchNames": list(NAMESPACES)} and sidecars.get("selector") == expected_selector
    require(targets_match, "monitor_targets", "sidecar app/namespace set must be the exact nine")
    ingress = mapping(monitors["istio-ingressgateway"].get("spec"), "ingress.spec")
    ingress_matches = (ingress.get("namespaceSelector") == {"matchNames": ["istio-system"]}
                       and ingress.get("selector") == {"matchLabels": {"app": "istio-ingressgateway", "istio": "ingressgateway"}})
    require(ingress_matches, "monitor_targets", "ingress target differs")
    for name, spec in (("sidecars", sidecars), ("ingress", ingress)):
        require(spec.get("podMetricsEndpoints") == [ENVOY_ENDPOINT], "proxy_endpoint", f"{name} endpoint must select only istio-proxy")
    for environment in ("aws-dev", "private-dev"):
        values = load_yaml(repo / f"values/env/{environment}.yaml")
        service_monitor = mapping(values.get("serviceMonitor"), f"{environment}.serviceMonitor")
        policy = mapping(service_monitor.get("networkPolicy"), f"{environment}.networkPolicy")
        require(policy.get("extraPorts") == [15090], "monitoring_port", f"{environment} must allow only Envoy port 15090")


def panel_index(dashboard: YamlMapping) -> MappingIndex:
    index: MappingIndex = {}
    for value in sequence(dashboard.get("panels"), "dashboard.panels"):
        panel = mapping(value, "dashboard.panels[]")
        title = scalar(panel.get("title"), "dashboard panel title")
        require(title not in index, "dashboard_scope", f"duplicate panel {title}")
        index[title] = panel
    return index


def expressions(panel: YamlMapping) -> tuple[str, ...]:
    return tuple(
        scalar(mapping(value, "panel.targets[]").get("expr"), "panel target expression")
        for value in sequence(panel.get("targets"), "panel.targets")
    )


def validate_dashboard(repo: Path) -> None:
    dashboard = load_json(repo / "platform/monitoring/dashboards/ops/03-gateway-mesh-metrics.json")
    require(
        dashboard.get("uid") == "dropmong-ops-03-gateway-mesh"
        and dashboard.get("title") == "Ops 03 - Gateway and Mesh Evidence",
        "dashboard_scope",
        "dashboard identity differs",
    )
    panels = panel_index(dashboard)
    istiod_query = 'sum by (namespace, pod) (up{namespace="istio-system",pod=~"istiod-.*"})'
    sidecar_query = f'sum by (namespace, pod) (up{{namespace=~"{NAMESPACE_REGEX}",container="istio-proxy"}})'
    gateway_query = 'sum by (namespace, pod) (up{namespace="istio-system",pod=~"istio-ingressgateway-.*",container="istio-proxy"})'
    require(expressions(mapping(panels.get("Istiod Scrape Targets"), "istiod panel")) == (istiod_query,), "dashboard_scope", "istiod query differs")
    require(expressions(mapping(panels.get("Envoy Sidecar Scrape Targets"), "sidecar panel")) == (sidecar_query,), "dashboard_scope", "sidecar query differs")
    require(expressions(mapping(panels.get("Istio Ingress Gateway Scrape Targets"), "gateway panel")) == (gateway_query,), "dashboard_gateway", "gateway query differs")
    all_expressions = tuple(expression for panel in panels.values() for expression in expressions(panel))
    require(not any("request_id" in expression.lower() or "x_request_id" in expression.lower() for expression in all_expressions), "dashboard_request_id_label", "request IDs must not be metric labels")
    require(not any("kong_" in expression.lower() for expression in all_expressions), "dashboard_scope", "Kong metrics are outside this dashboard")
    selectors = tuple(labels for expression in all_expressions for labels in MESH_SELECTOR.findall(expression))
    require(len(selectors) == 4, "dashboard_scope", f"expected four Istio metric selectors, found {len(selectors)}")
    for labels in selectors:
        require('reporter="destination"' in labels, "dashboard_reporter", "every mesh selector must be destination-only")
        require(f'destination_workload_namespace=~"{NAMESPACE_REGEX}"' in labels, "dashboard_scope", "mesh selector scope differs")
    variables = {
        scalar(variable.get("name"), "dashboard variable name"): variable
        for value in sequence(mapping(dashboard.get("templating"), "dashboard.templating").get("list"), "dashboard variables")
        for variable in (mapping(value, "dashboard variable"),)
    }
    namespace_variable = mapping(variables.get("namespace"), "namespace variable")
    service_variable = mapping(variables.get("service"), "service variable")
    require(
        scalar(namespace_variable.get("query"), "namespace query").split(",") == list(NAMESPACES)
        and namespace_variable.get("allValue") == NAMESPACE_REGEX
        and scalar(service_variable.get("query"), "service query").split(",") == list(APPS)
        and service_variable.get("allValue") == f"({'|'.join(APPS)})",
        "dashboard_scope",
        "dashboard variables must use the exact nine-app scope",
    )


def validate_documents(repo: Path) -> None:
    required = (*APPS, *NAMESPACES, "runtime waiver", "Task 6 remains partial", "AWS dev uses Istio-only ingress", "x-request-id", "metric label")
    for relative in DOCUMENTS:
        normalized = " ".join(read_text(repo / relative).split())
        missing = [marker for marker in required if marker not in normalized]
        require(not missing, "documentation_contract", f"{relative} is missing {missing}")


def validate_aws_kong_removal(repo: Path) -> None:
    applications = repo / "argo/applications/aws-dev/platform"
    for path in sorted(applications.glob("*.yaml")):
        source = read_text(path)
        require(
            "chart: kong" not in source and "platform/kong" not in source and "namespace: kong" not in source,
            "aws_kong_removal",
            f"{path.relative_to(repo)} still deploys Kong",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the Task 7 Istio observability contract")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        repo = args.repo.resolve()
        for validator in (validate_gateway, validate_monitors, validate_dashboard, validate_documents, validate_aws_kong_removal):
            validator(repo)
    except ContractError as error:
        print(f"FAIL task7-istio-observability [{error.category}] {error.detail}")
        return 1
    print("PASS task7-istio-observability: gateway=1 istiod=1 ingress=1 sidecars=9 aws-kong=removed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
