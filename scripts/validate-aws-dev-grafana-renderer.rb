#!/usr/bin/env ruby

require "optparse"
require "pathname"
require "uri"
require "yaml"

EXPECTED_CAPTURE_BASE_URL = "http://127.0.0.1:13000/grafana/"
EXPECTED_CAPTURE_UIDS = [
  "dropmong-ops-03-gateway-mesh",
  "dropmong-load-30-saturation",
  "dropmong-ops-10-kubernetes",
].freeze
EXPECTED_CAPTURE_FROM_MS = 1_784_879_925_000
EXPECTED_CAPTURE_TO_MS = 1_784_880_120_000
EXPECTED_EVIDENCE_VERDICT = "OBSERVABILITY_BLOCKED"
OBSERVABILITY_SELECTOR = {"medikong.io/workload" => "observability"}.freeze
OBSERVABILITY_TOLERATION = {
  "key" => "medikong.io/workload",
  "operator" => "Equal",
  "value" => "observability",
  "effect" => "NoSchedule",
}.freeze
ROUTE_KINDS = %w[
  Gateway
  GRPCRoute
  HTTPRoute
  Ingress
  TCPRoute
  TLSRoute
  UDPRoute
  VirtualService
].freeze
DEFAULT_RENDERER_TOKENS = %w[- default default-token default-renderer-token].freeze

class ContractError < StandardError
  attr_reader :code

  def initialize(code, message)
    @code = code
    super(message)
  end
end

def fail_contract(code, message)
  raise ContractError.new(code, message)
end

def mapping(value, label)
  return value if value.is_a?(Hash)

  fail_contract("MALFORMED_INPUT", "#{label} must be a mapping")
end

def load_yaml(path)
  YAML.safe_load(File.read(path, encoding: "utf-8"), aliases: true)
rescue Errno::ENOENT, Errno::EACCES, Psych::SyntaxError => error
  fail_contract("MALFORMED_INPUT", "#{path} is unreadable or malformed: #{error.message.lines.first.to_s.strip}")
end

def load_yaml_stream(path)
  YAML.safe_load_stream(File.read(path, encoding: "utf-8"), aliases: true).compact
rescue Errno::ENOENT, Errno::EACCES, Psych::SyntaxError => error
  fail_contract("MALFORMED_INPUT", "#{path} is unreadable or malformed: #{error.message.lines.first.to_s.strip}")
end

def read_yaml_files(root, glob)
  Dir.glob(root.join(glob).to_s).sort.flat_map do |path|
    load_yaml_stream(path)
  end
end

def deep_merge(left, right)
  return right unless left.is_a?(Hash) && right.is_a?(Hash)

  left.merge(right) do |_key, old_value, new_value|
    deep_merge(old_value, new_value)
  end
end

def contract_document(document)
  docs = if document.is_a?(Array)
           document
         else
           [document]
         end
  if docs.all? { |item| item.is_a?(Hash) && item["kind"] }
    return {"values" => {}, "resources" => docs, "external_secrets" => [], "routes" => [], "capture" => nil}
  end

  root = docs.first
  mapping(root, "fixture")
  root = root.fetch("contract", root) if root["contract"].is_a?(Hash)
  values = root["values"] || (root.key?("grafana") ? root : {})
  resources = root["resources"] || root["rendered"] || []
  external_secrets = root["external_secrets"] || root["externalSecrets"] || []
  routes = root["routes"] || []
  {
    "values" => mapping(values, "fixture values"),
    "resources" => Array(resources),
    "external_secrets" => Array(external_secrets),
    "routes" => Array(routes),
    "capture" => root["capture"],
  }
end

def load_fixture_contract(path)
  raw = load_yaml_stream(path)
  root = raw.first
  if root.is_a?(Hash) && nonempty_string(root["base_fixture"])
    base_path = Pathname.new(path).expand_path.dirname.join(root["base_fixture"])
    contract = load_fixture_contract(base_path)
    contract = deep_merge(contract, root["patch"] || {})
    contract["resources"] = contract.fetch("resources") + Array(root["append_resources"])
    contract["routes"] = contract.fetch("routes") + Array(root["append_routes"])
    return contract
  end

  contract_document(raw)
