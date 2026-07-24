#!/usr/bin/env ruby

require "optparse"
require "pathname"
require "json"
require "open3"
require "yaml"

MIGRATION_VALUE_FILE = "platform/metrics-server/values/aws-dev-selector-migration.yaml"
STEADY_VALUE_FILE = "platform/metrics-server/values/aws-dev.yaml"
APPLICATION_FILE = "argo/applications/aws-dev/platform/metrics-server.yaml"
SYNC_KEY = "argocd.argoproj.io/sync-options"
FORCE_REPLACE = "Force=true,Replace=true"

options = {repo: Pathname.new(Dir.pwd), phase: "cleanup"}
OptionParser.new do |parser|
  parser.on("--repo PATH") { |value| options[:repo] = Pathname.new(value) }
  parser.on("--phase PHASE", %w[enable verify cleanup rollback]) { |value| options[:phase] = value }
  parser.on("--kubectl PATH") { |value| options[:kubectl] = value }
end.parse!

repo = options[:repo].expand_path
steady_path = repo / STEADY_VALUE_FILE
migration_path = repo / MIGRATION_VALUE_FILE
application_path = repo / APPLICATION_FILE

begin
  steady = YAML.safe_load(File.read(steady_path), aliases: true) || {}
  migration = YAML.safe_load(File.read(migration_path), aliases: true) || {}
  application = YAML.safe_load(File.read(application_path), aliases: true) || {}
  chart_source = Array(application.fetch("spec").fetch("sources")).find { |source| source["chart"] == "metrics-server" }
  raise "metrics-server chart source is missing" unless chart_source

  value_files = Array(chart_source.dig("helm", "valueFiles"))
  steady_sync = steady.dig("deploymentAnnotations", SYNC_KEY)
  migration_sync = migration.dig("deploymentAnnotations", SYNC_KEY)
  migration_referenced = value_files.include?("$values/#{MIGRATION_VALUE_FILE}")

  case options[:phase]
  when "enable"
    raise "phase enable requires #{MIGRATION_VALUE_FILE}" unless migration_sync == FORCE_REPLACE
    raise "phase enable requires Application valueFiles to reference the migration overlay" unless migration_referenced
    raise "phase enable requires ordinary values to omit #{SYNC_KEY}" if steady_sync
    puts "PASS metrics-server migration phase=enable overlay=#{MIGRATION_VALUE_FILE} application_reference=true"
  when "verify"
    kubectl = options[:kubectl] || ENV.fetch("KUBECTL", "kubectl")
    run_kubectl = lambda do |*arguments|
      stdout, stderr, status = Open3.capture3(kubectl, *arguments)
      raise "kubectl #{arguments.join(" ")} failed: #{stderr.strip}" unless status.success?
      stdout
    end

    application_status = JSON.parse(run_kubectl.call("-n", "argocd", "get", "application", "metrics-server-aws-dev", "-o", "json"))
    raise "phase verify requires Argo application Synced/Healthy" unless application_status.dig("status", "sync", "status") == "Synced" && application_status.dig("status", "health", "status") == "Healthy"

    api_status = JSON.parse(run_kubectl.call("get", "apiservice", "v1beta1.metrics.k8s.io", "-o", "json"))
    available = Array(api_status.dig("status", "conditions")).find { |condition| condition["type"] == "Available" }
    raise "phase verify requires APIService Available=True" unless available && available["status"] == "True"

    endpoint_slice_status = JSON.parse(run_kubectl.call("-n", "kube-system", "get", "endpointslice", "-l", "kubernetes.io/service-name=metrics-server", "-o", "json"))
    endpoints = Array(endpoint_slice_status["items"]).flat_map { |item| Array(item["endpoints"]) }
    ports = Array(endpoint_slice_status["items"]).flat_map { |item| Array(item["ports"]) }
    raise "phase verify requires a ready metrics-server EndpointSlice address" unless endpoints.any? { |endpoint| endpoint.dig("conditions", "ready") == true && Array(endpoint["addresses"]).any? }
    raise "phase verify requires a named https EndpointSlice port" unless ports.any? { |port| port["name"] == "https" }

    deployment = JSON.parse(run_kubectl.call("-n", "kube-system", "get", "deployment", "metrics-server", "-o", "json"))
    selector = deployment.dig("spec", "selector", "matchLabels") || {}
    labels = deployment.dig("spec", "template", "metadata", "labels") || {}
    expected_labels = {"app.kubernetes.io/name" => "metrics-server", "app.kubernetes.io/instance" => "metrics-server"}
    raise "phase verify requires chart selector labels on the Deployment" unless expected_labels.all? { |key, value| selector[key] == value && labels[key] == value }

    metrics_api = JSON.parse(run_kubectl.call("get", "--raw", "/apis/metrics.k8s.io/v1beta1"))
    raise "phase verify requires non-empty NodeMetricsList from the resource metrics API" unless metrics_api["kind"] == "NodeMetricsList" && Array(metrics_api["items"]).any?

    puts "PASS metrics-server migration phase=verify argo_synced=true apiservice_available=true endpoint_ready=true selector_replaced=true metrics_api=NodeMetricsList"
  when "cleanup", "rollback"
    raise "phase #{options[:phase]} requires ordinary values to omit #{SYNC_KEY}" if steady_sync
    raise "phase #{options[:phase]} requires Application valueFiles to omit the migration overlay" if migration_referenced
    raise "phase #{options[:phase]} migration overlay was altered" unless migration_sync == FORCE_REPLACE
    puts "PASS metrics-server migration phase=#{options[:phase]} ordinary_sync=true force_replace_reference=false"
  end
rescue Errno::ENOENT => error
  warn "FAIL metrics-server migration phase=#{options[:phase]} missing=#{error.message.split(': ', 2).last}"
  exit 2
rescue Psych::Exception, KeyError, RuntimeError => error
  warn "FAIL metrics-server migration phase=#{options[:phase]} #{error.message}"
  exit 2
end
