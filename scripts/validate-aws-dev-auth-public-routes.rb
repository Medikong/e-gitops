#!/usr/bin/env ruby

require "digest"
require "json"
require "open3"
require "pathname"
require "yaml"

AUTH_HOST = "auth-service.dropmong-auth.svc.cluster.local"
PUBLIC_ROUTE_NAME = "public-auth-entrypoints"
PUBLIC_PATHS = [
  "/.well-known/jwks.json",
  "/api/v1/auth/intents",
  "/api/v1/auth/signins/email",
].freeze
INTERNAL_SESSION_PATH = "/internal/session/status"
EXISTING_ROUTES_SHA256 = "0d8fb577196e7a4d3f63d0eae7c377b4fbb911d45362ad19b320dfb5577382c3"

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

def destination_host(route)
  route.dig("destination", "host")
end

def canonical(value)
  case value
  when Hash
    value.keys.sort.to_h { |key| [key, canonical(value[key])] }
  when Array
    value.map { |item| canonical(item) }
  else
    value
  end
end

def uri_matches?(match, path)
  uri = match["uri"] || {}
  return path == uri["exact"] if uri.key?("exact")
  return path.start_with?(uri["prefix"]) if uri.key?("prefix")
  return Regexp.new(uri["regex"]).match?(path) if uri.key?("regex")

  false
rescue RegexpError => error
  raise ContractError, "invalid route regex #{uri["regex"].inspect}: #{error.message}"
end

repo = Pathname.new(ENV.fetch("REPO", Dir.pwd)).expand_path
kubectl = ENV.fetch("KUBECTL", "kubectl")

begin
  resources = render(kubectl, repo / "platform/istio/aws-dev/routing")
  virtual_services = resources.select do |resource|
    resource["kind"] == "VirtualService" &&
      resource.dig("metadata", "name") == "medikong-aws-dev" &&
      resource.dig("metadata", "namespace") == "istio-system"
  end
  assert_contract(virtual_services.length == 1, "expected exactly one istio-system/medikong-aws-dev VirtualService")

  routes = virtual_services.first.dig("spec", "http")
  assert_contract(routes.is_a?(Array), "medikong-aws-dev spec.http must be an array")
  public_routes = routes.select { |route| route["name"] == PUBLIC_ROUTE_NAME }
  assert_contract(public_routes.length == 1, "expected exactly one #{PUBLIC_ROUTE_NAME} route")

  public_route = public_routes.first
  expected_public_route = {
    "name" => PUBLIC_ROUTE_NAME,
    "match" => PUBLIC_PATHS.map { |path| {"uri" => {"exact" => path}} },
    "route" => [
      {
        "destination" => {
          "host" => AUTH_HOST,
          "port" => {"number" => 8080},
        },
      },
    ],
  }
  assert_contract(public_route == expected_public_route, "#{PUBLIC_ROUTE_NAME} must contain only the three exact auth paths")

  web_index = routes.index { |route| route["name"] == "web" }
  public_index = routes.index(public_route)
  assert_contract(web_index == routes.length - 1, "web catch-all must remain last")
  assert_contract(public_index == web_index - 1, "#{PUBLIC_ROUTE_NAME} must be immediately before the web catch-all")

  existing_routes = routes.reject { |route| route["name"] == PUBLIC_ROUTE_NAME }
  existing_digest = Digest::SHA256.hexdigest(JSON.generate(canonical(existing_routes)))
  assert_contract(existing_digest == EXISTING_ROUTES_SHA256, "an existing AWS route changed")

  auth_routes = routes.select do |route|
    Array(route["route"]).any? { |destination| destination_host(destination) == AUTH_HOST }
  end
  auth_exact_paths = auth_routes.flat_map do |route|
    Array(route["match"]).filter_map { |match| match.dig("uri", "exact") }
  end
  assert_contract(auth_exact_paths == PUBLIC_PATHS, "auth-service exact public path set differs")
  assert_contract(
    auth_routes.none? { |route| Array(route["match"]).any? { |match| uri_matches?(match, INTERNAL_SESSION_PATH) } },
    "#{INTERNAL_SESSION_PATH} must not be forwarded to auth-service",
  )
  assert_contract(
    routes.reject { |route| route["name"] == "web" }.none? do |route|
      Array(route["match"]).any? { |match| uri_matches?(match, INTERNAL_SESSION_PATH) }
    end,
    "#{INTERNAL_SESSION_PATH} must not have an external route before the existing web catch-all",
  )
rescue ContractError, TypeError, NoMethodError => error
  warn "FAIL aws-dev auth public routes: #{error.message}"
  exit 2
end

puts "PASS aws-dev auth public routes: exact=#{PUBLIC_PATHS.join(",")} internalSession=not-forwarded existingRoutes=unchanged web=last"