end

def repo_document(repo)
  values_path = repo.join("platform/monitoring/values/kube-prometheus-stack.yaml")
  values = mapping(load_yaml(values_path), values_path)
  external_secrets = read_yaml_files(repo, "platform/external-secrets/aws-dev/monitoring/**/*.{yaml,yml}")
  routes = read_yaml_files(repo, "platform/istio/aws-dev/routing/**/*.{yaml,yml}")
  {
    "values" => values,
    "resources" => [],
    "external_secrets" => external_secrets,
    "routes" => routes,
    "capture" => nil,
  }
end

def merge_resources(document, rendered_path)
  return document unless rendered_path

  rendered = load_yaml_stream(rendered_path)
  document.merge("resources" => rendered)
end

def string_value(value)
  value.is_a?(String) ? value : value.to_s
end

def nonempty_string(value)
  value.is_a?(String) && !value.strip.empty?
end

def uri_for(value, label)
  fail_contract("INTERNAL_URL", "#{label} must be a URL") unless nonempty_string(value)

  uri = URI.parse(value)
  fail_contract("INTERNAL_URL", "#{label} must not contain credentials, query, or fragment") if uri.userinfo || uri.query || uri.fragment
  fail_contract("INTERNAL_URL", "#{label} must include a host") unless nonempty_string(uri.host)
  uri
rescue URI::InvalidURIError => error
  fail_contract("INTERNAL_URL", "#{label} is malformed: #{error.message}")
end

def assert_internal_url(value, label, path)
  uri = uri_for(value, label)
  fail_contract("PUBLIC_RENDERER_ROUTE", "#{label} must use a monitoring ClusterIP host") unless %w[http https].include?(uri.scheme)
  host = uri.host.to_s.downcase
  internal_host = host.match?(/\A[a-z0-9]([a-z0-9-]*[a-z0-9])?\.monitoring\.svc(?:\.cluster\.local)?\z/)
  fail_contract("PUBLIC_RENDERER_ROUTE", "#{label} must stay inside the monitoring namespace") unless internal_host
  fail_contract("INTERNAL_URL", "#{label} must use #{path}") unless uri.path == path
  value
end

def assert_loopback_capture_url(value)
  uri = uri_for(value, "capture.base_url")
  fail_contract("CAPTURE_BASE_URL", "capture.base_url must be exactly #{EXPECTED_CAPTURE_BASE_URL}") unless value == EXPECTED_CAPTURE_BASE_URL
  fail_contract("CAPTURE_BASE_URL", "capture.base_url must be loopback HTTP") unless uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == 13_000
  fail_contract("CAPTURE_BASE_URL", "capture.base_url must end with /grafana/") unless uri.path == "/grafana/"
end

def assert_secret_ref(value, label, expected_name: nil, expected_key: nil)
  ref = mapping(value, label)
  secret = ref["secretKeyRef"] || ref["secret_key_ref"]
  fail_contract("SECRET_REF_MISSING", "#{label} must use secretKeyRef") unless secret.is_a?(Hash)
  name = secret["name"]
  key = secret["key"]
  fail_contract("SECRET_REF_MISSING", "#{label} secret name is missing") unless nonempty_string(name)
  fail_contract("SECRET_REF_MISSING", "#{label} secret key is missing") unless nonempty_string(key)
  fail_contract("SECRET_REF_MISMATCH", "#{label} secret name differs") if expected_name && name != expected_name
  fail_contract("SECRET_REF_MISMATCH", "#{label} secret key differs") if expected_key && key != expected_key
  [name, key]
end

def assert_non_default_token(value, label)
  return if value.nil? || (value.is_a?(String) && value.strip.empty?)

  if !value.is_a?(Hash) && DEFAULT_RENDERER_TOKENS.include?(value.to_s.strip.downcase)
    fail_contract("DEFAULT_RENDERER_TOKEN", "#{label} uses a default renderer token")
  end
  fail_contract("TOKEN_LITERAL", "#{label} must not contain a literal token") unless value.is_a?(Hash)
end

