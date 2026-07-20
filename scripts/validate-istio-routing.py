#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.2"]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run from the GitOps repository root:
#      uv run scripts/validate-istio-routing.py
# 3. Or validate an isolated repository copy:
#      uv run scripts/validate-istio-routing.py --repo <PATH>
# ─────────────────

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeAlias

import yaml


YamlValue: TypeAlias = None | bool | int | float | str | list["YamlValue"] | dict[str, "YamlValue"]
RouteTuple: TypeAlias = tuple[str, str]

DESTINATIONS: Final = {
    "auth-routes": ("auth-service.dropmong-auth.svc.cluster.local", 8080),
    "catalog-routes": ("catalog-service.dropmong-catalog.svc.cluster.local", 8081),
    "order-routes": ("order-service.dropmong-order.svc.cluster.local", 8082),
    "payment-routes": ("payment-service.dropmong-payment.svc.cluster.local", 8083),
    "notification-routes": ("notification-service.dropmong-notification.svc.cluster.local", 8084),
}
PUBLIC_HEADERS: Final = {"x-user-id", "x-session-id", "x-token-id", "x-user-role", "x-user-email"}
PROTECTED_HEADERS: Final = {"x-user-role", "x-user-email"}
SESSION_STATUS_PATH: Final = "/internal/session/status"
SESSION_STATUS_REDIS_URL: Final = "redis://auth-session-redis.dropmong-auth.svc.cluster.local:6379/0"
SESSION_STATUS_CACHE_TTL: Final = "5m"
SESSION_STATUS_TOMBSTONE_TTL: Final = "20m"
SESSION_STATUS_ENV: Final = {
    "AUTH_SESSION_STATUS_ENABLED",
    "REDIS_URL",
    "AUTH_SESSION_STATUS_TIMEOUT",
    "AUTH_SESSION_STATUS_DB_TIMEOUT",
    "AUTH_SESSION_STATUS_CACHE_TTL",
    "AUTH_SESSION_STATUS_TOMBSTONE_TTL",
}
LEGACY_SESSION_STATUS_ENV: Final = {
    "AUTH_SESSION_STATUS_REDIS_URL",
    "AUTH_SESSION_STATUS_ACTIVE_TTL",
    "AUTH_SESSION_STATUS_MAX_DB_LOOKUPS",
}
FORBIDDEN: Final = (
    "/internal",
    "jwks",
    "/api/v1/operator",
    "/api/v1/dev",
    "/debug",
    "/__debug",
    "/users",
    "/backoffice",
    "/payments/mock-failures",
)


@dataclass(frozen=True, slots=True)
class ContractError(Exception):
    category: str
    detail: str

    def __str__(self) -> str:
        return f"{self.category}: {self.detail}"


def mapping(value: YamlValue, context: str) -> dict[str, YamlValue]:
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


def parse_yaml(source: str, context: str) -> YamlValue:
    try:
        value: YamlValue = yaml.safe_load(source)
    except yaml.YAMLError as error:
        raise ContractError("malformed_input", f"{context}: invalid YAML") from error
    return value


def load(path: Path) -> dict[str, YamlValue]:
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError("malformed_input", f"{path}: unreadable") from error
    return mapping(parse_yaml(source, str(path)), str(path))


