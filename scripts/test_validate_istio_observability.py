#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["PyYAML==6.0.2", "pytest==9.1.1"]
# ///

# ─── How to run ───
# 1. Install uv (if not installed):
#      curl -LsSf https://astral.sh/uv/install.sh | sh
# 2. Run from the GitOps repository root:
#      uv run pytest scripts/test_validate_istio_observability.py
# 3. Or run this file directly:
#      uv run scripts/test_validate_istio_observability.py
# ──────────────────

from __future__ import annotations

import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[1]
VALIDATOR = REPO / "scripts" / "validate-istio-observability.py"


@pytest.fixture
def repo_copy(tmp_path: Path) -> Path:
    for relative in (
        "platform/istio",
        "platform/monitoring",
        "values/env",
        "argo/applications/aws-dev/platform",
        "argo/applications/private-dev/platform",
    ):
        shutil.copytree(REPO / relative, tmp_path / relative)
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


def delete_envoy_filter(repo: Path) -> None:
    (repo / "platform/istio/gateway/request-id-response.yaml").unlink()


def widen_envoy_filter_scope(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/gateway/request-id-response.yaml",
        "    labels:\n      istio: ingressgateway\n",
        "    labels: {}\n",
    )
    mutated = (repo / "platform/istio/gateway/request-id-response.yaml").read_text(encoding="utf-8")
    assert "  workloadSelector:\n    labels: {}\n" in mutated


def remove_response_id_field(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/gateway/request-id-response.yaml",
        "            always_set_request_id_in_response: true\n",
        "",
    )


def remove_access_log(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/argocd/istiod.yaml",
        "          accessLogFile: /dev/stdout\n",
        "",
    )


def remove_sidecar_app(repo: Path) -> None:
    replace_once(
        repo / "platform/monitoring/manifests/istio-mesh-podmonitors.yaml",
        "          - coupon-service\n",
        "",
    )


def add_sidecar_app(repo: Path) -> None:
    replace_once(
        repo / "platform/monitoring/manifests/istio-mesh-podmonitors.yaml",
        "          - coupon-service\n",
        "          - coupon-service\n          - postgres\n",
    )


def remove_proxy_relabel(repo: Path) -> None:
    replace_once(
        repo / "platform/monitoring/manifests/istio-mesh-podmonitors.yaml",
        "      interval: 30s\n      relabelings:\n"
        "        - action: keep\n          sourceLabels:\n"
        "            - __meta_kubernetes_pod_container_name\n"
        "          regex: istio-proxy\n---\n",
        "      interval: 30s\n---\n",
    )


def remove_network_policy_port(repo: Path) -> None:
    replace_once(
        repo / "values/env/aws-dev.yaml",
        "    extraPorts:\n      - 15090\n",
        "    extraPorts: []\n",
    )


def remove_gateway_monitor(repo: Path) -> None:
    path = repo / "platform/monitoring/manifests/istio-mesh-podmonitors.yaml"
    source = path.read_text(encoding="utf-8")
    assert source.count("\n---\n") == 2
    path.write_text(source.rsplit("\n---\n", maxsplit=1)[0] + "\n", encoding="utf-8")


def remove_destination_reporter(repo: Path) -> None:
    path = repo / "platform/monitoring/dashboards/ops/03-gateway-mesh-metrics.json"
    source = path.read_text(encoding="utf-8")
    marker = ",reporter=\\\"destination\\\""
    assert source.count(marker) == 4
    path.write_text(source.replace(marker, "", 1), encoding="utf-8")


def restore_stale_dashboard_scope(repo: Path) -> None:
    path = repo / "platform/monitoring/dashboards/ops/03-gateway-mesh-metrics.json"
    source = path.read_text(encoding="utf-8")
    current = (
        "(dropmong-auth|dropmong-user|dropmong-catalog|dropmong-coupon|"
        "dropmong-interest|dropmong-order|dropmong-payment|dropmong-notification|dropmong-web)"
    )
    assert source.count(current) >= 1
    path.write_text(source.replace(current, "(dropmong-payment|dropmong-notification)", 1), encoding="utf-8")


def add_request_id_metric_label(repo: Path) -> None:
    path = repo / "platform/monitoring/dashboards/ops/03-gateway-mesh-metrics.json"
    source = path.read_text(encoding="utf-8")
    marker = ",reporter=\\\"destination\\\"}"
    assert source.count(marker) == 4
    replacement = ",request_id=~\\\"$request_id\\\",reporter=\\\"destination\\\"}"
    path.write_text(source.replace(marker, replacement, 1), encoding="utf-8")


def remove_documentation_marker(repo: Path) -> None:
    replace_once(
        repo / "platform/istio/README.md",
        "**Task 6 remains partial**",
        "Task 6 status pending",
    )


def restore_aws_kong_reference(repo: Path) -> None:
    replace_once(
        repo / "argo/applications/aws-dev/platform/istio.yaml",
        "    path: platform/istio\n",
        "    path: platform/kong\n",
    )


@pytest.mark.parametrize(
    ("mutate", "error_class"),
    [
        pytest.param(delete_envoy_filter, "gateway_filter_count", id="envoy-filter-deletion"),
        pytest.param(widen_envoy_filter_scope, "gateway_filter_scope", id="envoy-filter-scope"),
        pytest.param(remove_response_id_field, "gateway_request_id", id="response-id-field"),
        pytest.param(remove_access_log, "gateway_access_log", id="stdout-access-log"),
        pytest.param(remove_sidecar_app, "monitor_targets", id="missing-app-target"),
        pytest.param(add_sidecar_app, "monitor_targets", id="extra-app-target"),
        pytest.param(remove_proxy_relabel, "proxy_endpoint", id="proxy-relabel"),
        pytest.param(remove_network_policy_port, "monitoring_port", id="port-15090"),
        pytest.param(remove_gateway_monitor, "monitor_count", id="gateway-monitor"),
        pytest.param(remove_destination_reporter, "dashboard_reporter", id="destination-reporter"),
        pytest.param(restore_stale_dashboard_scope, "dashboard_scope", id="dashboard-scope"),
        pytest.param(add_request_id_metric_label, "dashboard_request_id_label", id="request-id-label"),
        pytest.param(remove_documentation_marker, "documentation_contract", id="documentation-marker"),
        pytest.param(restore_aws_kong_reference, "aws_kong_removal", id="aws-kong-reference"),
    ],
)
def test_validator_rejects_regression_when_contract_is_mutated(
    repo_copy: Path,
    mutate: Callable[[Path], None],
    error_class: str,
) -> None:
    # Given an isolated copy with exactly one Task 7 contract mutation
    mutate(repo_copy)

    # When the focused validator checks the mutated desired state
    result = run_validator(repo_copy)

    # Then it rejects the mutation with the stable violated contract class
    assert result.returncode != 0
    assert error_class in result.stdout
    assert "Traceback" not in result.stdout + result.stderr


def test_validator_passes_when_authored_observability_contract_is_valid(repo_copy: Path) -> None:
    # Given an isolated copy of the authored Task 7 desired state

    # When the focused validator checks the copy
    result = run_validator(repo_copy)

    # Then it emits an explicit successful static-contract summary
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS task7-istio-observability" in result.stdout


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