def image_string(image)
  return image if image.is_a?(String)
  image = mapping(image, "renderer.image")
  registry = image["registry"]
  repository = image["repository"]
  tag = image["tag"]
  sha = image["sha"]
  fail_contract("IMAGE_NOT_IMMUTABLE", "renderer.image repository is missing") unless nonempty_string(repository)
  identifier = "#{registry}/#{repository}".sub(%r{\A/}, "")
  identifier += ":#{tag}" if nonempty_string(tag)
  identifier += "@sha256:#{sha}" if nonempty_string(sha)
  identifier
end

def assert_immutable_image(image)
  value = image_string(image)
  repository, digest = value.split("@sha256:", 2)
  repository_name = repository.split(":", 2).first
  if digest
    fail_contract("IMAGE_NOT_IMMUTABLE", "renderer.image digest must be sha256") unless digest.match?(/\A[0-9a-f]{64}\z/i)
  else
    tag = repository.split(":", 2).last
    fail_contract("IMAGE_NOT_IMMUTABLE", "renderer.image must include a pinned tag or digest") unless nonempty_string(tag)
    fail_contract("IMAGE_NOT_IMMUTABLE", "renderer.image tag #{tag.inspect} is mutable") if %w[latest stable edge dev main master].include?(tag.downcase)
    fail_contract("IMAGE_NOT_IMMUTABLE", "renderer.image tag #{tag.inspect} is not a version") unless tag.match?(/\Av?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\z/)
  end
  fail_contract("IMAGE_NOT_IMMUTABLE", "renderer.image must be grafana/grafana-image-renderer") unless repository_name.match?(%r{(?:^|/)grafana-image-renderer\z})
  value
end

def quantity(value, kind, label)
  text = value.to_s.strip
  fail_contract("RESOURCE_BOUNDS", "#{label} is missing") if text.empty?
  case kind
  when :cpu
    if (match = text.match(/\A(\d+(?:\.\d+)?)m\z/))
      match[1].to_f / 1_000
    elsif text.match?(/\A\d+(?:\.\d+)?\z/)
      text.to_f
    else
      fail_contract("RESOURCE_BOUNDS", "#{label} has an invalid CPU quantity")
    end
  when :memory
    units = {"Ki" => 1024, "Mi" => 1024**2, "Gi" => 1024**3, "Ti" => 1024**4, "K" => 1000, "M" => 1000**2, "G" => 1000**3}
    if text.match?(/\A\d+(?:\.\d+)?\z/)
      text.to_f
    elsif (match = text.match(/\A(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G)\z/))
      match[1].to_f * units.fetch(match[2])
    else
      fail_contract("RESOURCE_BOUNDS", "#{label} has an invalid memory quantity")
    end
  end
end

def assert_resources(resources)
  resources = mapping(resources, "renderer.resources")
  requests = mapping(resources["requests"], "renderer.resources.requests")
  limits = mapping(resources["limits"], "renderer.resources.limits")
  %w[cpu memory].each do |name|
    request = quantity(requests[name], name == "cpu" ? :cpu : :memory, "renderer.resources.requests.#{name}")
    limit = quantity(limits[name], name == "cpu" ? :cpu : :memory, "renderer.resources.limits.#{name}")
    fail_contract("RESOURCE_BOUNDS", "renderer #{name} request must not exceed limit") unless request.positive? && limit >= request
    max = name == "cpu" ? 2.0 : 4 * 1024**3
    fail_contract("RESOURCE_BOUNDS", "renderer #{name} limit is unbounded") if limit > max
  end
end

def assert_scheduling(renderer)
  selector = renderer["nodeSelector"] || renderer["node_selector"]
  fail_contract("SCHEDULING_BOUNDS", "renderer nodeSelector must target observability") unless selector == OBSERVABILITY_SELECTOR
  tolerations = renderer["tolerations"]
  tolerations = [] unless tolerations.is_a?(Array)
  normalized = tolerations.map do |item|
    if item.is_a?(Hash)
      item.slice("key", "operator", "value", "effect").tap { |toleration| toleration["operator"] ||= "Equal" }
    else
      item
    end
  end
  unless normalized.include?(OBSERVABILITY_TOLERATION)
    fail_contract("SCHEDULING_BOUNDS", "renderer tolerations must allow the observability workload taint")
  end
end