def expected_routes(repo: Path) -> tuple[frozenset[RouteTuple], frozenset[RouteTuple]]:
    contract = load(repo / "scripts/fixtures/istio-routing-contract.yaml")
    metadata = mapping(contract.get("metadata"), "contract.metadata")
    sources = mapping(metadata.get("sources"), "contract.metadata.sources")
    public: set[RouteTuple] = set()
    protected: set[RouteTuple] = set()
    for value in sequence(mapping(contract.get("spec"), "contract.spec").get("routes"), "contract.spec.routes"):
        route = mapping(value, "contract.spec.routes[]")
        item = (scalar(route.get("method"), "contract route method"), scalar(route.get("path"), "contract route path"))
        if scalar(route.get("source"), "contract route source") not in sources:
            raise ContractError("malformed_input", "contract route has unknown source citation")
        exposure = scalar(route.get("exposure"), "contract route exposure")
        if exposure == "public":
            public.add(item)
        elif exposure == "protected":
            protected.add(item)
        else:
            raise ContractError("malformed_input", "contract route exposure must be public or protected")
    if len(public) != 18 or len(protected) != 16:
        raise ContractError("malformed_input", f"contract counts public={len(public)} protected={len(protected)}")
    return frozenset(public), frozenset(protected)


def normalized_uri(match: dict[str, YamlValue]) -> str:
    uri = mapping(match.get("uri"), "match.uri")
    if "exact" in uri:
        return scalar(uri["exact"], "match.uri.exact")
    regex = scalar(uri.get("regex"), "match.uri.regex")
    normalized = regex.removeprefix("^").removesuffix("$").replace("[^/]+", "{*}")
    if "[" in normalized or "(" in normalized or "\\" in normalized:
        raise ContractError("route_matrix", f"unsupported route regex {regex}")
    return normalized


def route_tuple(match_value: YamlValue) -> RouteTuple:
    match = mapping(match_value, "http.match[]")
    method = scalar(mapping(match.get("method"), "match.method").get("exact"), "match.method.exact")
    return method, normalized_uri(match)


def virtual_services(repo: Path) -> list[dict[str, YamlValue]]:
    child = repo / "platform/istio/private-dev/routing-authz"
    services = [load(path) for path in sorted(child.glob("*-virtualservice.yaml"))]
    if len(services) != len(DESTINATIONS):
        raise ContractError("route_matrix", f"expected five VirtualServices, found {len(services)}")
    for path in repo.glob("platform/**/*.yaml"):
        if child in path.parents or "kind: VirtualService" not in path.read_text(encoding="utf-8"):
            continue
        resource = load(path)
        if resource.get("kind") == "VirtualService" and "medikong-internal" in sequence(mapping(resource.get("spec"), "spec").get("gateways"), "spec.gateways"):
            raise ContractError("outside_child_gateway", str(path.relative_to(repo)))
    return services


def validate_routes(resources: list[dict[str, YamlValue]], expected: tuple[frozenset[RouteTuple], frozenset[RouteTuple]]) -> tuple[set[RouteTuple], set[RouteTuple]]:
    public: set[RouteTuple] = set()
    protected: set[RouteTuple] = set()
    for resource in resources:
        metadata = mapping(resource.get("metadata"), "VirtualService.metadata")
        name = scalar(metadata.get("name"), "VirtualService.metadata.name")
        spec = mapping(resource.get("spec"), f"{name}.spec")
        if metadata.get("namespace") != "istio-system" or spec.get("gateways") != ["medikong-internal"]:
            raise ContractError("route_contract", f"{name} namespace/gateway")
        for http_value in sequence(spec.get("http"), f"{name}.spec.http"):
            http = mapping(http_value, f"{name}.http[]")
            route_name = scalar(http.get("name"), f"{name}.http[].name")
            target = public if route_name.startswith("public-") else protected
            expected_headers = PUBLIC_HEADERS if target is public else PROTECTED_HEADERS
            removed = set(sequence(mapping(mapping(http.get("headers"), "headers").get("request"), "headers.request").get("remove"), "headers.request.remove"))
            if removed != expected_headers:
                category = "public_header_remove" if target is public else "protected_header_remove"
                raise ContractError(category, f"{route_name}: {sorted(removed)}")
            routes = sequence(http.get("route"), f"{route_name}.route")
            if not routes:
                raise ContractError("malformed_input", f"{route_name}.route must not be empty")
            destination = mapping(mapping(routes[0], "route[0]").get("destination"), "destination")
            actual_destination = (destination.get("host"), mapping(destination.get("port"), "destination.port").get("number"))
            if len(routes) != 1 or actual_destination != DESTINATIONS.get(name):
                raise ContractError("route_contract", f"{route_name}: destination {actual_destination}")
            for match in sequence(http.get("match"), f"{route_name}.match"):
                item = route_tuple(match)
                if any(fragment in item[1].lower() for fragment in FORBIDDEN):
                    raise ContractError("forbidden_exposure", f"{item[0]} {item[1]}")
                target.add(item)
    if public & protected:
        raise ContractError("public_protected_overlap", str(sorted(public & protected)))
    expected_public, expected_protected = expected
    if public != expected_public or protected != expected_protected:
        raise ContractError("route_matrix", f"public delta={sorted(public ^ expected_public)} protected delta={sorted(protected ^ expected_protected)}")
    return public, protected


