#!/usr/bin/env ruby

require "digest"
require "json"
require "open3"
require "pathname"
require "yaml"

AUTH_HOST = "auth-service.dropmong-auth.svc.cluster.local"
PUBLIC_ROUTE_NAME = "public-auth-entrypoints"
REGISTRATION_ROUTE_NAME = "auth-registration"
BULK_TOKEN_ROUTE_NAME = "development-auth-bulk-tokens"
VIRTUAL_MESSAGE_ROUTE_NAME = "synthetic-auth-virtual-message"
PUBLIC_PATHS = [
  "/.well-known/jwks.json",
  "/api/v1/auth/intents",
  "/api/v1/auth/signins/email",
].freeze
REGISTRATION_MATCHES = [
  {"method" => {"exact" => "POST"}, "uri" => {"exact" => "/api/v1/auth/registrations"}},
  {"method" => {"exact" => "POST"}, "uri" => {"regex" => "^/api/v1/auth/registrations/[^/]+/challenges$"}},
  {"method" => {"exact" => "POST"}, "uri" => {"regex" => "^/api/v1/auth/registrations/[^/]+/challenges/[^/]+/verify$"}},
  {"method" => {"exact" => "POST"}, "uri" => {"regex" => "^/api/v1/auth/registrations/[^/]+/complete$"}},
  {"method" => {"exact" => "GET"}, "uri" => {"regex" => "^/api/v1/auth/registrations/[^/]+$"}},
].freeze
BULK_TOKEN_MATCH = {
  "method" => {"exact" => "POST"},
  "uri" => {"exact" => "/api/v1/dev/auth/test-tokens/bulk"},
  "headers" => {"x-dev-access-token" => {"regex" => "^.+$"}},
}.freeze
VIRTUAL_MESSAGE_MATCH = {
  "method" => {"exact" => "GET"},
  "uri" => {
    "regex" => "^/api/v1/dev/auth/verification-messages/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  },
  "headers" => {"x-dev-access-token" => {"regex" => "^.+$"}},
}.freeze
INTERNAL_SESSION_PATH = "/internal/session/status"
EXISTING_ROUTES_SHA256 = "0d8fb577196e7a4d3f63d0eae7c377b4fbb911d45362ad19b320dfb5577382c3"

class ContractError < StandardError; end

def assert_contract(condition, message)
  raise ContractError, message unless condition
end

def render(kubectl, path)
  stdout, stderr, status = Open3.capture3(kubectl, "kustomize", path.to_s)
  raise ContractError, "kubectl kustomize #{path} failed: #{stderr.strip}" unless status.success?

  YAML.load_stream(stdout).compact
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
  registration_routes = routes.select { |route| route["name"] == REGISTRATION_ROUTE_NAME }
  assert_contract(registration_routes.length == 1, "expected exactly one #{REGISTRATION_ROUTE_NAME} route")
  bulk_token_routes = routes.select { |route| route["name"] == BULK_TOKEN_ROUTE_NAME }
  assert_contract(bulk_token_routes.length == 1, "expected exactly one #{BULK_TOKEN_ROUTE_NAME} route")
  virtual_message_routes = routes.select { |route| route["name"] == VIRTUAL_MESSAGE_ROUTE_NAME }
  assert_contract(virtual_message_routes.length == 1, "expected exactly one #{VIRTUAL_MESSAGE_ROUTE_NAME} route")

  public_route = public_routes.first
  registration_route = registration_routes.first
  bulk_token_route = bulk_token_routes.first
  virtual_message_route = virtual_message_routes.first
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
  expected_registration_route = {
    "name" => REGISTRATION_ROUTE_NAME,
    "match" => REGISTRATION_MATCHES,
    "route" => [
      {
        "destination" => {
          "host" => AUTH_HOST,
          "port" => {"number" => 8080},
        },
      },
    ],
  }
  assert_contract(
    registration_route == expected_registration_route,
    "#{REGISTRATION_ROUTE_NAME} must contain only the five controller method/path matches",
  )
  expected_bulk_token_route = {
    "name" => BULK_TOKEN_ROUTE_NAME,
    "match" => [BULK_TOKEN_MATCH],
    "route" => [
      {
        "destination" => {
          "host" => AUTH_HOST,
          "port" => {"number" => 8080},
        },
      },
    ],
  }
  assert_contract(
    bulk_token_route == expected_bulk_token_route,
    "#{BULK_TOKEN_ROUTE_NAME} must be one token-gated exact POST route",
  )
  expected_virtual_message_route = {
    "name" => VIRTUAL_MESSAGE_ROUTE_NAME,
    "match" => [VIRTUAL_MESSAGE_MATCH],
    "route" => [
      {
        "destination" => {
          "host" => AUTH_HOST,
          "port" => {"number" => 8080},
        },
      },
    ],
  }
  assert_contract(
    virtual_message_route == expected_virtual_message_route,
    "#{VIRTUAL_MESSAGE_ROUTE_NAME} must be one token-gated GET UUID route",
  )

  web_index = routes.index { |route| route["name"] == "web" }
  public_index = routes.index(public_route)
  registration_index = routes.index(registration_route)
  bulk_token_index = routes.index(bulk_token_route)
  virtual_message_index = routes.index(virtual_message_route)
  assert_contract(web_index == routes.length - 1, "web catch-all must remain last")
  assert_contract(virtual_message_index == web_index - 1, "#{VIRTUAL_MESSAGE_ROUTE_NAME} must be immediately before the web catch-all")
  assert_contract(bulk_token_index == virtual_message_index - 1, "#{BULK_TOKEN_ROUTE_NAME} order differs")
  assert_contract(registration_index == bulk_token_index - 1, "#{REGISTRATION_ROUTE_NAME} order differs")
  assert_contract(public_index == registration_index - 1, "#{PUBLIC_ROUTE_NAME} order differs")

  added_route_names = [PUBLIC_ROUTE_NAME, REGISTRATION_ROUTE_NAME, BULK_TOKEN_ROUTE_NAME, VIRTUAL_MESSAGE_ROUTE_NAME]
  existing_routes = routes.reject { |route| added_route_names.include?(route["name"]) }
  existing_digest = Digest::SHA256.hexdigest(JSON.generate(canonical(existing_routes)))
  assert_contract(existing_digest == EXISTING_ROUTES_SHA256, "an existing AWS route changed")

  auth_routes = routes.select do |route|
    Array(route["route"]).any? { |destination| destination_host(destination) == AUTH_HOST }
  end
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

puts "PASS aws-dev auth routes: publicExact=#{PUBLIC_PATHS.length} registrationMatches=#{REGISTRATION_MATCHES.length} bulkToken=POST+dev-token virtualMessage=GET+uuid+dev-token internalSession=not-forwarded existingRoutes=unchanged web=last"
