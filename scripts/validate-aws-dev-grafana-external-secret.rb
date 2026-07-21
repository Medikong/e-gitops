#!/usr/bin/env ruby

require "yaml"

def load_yaml(path)
  YAML.safe_load(File.read(path), aliases: true)
end

def load_yaml_stream(path)
  YAML.load_stream(File.read(path))
end

def assert_equal(label, actual, expected)
  return if actual == expected

  warn "#{label} mismatch: expected=#{expected.inspect} actual=#{actual.inspect}"
  exit 2
end

{
  "namespaces.yaml" => "-40",
  "external-secrets.yaml" => "-35",
  "external-secrets-monitoring-config.yaml" => "-34",
  "monitoring.yaml" => "-20",
}.each do |name, expected_wave|
  path = "argo/applications/aws-dev/platform/#{name}"
  actual_wave = load_yaml(path).dig("metadata", "annotations", "argocd.argoproj.io/sync-wave")
  assert_equal("#{path} sync wave", actual_wave, expected_wave)
end

external_secrets_app = load_yaml("argo/applications/aws-dev/platform/external-secrets.yaml")
external_secrets_values = YAML.safe_load(external_secrets_app.dig("spec", "source", "helm", "values"), aliases: true)
assert_equal("ESO chart version", external_secrets_app.dig("spec", "source", "targetRevision"), "2.8.0")
assert_equal("ESO scoped namespace", external_secrets_values["scopedNamespace"], nil)
assert_equal("ESO scoped RBAC", external_secrets_values["scopedRBAC"], nil)
%w[
  processClusterExternalSecret
  processClusterGenerator
  processClusterPushSecret
  processClusterStore
  processPushSecret
].each do |setting|
  assert_equal("ESO #{setting}", external_secrets_values[setting], false)
end

namespace_names = load_yaml_stream("platform/namespaces/namespaces.yaml").filter_map do |document|
  document.dig("metadata", "name") if document["kind"] == "Namespace"
end
unless namespace_names.include?("monitoring") && namespace_names.include?("external-secrets")
  warn "platform/namespaces must create monitoring and external-secrets before ESO configuration"
  exit 2
end

monitoring_resources = load_yaml("platform/monitoring/kustomization.yaml").fetch("resources")
if monitoring_resources.include?("manifests/namespace.yaml")
  warn "The shared namespace Application, not monitoring, must own the monitoring namespace"
  exit 2
end

monitoring_store = load_yaml("platform/external-secrets/aws-dev/monitoring/secret-store.yaml")
assert_equal("monitoring SecretStore namespace", monitoring_store.dig("metadata", "namespace"), "monitoring")
unless monitoring_store.dig("spec", "provider", "aws", "role").end_with?("/medikong-dev-external-secrets-grafana-role")
  warn "The monitoring SecretStore must assume the dedicated Grafana IAM role"
  exit 2
end

grafana_external_secret = load_yaml("platform/external-secrets/aws-dev/monitoring/grafana-admin-credentials.yaml")
{
  "namespace" => [grafana_external_secret.dig("metadata", "namespace"), "monitoring"],
  "source key" => [grafana_external_secret.dig("spec", "data", 0, "remoteRef", "key"), "dropmong/aws-dev/monitoring/grafana-admin"],
  "admin user property" => [grafana_external_secret.dig("spec", "data", 0, "remoteRef", "property"), "admin-user"],
  "admin password property" => [grafana_external_secret.dig("spec", "data", 1, "remoteRef", "property"), "admin-password"],
  "target Secret" => [grafana_external_secret.dig("spec", "target", "name"), "grafana-admin-credentials"],
  "refresh policy" => [grafana_external_secret.dig("spec", "refreshPolicy"), "CreatedOnce"],
  "creation policy" => [grafana_external_secret.dig("spec", "target", "creationPolicy"), "Owner"],
  "deletion policy" => [grafana_external_secret.dig("spec", "target", "deletionPolicy"), "Retain"],
  "immutable target" => [grafana_external_secret.dig("spec", "target", "immutable"), true],
}.each do |label, values|
  assert_equal("Grafana ExternalSecret #{label}", values[0], values[1])
end

readiness_job = load_yaml("platform/external-secrets/aws-dev/monitoring/readiness-job.yaml")
{
  "hook" => [readiness_job.dig("metadata", "annotations", "argocd.argoproj.io/hook"), "PostSync"],
  "hook wave" => [readiness_job.dig("metadata", "annotations", "argocd.argoproj.io/sync-wave"), "2"],
  "service account" => [readiness_job.dig("spec", "template", "spec", "serviceAccountName"), "grafana-external-secret-readiness"],
  "kubectl image" => [readiness_job.dig("spec", "template", "spec", "containers", 0, "image"), "registry.k8s.io/kubectl:v1.34.0"],
}.each do |label, values|
  assert_equal("Grafana readiness #{label}", values[0], values[1])
end

readiness_pod_spec = readiness_job.dig("spec", "template", "spec")
readiness_commands = Array(readiness_pod_spec["initContainers"]).filter_map do |container|
  next unless container["command"] == ["kubectl"]

  container["args"]
end
readiness_commands << readiness_pod_spec.dig("containers", 0, "args")

unless readiness_commands.include?([
    "wait",
    "--for=condition=Ready",
    "secretstore/aws-secrets-manager",
    "--namespace=monitoring",
    "--timeout=240s",
  ]) && readiness_commands.include?([
    "wait",
    "--for=condition=Ready",
    "externalsecret/grafana-admin-credentials",
    "--namespace=monitoring",
    "--timeout=240s",
  ]) && readiness_commands.include?([
    "get",
    "secret",
    "grafana-admin-credentials",
    "--namespace=monitoring",
    "--output=name",
  ])
  warn "Grafana readiness Job must wait for the store, ExternalSecret, and generated Secret"
  exit 2
end

monitoring_values = load_yaml("platform/monitoring/values/kube-prometheus-stack.yaml")
{
  "existing Secret" => [monitoring_values.dig("grafana", "admin", "existingSecret"), "grafana-admin-credentials"],
  "admin user key" => [monitoring_values.dig("grafana", "admin", "userKey"), "admin-user"],
  "admin password key" => [monitoring_values.dig("grafana", "admin", "passwordKey"), "admin-password"],
}.each do |label, values|
  assert_equal("Grafana #{label}", values[0], values[1])
end

puts "PASS aws-dev Grafana External Secret contracts"