def validate_policy(repo: Path, protected: set[RouteTuple]) -> None:
    child = repo / "platform/istio/private-dev/routing-authz"
    for path in child.glob("*.yaml"):
        text = path.read_text(encoding="utf-8")
        if "jwks" in text.lower():
            raise ContractError("forbidden_exposure", f"external JWKS in {path.name}")
        resource = load(path)
        kind = resource.get("kind")
        if kind == "RequestAuthentication":
            raise ContractError("forbidden_exposure", f"RequestAuthentication in {path.name}")
        if kind == "AuthorizationPolicy" and mapping(resource.get("spec"), "AuthorizationPolicy.spec").get("action") in {"ALLOW", "DENY"}:
            raise ContractError("forbidden_exposure", f"{path.name} uses ALLOW/DENY")
    policy = load(child / "ext-authz-policy.yaml")
    spec = mapping(policy.get("spec"), "AuthorizationPolicy.spec")
    labels = mapping(mapping(spec.get("selector"), "selector").get("matchLabels"), "selector.matchLabels")
    if policy.get("kind") != "AuthorizationPolicy" or spec.get("action") != "CUSTOM" or mapping(spec.get("provider"), "provider").get("name") != "medikong-authz-http" or labels != {"app": "istio-ingressgateway", "istio": "ingressgateway"}:
        raise ContractError("authorization_policy", "CUSTOM provider or gateway selector differs")
    custom: set[RouteTuple] = set()
    for rule_value in sequence(spec.get("rules"), "AuthorizationPolicy.rules"):
        targets = sequence(mapping(rule_value, "rules[]").get("to"), "rules[].to")
        if not targets:
            raise ContractError("malformed_input", "AuthorizationPolicy rule.to must not be empty")
        operation = mapping(mapping(targets[0], "to[0]").get("operation"), "operation")
        for method in sequence(operation.get("methods"), "operation.methods"):
            for path in sequence(operation.get("paths"), "operation.paths"):
                custom.add((scalar(method, "method"), scalar(path, "path")))
    if custom != protected:
        raise ContractError("protected_custom_mismatch", f"delta={sorted(custom ^ protected)}")


def validate_provider(repo: Path) -> None:
    application = load(repo / "platform/istio/argocd/istiod.yaml")
    source = mapping(mapping(application.get("spec"), "spec").get("source"), "source")
    values_text = scalar(mapping(source.get("helm"), "source.helm").get("values"), "source.helm.values")
    values = parse_yaml(values_text, "istiod inline Helm values")
    providers = sequence(mapping(mapping(values, "istiod values").get("meshConfig"), "meshConfig").get("extensionProviders"), "extensionProviders")
    matching = [mapping(item, "extensionProviders[]") for item in providers if mapping(item, "extensionProviders[]").get("name") == "medikong-authz-http"]
    if len(matching) != 1:
        raise ContractError("provider_contract", f"provider count {len(matching)}")
    config = mapping(matching[0].get("envoyExtAuthzHttp"), "envoyExtAuthzHttp")
    expected: dict[str, YamlValue] = {
        "service": "auth-service.dropmong-auth.svc.cluster.local",
        "port": 8080,
        "pathPrefix": SESSION_STATUS_PATH,
        "timeout": "200ms",
        "failOpen": False,
        "statusOnError": "503",
        "includeRequestHeadersInCheck": ["authorization", "x-request-id"],
        "headersToUpstreamOnAllow": ["x-user-id", "x-session-id", "x-token-id"],
    }
    actual = {key: config.get(key) for key in expected}
    if actual != expected:
        raise ContractError("provider_contract", f"auth provider differs: {actual}")