def target_secret_name(external_secret)
  external_secret.dig("spec", "target", "name") || external_secret.dig("target", "name") || external_secret["targetName"]
end

def assert_external_secret(external_secrets, secret_name)
  candidates = external_secrets.select { |item| target_secret_name(item) == secret_name }
  fail_contract("SECRET_REF_MISSING", "no AWS ExternalSecret targets #{secret_name.inspect}") unless candidates.length == 1
  external_secret = candidates.first
  namespace = external_secret.dig("metadata", "namespace")
  fail_contract("SECRET_REF_MISSING", "renderer ExternalSecret must be in monitoring") unless namespace == "monitoring"
  data = Array(external_secret.dig("spec", "data") || external_secret["data"])
  token_mapping = data.find { |item| item.is_a?(Hash) && item["secretKey"] == "token" }
  fail_contract("SECRET_REF_MISSING", "renderer ExternalSecret must provide the token key") unless token_mapping
  remote_ref = token_mapping["remoteRef"] || token_mapping["remote_ref"]
  fail_contract("SECRET_REF_MISSING", "renderer ExternalSecret token must use remoteRef") unless remote_ref.is_a?(Hash) && nonempty_string(remote_ref["key"])
  target = external_secret.dig("spec", "target") || external_secret["target"] || {}
  fail_contract("TOKEN_LITERAL", "renderer ExternalSecret must not embed token data") if target["template"].to_s.match?(/token\s*:/i)
  external_secret
end

def recursive_text(value)
  case value
  when Hash
    value.map { |key, item| "#{key}=#{recursive_text(item)}" }.join(" ")
  when Array
    value.map { |item| recursive_text(item) }.join(" ")
  else
    value.to_s
  end
end

def resource_identity(resource)
  [resource["kind"], resource.dig("metadata", "name"), resource.dig("metadata", "namespace")]
end

def renderer_resource?(resource, service_name)
  text = recursive_text(resource).downcase
  text.include?(service_name.downcase) || text.match?(%r{grafana[-_]?image[-_]?renderer})
end

def renderer_workload?(resource)
  name = resource.dig("metadata", "name").to_s.downcase
  labels = resource.dig("metadata", "labels") || {}
  name.match?(%r{grafana[-_]?image[-_]?renderer}) || labels.values.any? { |value| value.to_s.downcase.match?(%r{grafana[-_]?image[-_]?renderer}) }
end

def assert_rendered_resources(resources, service_name, secret_name)
  return if resources.empty?

  renderer_services = resources.select do |resource|
    resource["kind"] == "Service" && renderer_workload?(resource)
  end
  renderer_deployments = resources.select do |resource|
    resource["kind"] == "Deployment" && renderer_workload?(resource)
  end
  unless renderer_services.empty?
    fail_contract("INTERNAL_SERVICE", "expected exactly one renderer Service") unless renderer_services.length == 1
    service = renderer_services.first
    fail_contract("INTERNAL_SERVICE", "renderer Service must be in monitoring") unless service.dig("metadata", "namespace") == "monitoring"
    fail_contract("INTERNAL_SERVICE", "renderer Service must be ClusterIP") unless service.dig("spec", "type").to_s.empty? || service.dig("spec", "type") == "ClusterIP"
    fail_contract("PUBLIC_RENDERER_ROUTE", "renderer Service must not expose node or external addresses") if service.dig("spec", "type") == "NodePort" || Array(service.dig("spec", "externalIPs")).any? || nonempty_string(service.dig("spec", "loadBalancerIP"))
  end
  unless renderer_deployments.empty?
    fail_contract("RENDERER_DEPLOYMENT", "expected exactly one renderer Deployment") unless renderer_deployments.length == 1
    deployment = renderer_deployments.first
    fail_contract("RENDERER_DEPLOYMENT", "renderer Deployment must be in monitoring") unless deployment.dig("metadata", "namespace") == "monitoring"
    replicas = deployment.dig("spec", "replicas")
    fail_contract("RESOURCE_BOUNDS", "renderer replicas must be one or two") unless replicas.is_a?(Integer) && replicas.between?(1, 2)
    pod_spec = deployment.dig("spec", "template", "spec")
    mapping(pod_spec, "renderer Deployment pod spec")
    assert_scheduling(pod_spec)
    containers = Array(pod_spec["containers"])
    container = containers.find { |item| recursive_text(item).downcase.match?(%r{grafana[-_]?image[-_]?renderer}) } || containers.first
    fail_contract("RENDERER_DEPLOYMENT", "renderer Deployment has no container") unless container.is_a?(Hash)
    assert_immutable_image(container["image"])
    assert_resources(container["resources"])
    token_env = Array(container["env"]).find { |item| item.is_a?(Hash) && %w[AUTH_TOKEN GF_RENDERING_RENDERER_TOKEN].include?(item["name"]) }
    assert_secret_ref(token_env && token_env["valueFrom"], "renderer token environment", expected_name: secret_name, expected_key: "token")
  end
  resources.each do |resource|
    next unless ROUTE_KINDS.include?(resource["kind"])
    next unless renderer_resource?(resource, service_name)

    fail_contract("PUBLIC_RENDERER_ROUTE", "#{resource["kind"]} #{resource.dig("metadata", "name")} references the renderer")
  end
