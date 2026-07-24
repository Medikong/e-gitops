from __future__ import annotations

import copy
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest
import yaml


REPO = Path(__file__).resolve().parents[1]
VALIDATOR = REPO / "scripts" / "validate-aws-dev-grafana-renderer.rb"
FIXTURE = REPO / "scripts" / "fixtures" / "aws-grafana-renderer-valid.yaml"
PUBLIC_ROUTE_FIXTURE = REPO / "scripts" / "fixtures" / "aws-grafana-renderer-public-route.yaml"
DEFAULT_TOKEN_FIXTURE = REPO / "scripts" / "fixtures" / "aws-grafana-renderer-default-token.yaml"


def run_validator(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["ruby", str(VALIDATOR), *args],
        capture_output=True,
        check=False,
        cwd=REPO,
        text=True,
    )


def write_fixture(path: Path, document: dict) -> None:
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")


def load_fixture() -> dict:
    return yaml.safe_load(FIXTURE.read_text(encoding="utf-8"))


def test_current_aws_values_are_renderer_ready() -> None:
    result = run_validator("--repo", str(REPO))
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "PASS aws-dev Grafana renderer" in result.stdout


def test_valid_intended_fixture_passes() -> None:
    result = run_validator("--fixture", str(FIXTURE))
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS aws-dev Grafana renderer" in result.stdout


@pytest.mark.parametrize(
    ("fixture", "error_code"),
    [
        (PUBLIC_ROUTE_FIXTURE, "PUBLIC_RENDERER_ROUTE"),
        (DEFAULT_TOKEN_FIXTURE, "DEFAULT_RENDERER_TOKEN"),
    ],
)
def test_named_adversarial_fixtures_fail_closed(fixture: Path, error_code: str) -> None:
    result = run_validator("--fixture", str(fixture))
    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert error_code in output
    assert "PASS aws-dev Grafana renderer" not in output


Mutator = Callable[[dict], None]


def public_server_url(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"]["serverURL"] = "https://renderer.example.com/render"


def default_token(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"]["token"] = "-"


def missing_secret(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"].pop("existingSecret")


def mutable_image(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"]["image"]["tag"] = "latest"


def missing_resources(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"]["resources"]["limits"].pop("memory")


def missing_scheduling(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"]["nodeSelector"] = {}


def public_service(document: dict) -> None:
    document["values"]["grafana"]["imageRenderer"]["service"]["type"] = "LoadBalancer"


def public_route(document: dict) -> None:
    document["resources"].append(
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "Ingress",
            "metadata": {"name": "grafana-image-renderer-public", "namespace": "monitoring"},
            "spec": {
                "rules": [
                    {
                        "host": "renderer.example.com",
                        "http": {
                            "paths": [
                                {
                                    "path": "/",
                                    "pathType": "Prefix",
                                    "backend": {
                                        "service": {
                                            "name": "kube-prometheus-stack-grafana-image-renderer",
                                            "port": {"number": 8081},
                                        }
                                    },
                                }
                            ]
                        },
                    }
                ]
            },
        }
    )


def nonfixed_uids(document: dict) -> None:
    document["capture"]["uids"] = ["dropmong-ops-03-gateway-mesh"]


def nonfixed_window(document: dict) -> None:
    document["capture"]["window"]["to_ms"] += 1


def promoted_verdict(document: dict) -> None:
    document["capture"]["verdict"] = "PASS"


@pytest.mark.parametrize(
    ("mutate", "error_code"),
    [
        (public_server_url, "PUBLIC_RENDERER_ROUTE"),
        (default_token, "DEFAULT_RENDERER_TOKEN"),
        (missing_secret, "SECRET_REF_MISSING"),
        (mutable_image, "IMAGE_NOT_IMMUTABLE"),
        (missing_resources, "RESOURCE_BOUNDS"),
        (missing_scheduling, "SCHEDULING_BOUNDS"),
        (public_service, "PUBLIC_RENDERER_ROUTE"),
        (public_route, "PUBLIC_RENDERER_ROUTE"),
        (nonfixed_uids, "CAPTURE_UIDS"),
        (nonfixed_window, "CAPTURE_WINDOW"),
        (promoted_verdict, "EVIDENCE_VERDICT_PROMOTION"),
    ],
)
def test_copied_fixture_fails_closed_for_contract_regressions(
    tmp_path: Path,
    mutate: Mutator,
    error_code: str,
) -> None:
    fixture_path = tmp_path / "renderer.yaml"
    document = copy.deepcopy(load_fixture())
    mutate(document)
    write_fixture(fixture_path, document)

    result = run_validator("--fixture", str(fixture_path))
    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert error_code in output
    assert "PASS aws-dev Grafana renderer" not in output


def test_rendered_public_service_fails_without_secret_output(tmp_path: Path) -> None:
    fixture_path = tmp_path / "renderer.yaml"
    rendered_path = tmp_path / "rendered.yaml"
    write_fixture(fixture_path, load_fixture())
    resources = load_fixture()["resources"]
    for resource in resources:
        if resource["kind"] == "Service":
            resource["spec"]["type"] = "LoadBalancer"
    rendered_path.write_text(yaml.safe_dump_all(resources, sort_keys=False), encoding="utf-8")

    result = run_validator("--fixture", str(fixture_path), "--rendered", str(rendered_path))
    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "INTERNAL_SERVICE" in output
    assert "dropmong/aws-dev" not in output
