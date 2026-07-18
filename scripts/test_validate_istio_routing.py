from __future__ import annotations

import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest
import yaml


REPO = Path(__file__).resolve().parents[1]
VALIDATOR = REPO / "scripts" / "validate-istio-routing.py"


@pytest.fixture
def repo_copy(tmp_path: Path) -> Path:
    for relative in ("platform", "values", "argo"):
        shutil.copytree(REPO / relative, tmp_path / relative)
    shutil.copytree(REPO / "charts/medikong-service", tmp_path / "charts/medikong-service")
    shutil.copytree(REPO / "scripts/fixtures", tmp_path / "scripts/fixtures")
    return tmp_path


def run_validator(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), "--repo", str(repo)],
        capture_output=True,
        check=False,
        text=True,
    )


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text(encoding="utf-8")
    assert source.count(old) == 1
    path.write_text(source.replace(old, new), encoding="utf-8")


def remove_custom_tuple(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/private-dev/routing-authz/ext-authz-policy.yaml",
        "    - to:\n        - operation:\n            methods:\n              - GET\n            paths:\n              - /notifications\n",
        "",
    )


def add_forbidden_route(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/private-dev/routing-authz/payment-virtualservice.yaml",
        "      match:\n",
        "      match:\n        - method:\n            exact: POST\n          uri:\n            exact: /payments/mock-failures\n",
    )


def omit_public_header(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/private-dev/routing-authz/catalog-virtualservice.yaml",
        "            - x-user-role\n            - x-user-email\n",
        "            - x-user-role\n",
    )


def remove_kong_peer(repo: Path) -> None:
    replace_once(
        repo / "values/services/private-dev/catalog.yaml",
        "        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: kong\n",
        "",
    )


def add_aws_reference(repo: Path) -> None:
    source = repo / "argo/applications/private-dev/platform/istio-routing-authz.yaml"
    target = repo / "argo/applications/aws-dev/platform/istio-routing-authz.yaml"
    target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def empty_route_list(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/private-dev/routing-authz/catalog-virtualservice.yaml",
        "      route:\n        - destination:\n            host: catalog-service.dropmong-catalog.svc.cluster.local\n            port:\n              number: 8081\n",
        "      route: []\n",
    )


def empty_policy_to(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/private-dev/routing-authz/ext-authz-policy.yaml",
        "    - to:\n        - operation:\n            methods:\n              - GET\n            paths:\n              - /api/v1/auth/context\n",
        "    - to: []\n",
    )


def malformed_inline_values(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/argocd/istiod.yaml",
        "      values: |\n",
        "      values: |\n        [unterminated\n",
    )


@pytest.mark.parametrize(
    ("mutate", "error_class"),
    [
        (remove_custom_tuple, "protected_custom_mismatch"),
        (add_forbidden_route, "forbidden_exposure"),
        (omit_public_header, "public_header_remove"),
        (remove_kong_peer, "network_policy"),
        (add_aws_reference, "environment_isolation"),
    ],
)
def test_validator_rejects_task9_regression_when_mutated(
    repo_copy: Path,
    mutate: Callable[[Path], None],
    error_class: str,
) -> None:
    # Given an isolated copy of the authored Task 9 desired state
    mutate(repo_copy)

    # When the focused validator checks the mutated copy
    result = run_validator(repo_copy)

    # Then it fails and identifies the violated contract class
    assert result.returncode != 0
    assert error_class in result.stdout


def test_validator_passes_when_current_task9_state_is_valid(repo_copy: Path) -> None:
    # Given an isolated copy of the current authored Task 9 desired state

    # When the focused validator checks the copy
    result = run_validator(repo_copy)

    # Then it emits an explicit successful summary
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS task9-istio-routing-authz" in result.stdout


@pytest.mark.parametrize("mutate", [empty_route_list, empty_policy_to, malformed_inline_values])
def test_validator_reports_malformed_input_without_source_leak_when_structure_is_invalid(
    repo_copy: Path,
    mutate: Callable[[Path], None],
) -> None:
    # Given an isolated desired-state copy with a malformed structural boundary
    mutate(repo_copy)

    # When the focused validator checks the malformed copy
    result = run_validator(repo_copy)

    # Then it fails safely without a traceback or raw malformed source
    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "malformed_input" in output
    assert "Traceback" not in output
    assert "[unterminated" not in output


def test_notification_monitoring_scrape_is_limited_to_prometheus_and_gateway_peers_remain(
    repo_copy: Path,
) -> None:
    # Given the private-dev Notification Helm value stack
    value_files = [
        "values/base.yaml",
        "values/env/private-dev.yaml",
        "values/services/notification.yaml",
        "values/services/private-dev/notification.yaml",
        "values/overrides/private-dev-ha-stable.yaml",
    ]
    command = ["helm", "template", "notification-private-dev", "charts/medikong-service"]
    for value_file in value_files:
        command.extend(["--values", value_file])

    # When Helm renders the service NetworkPolicy
    result = subprocess.run(command, capture_output=True, check=False, cwd=repo_copy, text=True)
    resources = list(yaml.safe_load_all(result.stdout))
    policies = [
        resource
        for resource in resources
        if resource is not None
        and resource.get("kind") == "NetworkPolicy"
        and resource.get("metadata", {}).get("name") == "allow-notification-service-ingress"
    ]

    # Then only Prometheus may scrape the API port, while gateway peers remain unchanged
    assert result.returncode == 0, result.stderr
    assert len(policies) == 1
    ingress = policies[0]["spec"]["ingress"]
    assert {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "monitoring"}},
        "podSelector": {
            "matchLabels": {
                "app.kubernetes.io/name": "prometheus",
                "operator.prometheus.io/name": "kube-prometheus-stack-prometheus",
            }
        },
    } in ingress[1]["from"]
    assert {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kong"}}
    } in ingress[0]["from"]
    assert {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "istio-system"}},
        "podSelector": {"matchLabels": {"app": "istio-ingressgateway", "istio": "ingressgateway"}},
    } in ingress[0]["from"]