end

def assert_values(values, external_secrets, resources, routes, capture, capture_required)
  grafana = mapping(values["grafana"], "grafana values")
  image_renderer = grafana["imageRenderer"]
  fail_contract("RENDERER_NOT_CONFIGURED", "AWS Grafana imageRenderer is not enabled") unless image_renderer.is_a?(Hash) && image_renderer["enabled"] == true

  root_url = grafana.dig("grafana.ini", "server", "root_url")
  fail_contract("GRAFANA_SUBPATH", "Grafana root_url must end with /grafana/") unless nonempty_string(root_url) && uri_for(root_url, "grafana.ini.server.root_url").path == "/grafana/"
  fail_contract("GRAFANA_SUBPATH", "Grafana serve_from_sub_path must be true") unless grafana.dig("grafana.ini", "server", "serve_from_sub_path") == true

  server_url = image_renderer["serverURL"] || image_renderer["server_url"]
  callback_url = image_renderer["renderingCallbackURL"] || image_renderer["rendering_callback_url"]
  assert_internal_url(server_url, "grafana.imageRenderer.serverURL", "/render")
  assert_internal_url(callback_url, "grafana.imageRenderer.renderingCallbackURL", "/grafana/")

  secret_name = image_renderer["existingSecret"] || image_renderer["existing_secret"]
  fail_contract("SECRET_REF_MISSING", "grafana.imageRenderer.existingSecret is required") unless nonempty_string(secret_name)
  assert_external_secret(external_secrets, secret_name)

  assert_non_default_token(image_renderer["token"], "grafana.imageRenderer.token")
  env_value_from = image_renderer["envValueFrom"] || image_renderer["env_value_from"] || {}
  auth_ref = env_value_from["AUTH_TOKEN"] || env_value_from["GF_RENDERING_RENDERER_TOKEN"]
  if auth_ref
    assert_secret_ref(auth_ref, "grafana.imageRenderer.envValueFrom", expected_name: secret_name, expected_key: "token")
  end

  image = image_renderer["image"]
  assert_immutable_image(image)
  replicas = image_renderer["replicas"]
  fail_contract("RESOURCE_BOUNDS", "grafana.imageRenderer.replicas must be one or two") unless replicas.is_a?(Integer) && replicas.between?(1, 2)
  autoscaling = image_renderer["autoscaling"]
  fail_contract("RESOURCE_BOUNDS", "grafana.imageRenderer.autoscaling must be disabled") if autoscaling.is_a?(Hash) && autoscaling["enabled"] == true
  assert_resources(image_renderer["resources"])
  assert_scheduling(image_renderer)

  service = image_renderer["service"] || {}
  fail_contract("INTERNAL_SERVICE", "grafana.imageRenderer.service must be enabled") if service.is_a?(Hash) && service["enabled"] == false
  service_type = service.is_a?(Hash) ? service["type"] : nil
  fail_contract("PUBLIC_RENDERER_ROUTE", "renderer Service must be ClusterIP") if service_type && service_type != "ClusterIP"
  fail_contract("PUBLIC_RENDERER_ROUTE", "renderer Service must not configure external addresses") if service.is_a?(Hash) && (Array(service["externalIPs"]).any? || nonempty_string(service["loadBalancerIP"]) || service.key?("nodePort"))
  network_policy = image_renderer["networkPolicy"] || {}
  fail_contract("PUBLIC_RENDERER_ROUTE", "renderer NetworkPolicy must limit ingress to Grafana") if network_policy.is_a?(Hash) && network_policy.key?("limitIngress") && network_policy["limitIngress"] != true
  %w[ingress gateway route].each do |name|
    option = image_renderer[name]
    fail_contract("PUBLIC_RENDERER_ROUTE", "renderer #{name} route is not allowed") if option.is_a?(Hash) && option["enabled"] == true
  end

  service_name = image_renderer["serviceName"] || image_renderer["service_name"] || "grafana-image-renderer"
  assert_rendered_resources(resources, service_name, secret_name)
  routes.each do |route|
    next unless route.is_a?(Hash)
    next unless ROUTE_KINDS.include?(route["kind"])
    next unless renderer_resource?(route, service_name)

    fail_contract("PUBLIC_RENDERER_ROUTE", "#{route["kind"]} #{route.dig("metadata", "name")} references the renderer")
  end

  return unless capture_required || capture

  capture = mapping(capture, "capture")
  assert_loopback_capture_url(capture["base_url"] || capture["baseUrl"])
  uids = capture["uids"] || capture["dashboard_uids"]
  fail_contract("CAPTURE_UIDS", "capture UIDs must be the fixed Scenario 04 set") unless uids == EXPECTED_CAPTURE_UIDS
  window = capture["window"] || capture["time_range"] || {}
  from_ms = window["from_ms"] || window["fromMs"] || window["start_ms"]
  to_ms = window["to_ms"] || window["toMs"] || window["end_ms"]
  fail_contract("CAPTURE_WINDOW", "capture UTC window must be the fixed Scenario 04 interval") unless from_ms == EXPECTED_CAPTURE_FROM_MS && to_ms == EXPECTED_CAPTURE_TO_MS
  verdict = capture["verdict"] || capture["evidence_verdict"]
  fail_contract("EVIDENCE_VERDICT_PROMOTION", "capture evidence verdict must remain #{EXPECTED_EVIDENCE_VERDICT}") unless verdict == EXPECTED_EVIDENCE_VERDICT
