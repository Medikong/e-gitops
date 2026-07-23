#!/usr/bin/env ruby

require "digest"
require "open3"
require "pathname"
require "yaml"

SHARED_VIRTUAL_SERVICE_SHA256 = "7cf27d78e97221693035787eab511b00848fc7a10bb833848e493d61eaef9742"

class ContractError < StandardError; end

def assert_contract(condition, message)
  raise ContractError, message unless condition
end

def render(kubectl, path)
  stdout, stderr, status = Open3.capture3(kubectl, "kustomize", path.to_s)
  raise ContractError, "kubectl kustomize #{path} failed: #{stderr.strip}" unless status.success?

  YAML.safe_load_stream(stdout, aliases: true).compact
rescue Psych::SyntaxError => error
  raise ContractError, "kubectl kustomize #{path} emitted malformed YAML: #{error.message}"
end

def resource(resources, kind, name, namespace)
  matches = resources.select do |candidate|
    candidate["kind"] == kind &&
      candidate.dig("metadata", "name") == name &&
      candidate.dig("metadata", "namespace") == namespace
  end
  assert_contract(matches.length == 1, "expected exactly one #{kind} #{namespace}/#{name}, found #{matches.length}")
  matches.first
end

def normalized_sha256(path)
  Digest::SHA256.hexdigest(File.binread(path).gsub("\r\n", "\n"))
end

repo = Pathname.new(ENV.fetch("REPO", Dir.pwd)).expand_path
kubectl = ENV.fetch("KUBECTL", "kubectl")

begin
  shared_virtual_service_path = repo / "platform/istio/aws-dev/routing/virtualservice.yaml"
  assert_contract(
    normalized_sha256(shared_virtual_service_path) == SHARED_VIRTUAL_SERVICE_SHA256,
    "existing medikong-aws-dev VirtualService content changed",
  )

  platform = render(kubectl, repo / "platform/istio")
  application = resource(platform, "Application", "istio-grafana-ingressgateway", "argocd")
  assert_contract(application.dig("metadata", "annotations", "argocd.argoproj.io/sync-wave") == "-5", "gateway sync wave must be -5")
  source = application.dig("spec", "source")
  assert_contract(source["repoURL"] == "https://istio-release.storage.googleapis.com/charts", "gateway chart repository differs")
  assert_contract(source["chart"] == "gateway", "gateway chart must be gateway")
  assert_contract(source["targetRevision"] == "1.30.0", "gateway chart version must match the existing gateway")
  assert_contract(source.dig("helm", "releaseName") == "istio-grafana-ingressgateway", "gateway Helm release name differs")

  values = YAML.safe_load(source.dig("helm", "values"), aliases: true)
  assert_contract(values["name"] == "istio-grafana-ingressgateway", "gateway workload name differs")
  assert_contract(
    values["labels"] == {
      "app" => "istio-grafana-ingressgateway",
      "istio" => "grafana-ingressgateway",
    },
    "gateway workload labels are not dedicated to Grafana",
  )
  assert_contract(values["replicaCount"] == 1, "gateway must have one replica")
  assert_contract(values.dig("autoscaling", "enabled") == false, "gateway autoscaling must be disabled")
  assert_contract(values.dig("service", "type") == "NodePort", "gateway Service must be NodePort")

  ports = values.dig("service", "ports")
  expected_ports = [
    {
      "name" => "status-port",
      "port" => 15_021,
      "protocol" => "TCP",
      "targetPort" => 15_021,
      "nodePort" => 31_836,
    },
    {
      "name" => "http2",
      "port" => 80,
      "protocol" => "TCP",
      "targetPort" => 80,
      "nodePort" => 32_081,
    },
  ]
  assert_contract(ports == expected_ports, "gateway Service ports must be exactly status 31836 and HTTP 32081")
  assert_contract(!values.dig("service").key?("loadBalancerIP"), "gateway Service must not configure a load balancer")

  routing = render(kubectl, repo / "platform/istio/aws-dev/routing")
  expected_identities = [
    ["Gateway", "grafana-public", "istio-system"],
    ["VirtualService", "grafana-public-aws-dev", "istio-system"],
    ["VirtualService", "medikong-aws-dev", "istio-system"],
  ]
  actual_identities = routing.map do |candidate|
    [candidate["kind"], candidate.dig("metadata", "name"), candidate.dig("metadata", "namespace")]
  end.sort
  assert_contract(actual_identities == expected_identities.sort, "AWS routing resource set differs: #{actual_identities.inspect}")

  gateway = resource(routing, "Gateway", "grafana-public", "istio-system")
  assert_contract(gateway.dig("spec", "selector") == {"istio" => "grafana-ingressgateway"}, "Gateway selector is not Grafana-only")
  assert_contract(
    gateway.dig("spec", "servers") == [
      {
        "port" => {"number" => 80, "name" => "http", "protocol" => "HTTP"},
        "hosts" => ["*"],
      },
    ],
    "Gateway server must be exactly HTTP/80",
  )

  grafana_route = resource(routing, "VirtualService", "grafana-public-aws-dev", "istio-system")
  assert_contract(grafana_route.dig("spec", "hosts") == ["*"], "Grafana VirtualService hosts differ")
  assert_contract(grafana_route.dig("spec", "gateways") == ["grafana-public"], "Grafana VirtualService must bind only grafana-public")
  assert_contract(
    grafana_route.dig("spec", "http") == [
      {
        "name" => "grafana",
        "match" => [{"uri" => {"prefix" => "/grafana"}}],
        "route" => [
          {
            "destination" => {
              "host" => "kube-prometheus-stack-grafana.monitoring.svc.cluster.local",
              "port" => {"number" => 80},
            },
          },
        ],
      },
    ],
    "Grafana VirtualService must preserve the exact /grafana prefix and destination",
  )

  shared_route = resource(routing, "VirtualService", "medikong-aws-dev", "istio-system")
  assert_contract(shared_route.dig("spec", "gateways") == ["medikong-internal"], "shared application gateway binding changed")

  dedicated_text = YAML.dump_stream(application, values, gateway, grafana_route)
  assert_contract(!dedicated_text.include?("medikong-internal"), "dedicated Grafana resources reference the shared gateway")
  assert_contract(!dedicated_text.match?(/\b32080\b/), "dedicated Grafana resources reference shared NodePort 32080")
  %w[/ /auth /orders /__debug].each do |path|
    assert_contract(
      grafana_route.dig("spec", "http").none? { |route| route.dig("match", 0, "uri", "prefix") == path },
      "dedicated Grafana VirtualService exposes #{path}",
    )
  end

  monitoring = render(kubectl, repo / "platform/monitoring-aws-dev")
  grafana_ingresses = monitoring.select do |candidate|
    candidate["kind"] == "Ingress" && candidate.dig("metadata", "name") == "grafana"
  end
  assert_contract(grafana_ingresses.empty?, "AWS overlay restored the old Kong Grafana Ingress")
rescue ContractError, Psych::SyntaxError, TypeError, NoMethodError => error
  warn "FAIL aws-dev Grafana Istio isolation: #{error.message}"
  exit 2
end

puts "PASS aws-dev Grafana Istio isolation: nodePorts=31836,32081 route=/grafana destination=monitoring/grafana sharedRoute=unchanged kongIngress=absent"