def container_env(repo: Path, relative_path: str) -> dict[str, YamlValue]:
    values = load(repo / relative_path)
    container = mapping(values.get("container"), f"{relative_path}.container")
    result: dict[str, YamlValue] = {}
    for item_value in sequence(container.get("env"), f"{relative_path}.container.env"):
        item = mapping(item_value, f"{relative_path}.container.env[]")
        name = scalar(item.get("name"), f"{relative_path}.container.env[].name")
        if name in result:
            raise ContractError("auth_session_status", f"{relative_path}: duplicate {name}")
        result[name] = item.get("value")
    return result


def validate_auth_session_status(repo: Path) -> None:
    expected_by_file: dict[str, dict[str, YamlValue]] = {
        "values/services/auth.yaml": {
            "AUTH_SESSION_STATUS_ENABLED": "false",
            "AUTH_SESSION_STATUS_TIMEOUT": "200ms",
            "AUTH_SESSION_STATUS_DB_TIMEOUT": "100ms",
            "AUTH_SESSION_STATUS_CACHE_TTL": SESSION_STATUS_CACHE_TTL,
            "AUTH_SESSION_STATUS_TOMBSTONE_TTL": SESSION_STATUS_TOMBSTONE_TTL,
        },
        "values/services/private-dev/auth.yaml": {
            "AUTH_SESSION_STATUS_ENABLED": "true",
            "REDIS_URL": SESSION_STATUS_REDIS_URL,
            "AUTH_SESSION_STATUS_TIMEOUT": "200ms",
            "AUTH_SESSION_STATUS_DB_TIMEOUT": "100ms",
            "AUTH_SESSION_STATUS_CACHE_TTL": SESSION_STATUS_CACHE_TTL,
            "AUTH_SESSION_STATUS_TOMBSTONE_TTL": SESSION_STATUS_TOMBSTONE_TTL,
        },
    }
    for relative_path, expected in expected_by_file.items():
        env = container_env(repo, relative_path)
        legacy = sorted(LEGACY_SESSION_STATUS_ENV & env.keys())
        if legacy:
            raise ContractError("auth_session_status", f"{relative_path}: legacy variables {legacy}")
        actual = {name: env.get(name) for name in expected}
        if actual != expected:
            raise ContractError("auth_session_status", f"{relative_path}: {actual}")

    base = load(repo / "values/services/auth.yaml")
    workers = sequence(base.get("workers"), "values/services/auth.yaml.workers")
    matching = [
        mapping(value, "values/services/auth.yaml.workers[]")
        for value in workers
        if mapping(value, "values/services/auth.yaml.workers[]").get("name") == "worker"
    ]
    if len(matching) != 1 or matching[0].get("command") != ["/app/worker"]:
        raise ContractError("auth_session_status", "auth worker command differs")
    worker_env = {
        scalar(mapping(value, "auth worker env[]").get("name"), "auth worker env[].name")
        for value in sequence(matching[0].get("env", []), "auth worker env")
    }
    duplicate_session_env = sorted(worker_env & SESSION_STATUS_ENV)
    if duplicate_session_env:
        raise ContractError(
            "auth_session_status",
            f"auth worker overrides inherited session status variables {duplicate_session_env}",
        )
    worker_template = (repo / "charts/medikong-service/templates/workers.yaml").read_text(
        encoding="utf-8"
    )
    inheritance_contract = (
        "$containerEnv := concat $observabilityEnv $root.Values.container.env "
        "(default (list) $worker.env)"
    )
    if inheritance_contract not in worker_template:
        raise ContractError("auth_session_status", "auth worker no longer inherits container.env")