end

options = {
  repo: ENV.fetch("REPO", Dir.pwd),
  fixture: nil,
  rendered: nil,
  require_capture: false,
}
OptionParser.new do |parser|
  parser.banner = "Usage: validate-aws-dev-grafana-renderer.rb [--repo PATH] [--fixture PATH] [--rendered PATH] [--require-capture]"
  parser.on("--repo PATH", "Repository root (default: REPO or current directory)") { |value| options[:repo] = value }
  parser.on("--fixture PATH", "Contract fixture YAML") { |value| options[:fixture] = value }
  parser.on("--config PATH", "Alias for --fixture") { |value| options[:fixture] = value }
  parser.on("--rendered PATH", "Rendered Kubernetes YAML stream") { |value| options[:rendered] = value }
  parser.on("--require-capture", "Require fixed capture metadata in the input") { options[:require_capture] = true }
end.parse!

begin
  document = if options[:fixture]
               load_fixture_contract(options[:fixture])
             else
               repo_document(Pathname.new(options[:repo]).expand_path)
             end
  document = merge_resources(document, options[:rendered])
  assert_values(
    document.fetch("values"),
    document.fetch("external_secrets"),
    document.fetch("resources"),
    document.fetch("routes"),
    document["capture"],
    options[:require_capture],
  )
rescue ContractError => error
  warn "FAIL aws-dev Grafana renderer [#{error.code}]: #{error.message}"
  exit 2
rescue NoMethodError, TypeError, Psych::SyntaxError => error
  warn "FAIL aws-dev Grafana renderer [MALFORMED_INPUT]: #{error.message.lines.first.to_s.strip}"
  exit 2
end

puts "PASS aws-dev Grafana renderer: internal ClusterIP, Secret-backed token, immutable image, bounded resources/scheduling, no public renderer route"