def application_sources(application: dict[str, YamlValue]) -> list[dict[str, YamlValue]]:
    spec = mapping(application.get("spec"), "Application.spec")
    if "source" in spec:
        return [mapping(spec["source"], "Application.spec.source")]
    return [mapping(item, "Application.spec.sources[]") for item in sequence(spec.get("sources"), "Application.spec.sources")]


def validate_applications(repo: Path) -> None:
    target = "platform/istio/private-dev/routing-authz"
    private_refs = 0
    aws_refs = 0
    for path in (repo / "argo/applications/private-dev").glob("**/*.yaml"):
        private_refs += sum(source.get("path") == target for source in application_sources(load(path)))
    for path in (repo / "argo/applications/aws-dev").glob("**/*.yaml"):
        aws_refs += sum(source.get("path") == target for source in application_sources(load(path)))
    if (private_refs, aws_refs) != (1, 0):
        raise ContractError("environment_isolation", f"privateRefs={private_refs} awsRefs={aws_refs}")
    for service in ("catalog", "order", "payment", "notification"):
        application = load(repo / f"argo/applications/private-dev/services/{service}.yaml")
        chart_source = application_sources(application)[0]
        actual = sequence(mapping(chart_source.get("helm"), "Application helm").get("valueFiles"), "valueFiles")
        expected = [
            "$values/values/base.yaml",
            "$values/values/env/private-dev.yaml",
            f"$values/values/services/{service}.yaml",
            f"$values/values/services/private-dev/{service}.yaml",
            "$values/values/overrides/private-dev-ha-stable.yaml",
        ]
        if actual != expected:
            raise ContractError("application_values_order", f"{service}: {actual}")


def validate_network_policies(repo: Path) -> None:
    kong: YamlValue = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kong"}}}
    istio: YamlValue = {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "istio-system"}},
        "podSelector": {"matchLabels": {"app": "istio-ingressgateway", "istio": "ingressgateway"}},
    }
    for service, port in {"catalog": 8081, "order": 8082, "payment": 8083, "notification": 8084}.items():
        overlay = load(repo / f"values/services/private-dev/{service}.yaml")
        policy = mapping(overlay.get("networkPolicy"), f"{service}.networkPolicy")
        ingress = sequence(policy.get("ingress"), f"{service}.networkPolicy.ingress")
        if len(ingress) != 1:
            raise ContractError("network_policy", f"{service}: expected one ingress rule")
        rule = mapping(ingress[0], f"{service}.ingress[0]")
        peers = sequence(rule.get("from"), f"{service}.ingress[0].from")
        ports = sequence(rule.get("ports"), f"{service}.ingress[0].ports")
        if peers != [kong, istio] or ports != [{"protocol": "TCP", "port": port}]:
            raise ContractError("network_policy", f"{service}: Kong/Istio AND peer or TCP/{port} differs")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Task 9 private-dev Istio routing and security contracts.")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    repo = parser.parse_args().repo.resolve()
    try:
        expected = expected_routes(repo)
        _, protected = validate_routes(virtual_services(repo), expected)
        validate_policy(repo, protected)
        validate_provider(repo)
        validate_auth_session_status(repo)
        validate_applications(repo)
        validate_network_policies(repo)
    except ContractError as error:
        print(f"FAIL {error}")
        return 1
    print(f"PASS task9-istio-routing-authz: public={len(expected[0])} protected={len(expected[1])} networkPolicies=4 privateRefs=1 awsRefs=0 sessionStatus=private-dev")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
