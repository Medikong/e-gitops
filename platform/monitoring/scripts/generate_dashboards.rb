#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "fileutils"

ROOT = File.expand_path("..", __dir__)

SERVICES = %w[
  auth-service user-service catalog-service coupon-service interest-service
  order-service payment-service notification-service dropmong-web
].freeze
NAMESPACES = %w[
  dropmong-auth dropmong-user dropmong-catalog dropmong-coupon dropmong-interest
  dropmong-order dropmong-payment dropmong-notification dropmong-web
].freeze
DB_SERVICES = SERVICES.first(7).freeze
DB_NAMESPACES = NAMESPACES.first(7).freeze
KAFKA_SERVICES = %w[interest-service order-service payment-service notification-service].freeze
TOPICS = %w[
  interest.added interest.removed inventory.changed order.created order.expired
  notification.requested refund.requested refund.completed refund.failed
  payment.approved payment.failed
].freeze

PROMETHEUS = { "type" => "prometheus", "uid" => "prometheus" }.freeze
LOKI = { "type" => "loki", "uid" => "loki" }.freeze
TEMPO = { "type" => "tempo", "uid" => "tempo" }.freeze

HTTP = 'service_environment=~"${environment:regex}",service_name=~"${service:regex}",http_route=~"${route:regex}",http_route_kind="api"'
APP_CONTAINERS = 'namespace=~"${namespace:regex}",container!="",container!="POD",image!=""'
APP_LOGS = '{k8s_namespace_name=~"${namespace:regex}",service_name=~"${service:regex}"}'
DB_PODS = 'namespace=~"${namespace:regex}",pod=~".*-db-.*",container!="",container!="POD",image!=""'

def custom_variable(name, values, all_value, label: nil)
  {
    "name" => name,
    "label" => label || name.split("_").map(&:capitalize).join(" "),
    "type" => "custom",
    "query" => values.join(","),
    "options" => values.map { |value| { "selected" => false, "text" => value, "value" => value } },
    "current" => { "selected" => true, "text" => "All", "value" => "$__all" },
    "includeAll" => true,
    "allValue" => all_value,
    "multi" => true,
    "refresh" => 0
  }
end

def query_variable(name, query, datasource: PROMETHEUS, label: nil)
  {
    "name" => name,
    "label" => label || name.split("_").map(&:capitalize).join(" "),
    "type" => "query",
    "datasource" => datasource,
    "query" => query,
    "definition" => query,
    "current" => { "selected" => true, "text" => "All", "value" => "$__all" },
    "includeAll" => true,
    "allValue" => ".*",
    "multi" => true,
    "refresh" => 1
  }
end

def textbox(name, default, label: nil)
  {
    "name" => name,
    "label" => label || name.split("_").map(&:capitalize).join(" "),
    "type" => "textbox",
    "query" => default,
    "current" => { "selected" => true, "text" => default, "value" => default }
  }
end

def common_variables(services: SERVICES, namespaces: NAMESPACES)
  [
    query_variable("environment", "label_values(service_ready, service_environment)"),
    custom_variable("namespace", namespaces, "(#{namespaces.join('|')})"),
    custom_variable("service", services, "(#{services.join('|')})"),
    query_variable("route", 'label_values(http_server_request_duration_seconds_count{service_name=~"${service:regex}",http_route_kind="api"}, http_route)')
  ]
end

def logs_variables
  common_variables + [
    textbox("request_id", "a^"), textbox("trace_id", "a^"), textbox("span_id", "a^"),
    textbox("correlation_id", "a^"), textbox("min_duration_ms", "1000"),
    custom_variable("topic", TOPICS, "(#{TOPICS.map { |topic| Regexp.escape(topic) }.join('|')})"),
    custom_variable("outcome", %w[success failure], ".*")
  ]
end

def db_variables
  common_variables(services: DB_SERVICES, namespaces: DB_NAMESPACES) + [
    textbox("request_id", "a^"), textbox("trace_id", "a^"), textbox("span_id", "a^"),
    textbox("min_duration", "500ms")
  ]
end

def load_variables
  common_variables + [textbox("min_duration_ms", "1000"), textbox("trace_id", "a^"), textbox("run_id", ".*")]
end

def panel(title, type:, datasource: nil, targets: [], description: nil, unit: "short", content: nil, links: [], full_width: false, height: nil)
  result = {
    "title" => title,
    "type" => type,
    "description" => description,
    "targets" => targets,
    "links" => links,
    "fieldConfig" => { "defaults" => { "unit" => unit }, "overrides" => [] }
  }
  result["datasource"] = datasource if datasource
  result["options"] = { "mode" => "markdown", "content" => content } if type == "text"
  result["_fullWidth"] = true if full_width
  result["_height"] = height if height
  result
end

def text(title, content)
  panel(title, type: "text", content: content)
end

def prom(title, expressions, type: "timeseries", unit: "short", description: nil, height: nil, full_width: false)
  expressions = [expressions] unless expressions.is_a?(Array)
  targets = expressions.each_with_index.map do |expression, index|
    expr, legend = expression.is_a?(Array) ? expression : [expression, "{{service_name}}"]
    { "datasource" => PROMETHEUS, "editorMode" => "code", "expr" => expr, "legendFormat" => legend, "range" => true, "refId" => (65 + index).chr }
  end
  panel(
    title, type: type, datasource: PROMETHEUS, targets: targets,
    description: description, unit: unit, height: height, full_width: full_width
  )
end

def runtime_status_grid
  queries = {
    "A" => ["Desired", 'sum by (namespace) (kube_deployment_spec_replicas{namespace=~"${namespace:regex}"})'],
    "B" => ["Available", 'sum by (namespace) (kube_deployment_status_replicas_available{namespace=~"${namespace:regex}"})'],
    "C" => ["Unavailable", 'sum by (namespace) (kube_deployment_status_replicas_unavailable{namespace=~"${namespace:regex}"})'],
    "D" => ["Available %", '100 * sum by (namespace) (kube_deployment_status_replicas_available{namespace=~"${namespace:regex}"}) / clamp_min(sum by (namespace) (kube_deployment_spec_replicas{namespace=~"${namespace:regex}"}), 1)'],
    "E" => ["Ready False", 'sum by (namespace) (kube_pod_status_ready{namespace=~"${namespace:regex}",condition="false"})'],
    "F" => ["Restarts", 'round(sum by (namespace) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__range])))'],
    "G" => ["OOMKilled", '(sum by (namespace) (max_over_time(kube_pod_container_status_last_terminated_reason{namespace=~"${namespace:regex}",reason="OOMKilled",container!=""}[$__range])) or on (namespace) 0 * sum by (namespace) (kube_pod_info{namespace=~"${namespace:regex}"}))']
  }
  targets = queries.map do |ref_id, (legend, expression)|
    {
      "datasource" => PROMETHEUS, "editorMode" => "code", "expr" => expression,
      "format" => "table", "instant" => true, "legendFormat" => legend,
      "range" => false, "refId" => ref_id
    }
  end
  status_override = lambda do |field, steps, unit = "short", decimals = 0|
    {
      "matcher" => { "id" => "byName", "options" => field },
      "properties" => [
        { "id" => "unit", "value" => unit },
        { "id" => "decimals", "value" => decimals },
        { "id" => "thresholds", "value" => { "mode" => "absolute", "steps" => steps } },
        { "id" => "custom.cellOptions", "value" => { "type" => "color-background", "mode" => "basic" } }
      ]
    }
  end
  result = panel(
    "Service Status Grid", type: "table", datasource: PROMETHEUS, targets: targets,
    description: "One row per DropMong namespace. Unhealthy availability, unready Pods, restarts and OOMKilled evidence are color-coded; the selected dashboard time range controls restart and OOM history.",
    full_width: true, height: 11
  )
  result["options"] = {
    "cellHeight" => "sm", "showHeader" => true,
    "footer" => { "countRows" => false, "fields" => "", "reducer" => ["sum"], "show" => false }
  }
  result["transformations"] = [
    { "id" => "joinByField", "options" => { "byField" => "namespace", "mode" => "outer" } },
    {
      "id" => "organize",
      "options" => {
        "excludeByName" => {
          "Time" => true, "Time 1" => true, "Time 2" => true, "Time 3" => true,
          "Time 4" => true, "Time 5" => true, "Time 6" => true, "Time 7" => true
        },
        "indexByName" => {
          "namespace" => 0, "Value #A" => 1, "Value #B" => 2, "Value #C" => 3,
          "Value #D" => 4, "Value #E" => 5, "Value #F" => 6, "Value #G" => 7
        },
        "renameByName" => {
          "namespace" => "Namespace", "Value #A" => "Desired", "Value #B" => "Available",
          "Value #C" => "Unavailable", "Value #D" => "Available %", "Value #E" => "Ready False",
          "Value #F" => "Restarts", "Value #G" => "OOMKilled"
        }
      }
    },
    {
      "id" => "sortBy",
      "options" => {
        "fields" => {},
        "sort" => [{ "field" => "Available %", "desc" => false }]
      }
    }
  ]
  result["fieldConfig"]["defaults"].merge!(
    "custom" => { "align" => "auto", "cellOptions" => { "type" => "auto" }, "inspect" => false },
    "decimals" => 0
  )
  result["fieldConfig"]["overrides"] = [
    status_override.call("Available %", [
      { "color" => "red", "value" => nil }, { "color" => "orange", "value" => 80 }, { "color" => "green", "value" => 100 }
    ], "percent"),
    status_override.call("Unavailable", [
      { "color" => "green", "value" => nil }, { "color" => "red", "value" => 0.5 }
    ]),
    status_override.call("Ready False", [
      { "color" => "green", "value" => nil }, { "color" => "red", "value" => 0.5 }
    ]),
    status_override.call("Restarts", [
      { "color" => "green", "value" => nil }, { "color" => "yellow", "value" => 0.01 }, { "color" => "red", "value" => 3 }
    ], "short", 1),
    status_override.call("OOMKilled", [
      { "color" => "green", "value" => nil }, { "color" => "red", "value" => 0.01 }
    ])
  ]
  result
end

def resource_snapshot_table
  cpu_usage = 'sum by (namespace) (rate(container_cpu_usage_seconds_total{namespace=~"${namespace:regex}",container!="",container!="POD",image!=""}[$__rate_interval]))'
  cpu_requests = 'sum by (namespace) (kube_pod_container_resource_requests{namespace=~"${namespace:regex}",resource="cpu",unit="core",container!="",container!="POD"})'
  cpu_limits = 'sum by (namespace) (kube_pod_container_resource_limits{namespace=~"${namespace:regex}",resource="cpu",unit="core",container!="",container!="POD"})'
  memory_usage = 'sum by (namespace) (container_memory_working_set_bytes{namespace=~"${namespace:regex}",container!="",container!="POD",image!=""})'
  memory_requests = 'sum by (namespace) (kube_pod_container_resource_requests{namespace=~"${namespace:regex}",resource="memory",unit="byte",container!="",container!="POD"})'
  memory_limits = 'sum by (namespace) (kube_pod_container_resource_limits{namespace=~"${namespace:regex}",resource="memory",unit="byte",container!="",container!="POD"})'
  throttling = '100 * sum by (namespace) (rate(container_cpu_cfs_throttled_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])) / clamp_min(sum by (namespace) (rate(container_cpu_cfs_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])), 0.001)'
  queries = {
    "A" => ["CPU Cores", cpu_usage],
    "B" => ["CPU Request %", "100 * #{cpu_usage} / clamp_min(#{cpu_requests}, 0.001)"],
    "C" => ["CPU Limit %", "100 * #{cpu_usage} / clamp_min(#{cpu_limits}, 0.001)"],
    "D" => ["Memory Used", memory_usage],
    "E" => ["Memory Request %", "100 * #{memory_usage} / clamp_min(#{memory_requests}, 1)"],
    "F" => ["Memory Limit %", "100 * #{memory_usage} / clamp_min(#{memory_limits}, 1)"],
    "G" => ["CPU Throttling %", throttling]
  }
  targets = queries.map do |ref_id, (legend, expression)|
    {
      "datasource" => PROMETHEUS, "editorMode" => "code", "expr" => expression,
      "format" => "table", "instant" => true, "legendFormat" => legend,
      "range" => false, "refId" => ref_id
    }
  end
  percent_override = lambda do |field, warning, critical|
    {
      "matcher" => { "id" => "byName", "options" => field },
      "properties" => [
        { "id" => "unit", "value" => "percent" },
        { "id" => "decimals", "value" => 1 },
        { "id" => "min", "value" => 0 },
        { "id" => "max", "value" => 100 },
        {
          "id" => "thresholds",
          "value" => {
            "mode" => "absolute",
            "steps" => [
              { "color" => "green", "value" => nil },
              { "color" => "yellow", "value" => warning },
              { "color" => "red", "value" => critical }
            ]
          }
        },
        { "id" => "custom.cellOptions", "value" => { "type" => "gauge" } }
      ]
    }
  end
  result = panel(
    "Resource Snapshot", type: "table", datasource: PROMETHEUS, targets: targets,
    description: "Current namespace resource usage. Request and limit percentages use Kubernetes resource configuration as the denominator; an empty percentage means that denominator is unavailable.",
    full_width: true, height: 11
  )
  result["options"] = {
    "cellHeight" => "md", "showHeader" => true,
    "footer" => { "countRows" => false, "fields" => "", "reducer" => ["sum"], "show" => false }
  }
  result["transformations"] = [
    { "id" => "joinByField", "options" => { "byField" => "namespace", "mode" => "outer" } },
    {
      "id" => "organize",
      "options" => {
        "excludeByName" => {
          "Time" => true, "Time 1" => true, "Time 2" => true, "Time 3" => true,
          "Time 4" => true, "Time 5" => true, "Time 6" => true, "Time 7" => true
        },
        "indexByName" => {
          "namespace" => 0, "Value #A" => 1, "Value #B" => 2, "Value #C" => 3,
          "Value #D" => 4, "Value #E" => 5, "Value #F" => 6, "Value #G" => 7
        },
        "renameByName" => {
          "namespace" => "Namespace", "Value #A" => "CPU Cores", "Value #B" => "CPU Request %",
          "Value #C" => "CPU Limit %", "Value #D" => "Memory Used", "Value #E" => "Memory Request %",
          "Value #F" => "Memory Limit %", "Value #G" => "CPU Throttling %"
        }
      }
    },
    { "id" => "sortBy", "options" => { "fields" => {}, "sort" => [{ "field" => "Namespace", "desc" => false }] } }
  ]
  result["fieldConfig"]["defaults"].merge!(
    "custom" => { "align" => "auto", "cellOptions" => { "type" => "auto" }, "inspect" => false }
  )
  result["fieldConfig"]["overrides"] = [
    {
      "matcher" => { "id" => "byName", "options" => "Namespace" },
      "properties" => [{ "id" => "custom.width", "value" => 190 }]
    },
    {
      "matcher" => { "id" => "byName", "options" => "CPU Cores" },
      "properties" => [{ "id" => "unit", "value" => "cores" }, { "id" => "decimals", "value" => 3 }]
    },
    {
      "matcher" => { "id" => "byName", "options" => "Memory Used" },
      "properties" => [{ "id" => "unit", "value" => "bytes" }, { "id" => "decimals", "value" => 1 }]
    },
    percent_override.call("CPU Request %", 80, 100),
    percent_override.call("CPU Limit %", 70, 90),
    percent_override.call("Memory Request %", 80, 100),
    percent_override.call("Memory Limit %", 70, 90),
    percent_override.call("CPU Throttling %", 10, 25)
  ]
  result
end

def resource_bar_gauge(title, expression, description:)
  target = {
    "datasource" => PROMETHEUS, "editorMode" => "code", "expr" => expression,
    "instant" => true, "legendFormat" => "{{namespace}}", "range" => false, "refId" => "A"
  }
  result = panel(title, type: "bargauge", datasource: PROMETHEUS, targets: [target], description: description, unit: "percent", height: 9)
  result["options"] = {
    "displayMode" => "gradient", "minVizHeight" => 16, "minVizWidth" => 0,
    "namePlacement" => "auto", "orientation" => "horizontal",
    "reduceOptions" => { "calcs" => ["lastNotNull"], "fields" => "", "values" => false },
    "showUnfilled" => true, "sizing" => "auto", "text" => {}
  }
  result["fieldConfig"]["defaults"].merge!(
    "decimals" => 1, "min" => 0, "max" => 100,
    "color" => { "mode" => "thresholds" },
    "thresholds" => {
      "mode" => "absolute",
      "steps" => [
        { "color" => "green", "value" => nil },
        { "color" => "yellow", "value" => 70 },
        { "color" => "red", "value" => 90 }
      ]
    }
  )
  result
end

def loki(title, query, type: "logs", description: nil)
  target = { "datasource" => LOKI, "editorMode" => "code", "expr" => query, "queryType" => "range", "refId" => "A" }
  panel(title, type: type, datasource: LOKI, targets: [target], description: description)
end

def tempo_search(title, query)
  target = { "datasource" => TEMPO, "queryType" => "traceql", "query" => query, "refId" => "A" }
  panel(title, type: "table", datasource: TEMPO, targets: [target])
end

def tempo_trace(title = "Tempo Trace by trace_id")
  target = { "datasource" => TEMPO, "queryType" => "traceId", "query" => "$trace_id", "refId" => "A" }
  panel(title, type: "traces", datasource: TEMPO, targets: [target])
end

def assign_layout(panels)
  y = 0
  regular_index = 0
  panels.each_with_index do |item, index|
    item["id"] = index + 1
    full_width = item.delete("_fullWidth")
    height = item.delete("_height") || (item["type"] == "text" ? 3 : 7)
    if item["type"] == "text" || full_width
      y += 7 if regular_index.odd?
      item["gridPos"] = { "x" => 0, "y" => y, "w" => 24, "h" => height }
      y += height
      regular_index = 0
    else
      x = (regular_index % 2) * 12
      item["gridPos"] = { "x" => x, "y" => y, "w" => 12, "h" => height }
      regular_index += 1
      y += height if regular_index.even?
    end
  end
end

def dashboard(uid:, title:, group:, variables:, panels:, previous_uid:, next_uid:)
  assign_layout(panels)
  links = []
  links << { "title" => "Previous", "type" => "link", "url" => "/d/#{previous_uid}/#{previous_uid}", "includeVars" => true, "keepTime" => true, "targetBlank" => false } if previous_uid
  links << { "title" => "Next", "type" => "link", "url" => "/d/#{next_uid}/#{next_uid}", "includeVars" => true, "keepTime" => true, "targetBlank" => false } if next_uid
  related = {
    "ops" => ["Open Logs", "dropmong-logs-25-service-search"],
    "load" => ["Open Slow Request Logs", "dropmong-logs-80-service-trace-detail"],
    "db" => ["Open ID Drilldown", "dropmong-logs-40-drilldown"],
    "logs" => ["Open Service Impact", "dropmong-ops-00-service-overview"]
  }.fetch(group)
  links << { "title" => related[0], "type" => "link", "url" => "/d/#{related[1]}/#{related[1]}", "includeVars" => true, "keepTime" => true, "targetBlank" => false }
  {
    "annotations" => { "list" => [] }, "editable" => false, "fiscalYearStartMonth" => 0,
    "graphTooltip" => 1, "id" => nil, "links" => links, "liveNow" => false,
    "panels" => panels, "refresh" => "30s", "schemaVersion" => 41,
    "tags" => ["dropmong", group.downcase, "top-down"],
    "templating" => { "list" => variables },
    "time" => { "from" => "now-1h", "to" => "now" },
    "timepicker" => { "refresh_intervals" => %w[10s 30s 1m 5m], "time_options" => %w[5m 15m 1h 6h 24h] },
    "timezone" => "browser", "title" => title, "uid" => uid, "version" => 1, "weekStart" => ""
  }
end

def p95(selector = HTTP, by: "service_name")
  "histogram_quantile(0.95, sum by (#{by}, le) (rate(http_server_request_duration_seconds_bucket{#{selector}}[$__rate_interval])))"
end

def p99(selector = HTTP, by: "service_name")
  "histogram_quantile(0.99, sum by (#{by}, le) (rate(http_server_request_duration_seconds_bucket{#{selector}}[$__rate_interval])))"
end

def request_rate(selector = HTTP, by: "service_name")
  "sum by (#{by}) (rate(http_server_request_duration_seconds_count{#{selector}}[$__rate_interval]))"
end

def error_ratio(code, selector = HTTP, by: "service_name")
  "100 * sum by (#{by}) (rate(http_server_request_duration_seconds_count{#{selector},http_response_status_code=~\"#{code}\"}[$__rate_interval])) / clamp_min(sum by (#{by}) (rate(http_server_request_duration_seconds_count{#{selector}}[$__rate_interval])), 0.001)"
end

GROUPS = {
  "ops" => [
    ["00-service-overview.json", "dropmong-ops-00-service-overview", "Ops 00 - Service Impact Overview", common_variables, [
      text("Investigation Start", "Start with traffic, errors, latency and active requests. Continue to Ops 01 only after the affected service and time range are known."),
      prom("Request Rate by Service", request_rate, unit: "reqps"),
      prom("5xx Error Ratio by Service", error_ratio("5.."), unit: "percent"),
      prom("p95 / p99 Latency by Service", [[p95, "p95 {{service_name}}"], [p99, "p99 {{service_name}}"]], unit: "s"),
      prom("Active Requests", "sum by (service_name) (http_server_active_requests{#{HTTP}})"),
      prom("Service Readiness", 'min by (service_name) (service_ready{service_name=~"${service:regex}"})', type: "stat", unit: "none"),
      prom("CPU Usage by Namespace", "sum by (namespace) (rate(container_cpu_usage_seconds_total{#{APP_CONTAINERS}}[$__rate_interval]))", unit: "cores"),
      prom("Memory Working Set by Namespace", "sum by (namespace) (container_memory_working_set_bytes{#{APP_CONTAINERS}})", unit: "bytes")
    ]],
    ["01-service-runtime-health.json", "dropmong-ops-01-service-runtime-health", "Ops 01 - Service Runtime Health", common_variables, [
      text("Scope", "Confirm Deployment availability, Pod readiness and restart pressure for the service identified in Ops 00."),
      runtime_status_grid,
      resource_snapshot_table,
      resource_bar_gauge(
        "CPU Limit Utilization by Namespace",
        'sort_desc(100 * sum by (namespace) (rate(container_cpu_usage_seconds_total{namespace=~"${namespace:regex}",container!="",container!="POD",image!=""}[$__rate_interval])) / clamp_min(sum by (namespace) (kube_pod_container_resource_limits{namespace=~"${namespace:regex}",resource="cpu",unit="core",container!="",container!="POD"}), 0.001))',
        description: "Current CPU cores divided by configured CPU limits. Use this ranking to pick a namespace, then inspect the Pod time series below."
      ),
      resource_bar_gauge(
        "Memory Limit Utilization by Namespace",
        'sort_desc(100 * sum by (namespace) (container_memory_working_set_bytes{namespace=~"${namespace:regex}",container!="",container!="POD",image!=""}) / clamp_min(sum by (namespace) (kube_pod_container_resource_limits{namespace=~"${namespace:regex}",resource="memory",unit="byte",container!="",container!="POD"}), 1))',
        description: "Current memory working set divided by configured memory limits. A missing series means the limit denominator is unavailable."
      ),
      prom("CPU by Pod", "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{#{APP_CONTAINERS}}[$__rate_interval]))", unit: "cores", height: 14),
      prom("Memory by Pod", "sum by (namespace, pod) (container_memory_working_set_bytes{#{APP_CONTAINERS}})", unit: "bytes", height: 14),
      prom("CPU Throttling Ratio", '100 * sum by (namespace, pod, container) (rate(container_cpu_cfs_throttled_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])) / clamp_min(sum by (namespace, pod, container) (rate(container_cpu_cfs_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])), 0.001)', unit: "percent", height: 14)
    ]],
    ["03-gateway-mesh-metrics.json", "dropmong-ops-03-gateway-mesh", "Ops 03 - Gateway and Mesh Evidence", common_variables, [
      text("Decision Boundary", "No Kong request metric is assumed. Istio metrics are limited to the tracked PodMonitor contract for payment-service and notification-service; an empty panel means the sidecar target is not active in that environment."),
      prom("Istiod Scrape Targets", 'sum by (job, instance) (up{namespace="istio-system"})', type: "stat", unit: "none"),
      prom("Envoy Scrape Targets", 'sum by (namespace, pod) (up{namespace=~"dropmong-(payment|notification)",container="istio-proxy"})', type: "stat", unit: "none"),
      prom("Mesh Request Rate", 'sum by (destination_service_name, response_code) (rate(istio_requests_total{destination_workload_namespace=~"dropmong-(payment|notification)"}[$__rate_interval]))', unit: "reqps"),
      prom("Mesh 5xx Ratio", '100 * sum(rate(istio_requests_total{destination_workload_namespace=~"dropmong-(payment|notification)",response_code=~"5.."}[$__rate_interval])) / clamp_min(sum(rate(istio_requests_total{destination_workload_namespace=~"dropmong-(payment|notification)"}[$__rate_interval])), 0.001)', unit: "percent"),
      prom("Mesh p95 Duration", 'histogram_quantile(0.95, sum by (destination_service_name, le) (rate(istio_request_duration_milliseconds_bucket{destination_workload_namespace=~"dropmong-(payment|notification)"}[$__rate_interval])))', unit: "ms"),
      prom("Application Request Rate", request_rate, unit: "reqps")
    ]],
    ["04-business-kpi-overview.json", "dropmong-ops-04-business-kpi", "Ops 04 - Business Route Signals", common_variables, [
      text("Metric Contract", "These are route-based operational indicators, not claimed business outcomes. They use the common completed-request metric because no cross-service business KPI metric contract exists."),
      prom("Auth Intent and Session Requests", request_rate(HTTP + ',service_name="auth-service",http_route=~"/api/v1/auth/(intents|sessions).*"', by: "http_route"), unit: "reqps"),
      prom("Coupon Claim Requests", request_rate(HTTP + ',service_name="coupon-service",http_route=~"/api/v1/coupon-campaigns/.*"', by: "http_route"), unit: "reqps"),
      prom("Interest and View Requests", request_rate(HTTP + ',service_name="interest-service",http_route=~"/v1/(users/me/interests|drops/.*|rankings/.*)"', by: "http_route"), unit: "reqps"),
      prom("Order Requests", request_rate(HTTP + ',service_name="order-service",http_route=~"/orders.*"', by: "http_route"), unit: "reqps"),
      prom("Payment Requests", request_rate(HTTP + ',service_name="payment-service",http_route=~"/payments.*"', by: "http_route"), unit: "reqps"),
      prom("Notification Requests", request_rate(HTTP + ',service_name="notification-service",http_route=~"/notifications.*"', by: "http_route"), unit: "reqps"),
      prom("Business Route 5xx Ratio", error_ratio("5.."), unit: "percent"),
      loki("Kafka Business Events", '{service_name=~"(interest-service|order-service|payment-service|notification-service)"} | json | event=~"kafka[.]message[.](publish|process)" | line_format "service={{.service_name}} topic={{.messaging_destination_name}} outcome={{.outcome}} correlation_id={{.correlation_id}} trace_id={{.trace_id}}"')
    ]],
    ["04-pod-logs-and-waiting-reasons.json", "dropmong-ops-04-pod-logs", "Ops 04 - Pod Logs and Waiting Reasons", common_variables, [
      text("Scope", "Use this screen when a Pod is not ready or repeatedly restarts. Scheduling and image-pull failures may exist before application logs are available."),
      prom("Waiting Containers", 'sum by (namespace, pod, container, reason) (kube_pod_container_status_waiting_reason{namespace=~"${namespace:regex}",reason!=""} == 1)'),
      prom("Restart Increase", 'sum by (namespace, pod, container) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval]))'),
      prom("Collector Queue Utilization", '100 * sum by (exporter, data_type) (otelcol_exporter_queue_size) / clamp_min(sum by (exporter, data_type) (otelcol_exporter_queue_capacity), 1)', unit: "percent"),
      loki("Recent Pod Logs", APP_LOGS + ' | json | line_format "service={{.service_name}} severity={{.severity_text}} event={{.event}} request_id={{.request_id}} trace_id={{.trace_id}}"'),
      loki("Application Start and Dependency Failures", APP_LOGS + ' |~ "(?i)(failed to start|connection refused|timeout|unavailable|migration)"'),
      prom("Unschedulable Pods", 'sum by (namespace, pod) (kube_pod_status_unschedulable{namespace=~"${namespace:regex}"} == 1)')
    ]],
    ["10-system-kubernetes-overview.json", "dropmong-ops-10-kubernetes", "Ops 10 - Kubernetes Overview", common_variables, [
      text("Top-down Step", "After service impact and runtime health, inspect cluster-wide Deployment gaps, Pod failures and node pressure."),
      prom("Deployment Available Ratio", '100 * sum by (namespace, deployment) (kube_deployment_status_replicas_available{namespace=~"${namespace:regex}"}) / clamp_min(sum by (namespace, deployment) (kube_deployment_spec_replicas{namespace=~"${namespace:regex}"}), 1)', unit: "percent"),
      prom("Unavailable Replicas", 'sum by (namespace, deployment) (kube_deployment_status_replicas_unavailable{namespace=~"${namespace:regex}"})'),
      prom("Ready False Pods", 'sum by (namespace, pod) (kube_pod_status_ready{namespace=~"${namespace:regex}",condition="false"} == 1)'),
      prom("Restart Increase", 'sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}"}[$__rate_interval]))'),
      prom("OOMKilled Containers", 'sum by (namespace, pod, container) (max_over_time(kube_pod_container_status_last_terminated_reason{namespace=~"${namespace:regex}",reason="OOMKilled"}[$__range]) == 1)'),
      prom("Pressure Nodes", 'sum by (node, condition) (kube_node_status_condition{condition=~"MemoryPressure|DiskPressure|PIDPressure",status="true"} == 1)'),
      prom("Top CPU by Container", 'topk(15, sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])))', unit: "cores"),
      prom("Top Memory by Container", 'topk(15, sum by (namespace, pod, container) (container_memory_working_set_bytes{namespace=~"${namespace:regex}",container!="",container!="POD"}))', unit: "bytes")
    ]],
    ["11-pod-container-resources.json", "dropmong-ops-11-pod-container", "Ops 11 - Pod and Container Resources", common_variables, [
      text("Scope", "Identify the exact Pod and container responsible for CPU, memory, throttling, restart or network pressure."),
      prom("CPU Usage Top", 'topk(15, sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])))', unit: "cores"),
      prom("CPU Throttling Top", 'topk(15, 100 * sum by (namespace, pod, container) (rate(container_cpu_cfs_throttled_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])) / clamp_min(sum by (namespace, pod, container) (rate(container_cpu_cfs_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])), 0.001))', unit: "percent"),
      prom("Memory Working Set Top", 'topk(15, sum by (namespace, pod, container) (container_memory_working_set_bytes{namespace=~"${namespace:regex}",container!="",container!="POD"}))', unit: "bytes"),
      prom("Memory Limit Usage", '100 * sum by (namespace, pod, container) (container_memory_working_set_bytes{namespace=~"${namespace:regex}",container!="",container!="POD"}) / clamp_min(sum by (namespace, pod, container) (kube_pod_container_resource_limits{namespace=~"${namespace:regex}",resource="memory",unit="byte"}), 1)', unit: "percent"),
      prom("Restart Detail", 'sum by (namespace, pod, container) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__range]))'),
      prom("OOMKilled Detail", 'sum by (namespace, pod, container) (max_over_time(kube_pod_container_status_last_terminated_reason{namespace=~"${namespace:regex}",reason="OOMKilled"}[$__range]) == 1)'),
      prom("Network Receive", 'sum by (namespace, pod) (rate(container_network_receive_bytes_total{namespace=~"${namespace:regex}",pod!=""}[$__rate_interval]))', unit: "Bps"),
      prom("Network Transmit", 'sum by (namespace, pod) (rate(container_network_transmit_bytes_total{namespace=~"${namespace:regex}",pod!=""}[$__rate_interval]))', unit: "Bps")
    ]],
    ["12-node-pressure-overview.json", "dropmong-ops-12-node-pressure", "Ops 12 - Node Pressure and Scheduling", common_variables, [
      text("Final Infrastructure Step", "Use node pressure only after the affected service and Pod are known. This prevents unrelated cluster noise from becoming the first suspect."),
      prom("Not Ready Nodes", 'sum by (node) (kube_node_status_condition{condition="Ready",status!="true"} == 1)', type: "stat"),
      prom("MemoryPressure Nodes", 'sum by (node) (kube_node_status_condition{condition="MemoryPressure",status="true"} == 1)', type: "stat"),
      prom("DiskPressure Nodes", 'sum by (node) (kube_node_status_condition{condition="DiskPressure",status="true"} == 1)', type: "stat"),
      prom("PIDPressure Nodes", 'sum by (node) (kube_node_status_condition{condition="PIDPressure",status="true"} == 1)', type: "stat"),
      prom("Node CPU Utilization", '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])))', unit: "percent"),
      prom("Node Memory Utilization", '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', unit: "percent"),
      prom("Filesystem Usage", '100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})', unit: "percent"),
      prom("Pending Pods", 'sum by (namespace, pod) (kube_pod_status_phase{namespace=~"${namespace:regex}",phase="Pending"} == 1)'),
      prom("Unschedulable Pods", 'sum by (namespace, pod) (kube_pod_status_unschedulable{namespace=~"${namespace:regex}"} == 1)')
    ]],
    ["payment-service-metrics.json", "dropmong-ops-payment-service", "Ops - Payment Service Detail", common_variables(services: ["payment-service"], namespaces: ["dropmong-payment"]), [
      text("Scope", "Payment detail uses only the current /payments route templates, PostgreSQL exporter signals and structured Kafka/HTTP logs."),
      prom("Payment Request Rate", request_rate(HTTP + ',service_name="payment-service",http_route=~"/payments.*"', by: "http_route"), unit: "reqps"),
      prom("Payment p95 / p99 Latency", [[p95(HTTP + ',service_name="payment-service",http_route=~"/payments.*"', by: "http_route"), "p95 {{http_route}}"], [p99(HTTP + ',service_name="payment-service",http_route=~"/payments.*"', by: "http_route"), "p99 {{http_route}}"]], unit: "s"),
      prom("Payment 4xx / 5xx Ratio", [[error_ratio("4..", HTTP + ',service_name="payment-service",http_route=~"/payments.*"', by: "http_route"), "4xx {{http_route}}"], [error_ratio("5..", HTTP + ',service_name="payment-service",http_route=~"/payments.*"', by: "http_route"), "5xx {{http_route}}"]], unit: "percent"),
      prom("Active Payment Requests", 'sum by (http_route) (http_server_active_requests{service_name="payment-service",http_route=~"/payments.*",http_route_kind="api"})'),
      prom("Payment DB Transactions", 'sum by (datname) (rate(pg_stat_database_xact_commit{namespace="dropmong-payment",datname!~"template.*|postgres"}[$__rate_interval]))', unit: "ops"),
      loki("Payment Kafka Results", '{service_name="payment-service"} | json | event=~"kafka[.]message[.](publish|process)" | line_format "topic={{.messaging_destination_name}} outcome={{.outcome}} correlation_id={{.correlation_id}} trace_id={{.trace_id}}"'),
      loki("Payment Errors", '{service_name="payment-service"} | json | severity_text=~"ERROR|CRITICAL" | line_format "event={{.event}} route={{.http_route}} code={{.http_error_code}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"')
    ]]
  ],
  "logs" => [
    ["logs-10-overview.json", "dropmong-logs-10-overview", "Logs 10 - Overview", logs_variables, [
      text("Investigation Start", "Start with broad HTTP, slow-request, application-error and Kafka-failure counts. Continue to Logs 20 after choosing a service and time range."),
      loki("5xx Requests", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | http_route_kind="api" | http_status_code=~"5.." [$__interval]))', type: "timeseries"),
      loki("Slow Requests", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | http_route_kind="api" | duration_ms >= $min_duration_ms [$__interval]))', type: "timeseries"),
      loki("Warn and Error Logs", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | severity_text=~"WARN|ERROR|CRITICAL" [$__interval]))', type: "timeseries"),
      loki("Kafka Failures", 'sum by (service_name) (count_over_time({service_name=~"(interest-service|order-service|payment-service|notification-service)"} | json | event=~"kafka[.]message[.](publish|process)" | outcome="failure" [$__interval]))', type: "timeseries"),
      prom("Metric 5xx Ratio", error_ratio("5.."), unit: "percent"),
      loki("Recent Warn and Error Detail", APP_LOGS + ' | json | severity_text=~"WARN|ERROR|CRITICAL" | line_format "service={{.service_name}} event={{.event}} request_id={{.request_id}} trace_id={{.trace_id}}"')
    ]],
    ["logs-20-services.json", "dropmong-logs-20-services", "Logs 20 - Services and Routes", logs_variables, [
      text("Scope", "Compare bounded service, route and status fields. Raw URL and user identifiers are intentionally not Loki labels."),
      loki("Log Volume by Service", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' [$__interval]))', type: "timeseries"),
      loki("5xx by Service", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | http_status_code=~"5.." [$__interval]))', type: "timeseries"),
      loki("Slow Requests by Service", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | duration_ms >= $min_duration_ms [$__interval]))', type: "timeseries"),
      loki("5xx Count by Route", 'topk(30, sum by (service_name, http_route, http_status_code) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | http_route=~"${route:regex}" | http_status_code=~"5.." [$__range])))', type: "table"),
      loki("Status Code Distribution", 'sum by (service_name, http_status_code) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" [$__interval]))', type: "timeseries"),
      loki("Recent Request Logs", APP_LOGS + ' | json | event="http.request.completed" | http_route=~"${route:regex}" | line_format "service={{.service_name}} route={{.http_route}} status={{.http_status_code}} duration_ms={{.duration_ms}} request_id={{.request_id}} trace_id={{.trace_id}}"')
    ]],
    ["logs-25-service-log-search.json", "dropmong-logs-25-service-search", "Logs 25 - Service Log Search", logs_variables, [
      text("Search Contract", "IDs are parsed from JSON log bodies, not selected as Loki labels. Use a specific value; the default a^ intentionally matches nothing."),
      loki("Recent Request Logs with IDs", APP_LOGS + ' | json | event="http.request.completed" | line_format "service={{.service_name}} route={{.http_route}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"'),
      loki("Request ID Search", APP_LOGS + ' | json | request_id=~"$request_id"'),
      loki("Trace ID Search", APP_LOGS + ' | json | trace_id=~"$trace_id"'),
      loki("Span ID Search", APP_LOGS + ' | json | span_id=~"$span_id"'),
      tempo_search("Recent Tempo Traces", '{ resource.service.name =~ "${service:regex}" }')
    ]],
    ["logs-30-service-errors.json", "dropmong-logs-30-service-errors", "Logs 30 - Service Errors", logs_variables, [
      text("Scope", "Separate completed HTTP 5xx logs from application ERROR/CRITICAL events and Collector export failures."),
      loki("Error Trend by Service", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | severity_text=~"ERROR|CRITICAL" [$__interval]))', type: "timeseries"),
      loki("HTTP 5xx Trend", 'sum by (service_name, http_route) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | http_status_code=~"5.." [$__interval]))', type: "timeseries"),
      loki("Application Error Detail", APP_LOGS + ' | json | severity_text=~"ERROR|CRITICAL" | line_format "service={{.service_name}} event={{.event}} code={{.http_error_code}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"'),
      loki("HTTP 5xx Detail", APP_LOGS + ' | json | event="http.request.completed" | http_status_code=~"5.." | line_format "service={{.service_name}} route={{.http_route}} status={{.http_status_code}} request_id={{.request_id}} trace_id={{.trace_id}}"'),
      loki("Collector Export Failure Detail", '{k8s_namespace_name="observability",k8s_container_name="opentelemetry-collector"} |~ "(?i)(exporting failed|failed to export|sending_queue is full)"')
    ]],
    ["logs-40-drilldown.json", "dropmong-logs-40-drilldown", "Logs 40 - ID Drilldown", logs_variables, [
      text("Scope", "Correlate one request, distributed trace, span or Kafka message across services."),
      loki("Request ID", '{k8s_namespace_name=~"dropmong-.*"} | json | request_id=~"$request_id"'),
      loki("Trace ID", '{k8s_namespace_name=~"dropmong-.*"} | json | trace_id=~"$trace_id"'),
      loki("Span ID", '{k8s_namespace_name=~"dropmong-.*"} | json | trace_id=~"$trace_id" | span_id=~"$span_id"'),
      loki("Kafka Correlation ID", '{k8s_namespace_name=~"dropmong-.*"} | json | correlation_id=~"$correlation_id"'),
      tempo_trace
    ]],
    ["logs-50-trace-correlation.json", "dropmong-logs-50-trace-correlation", "Logs 50 - Trace Correlation", logs_variables, [
      text("Trace Boundary", "dropmong-web propagates trace context, but its own OTLP span export is unverified. Use its trace_id to find downstream service traces."),
      loki("Requests Missing Trace ID", 'sum by (service_name) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | trace_id="" [$__interval]))', type: "timeseries"),
      loki("Logs for Selected Trace", '{k8s_namespace_name=~"dropmong-.*"} | json | trace_id=~"$trace_id" | line_format "service={{.service_name}} event={{.event}} span_id={{.span_id}} request_id={{.request_id}}"'),
      tempo_trace,
      tempo_search("Error or Slow Traces", '{ resource.service.name =~ "${service:regex}" && (status = error || duration > 1s) }')
    ]],
    ["logs-70-platform.json", "dropmong-logs-70-platform", "Logs 70 - Platform", logs_variables, [
      text("Scope", "Inspect Collector, observability backends, PostgreSQL and Kafka only after application evidence points to a platform dependency."),
      loki("Collector and Backend Warnings", '{k8s_namespace_name=~"observability|monitoring"} |~ "(?i)(warn|error|failed|timeout)"'),
      loki("PostgreSQL Warnings", '{k8s_namespace_name=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)",k8s_pod_name=~".*-db-.*"} |~ "(?i)(error|fatal|deadlock|too many connections)"'),
      loki("Kafka Warnings", '{k8s_namespace_name="dropmong-messaging"} |~ "(?i)(warn|error|failed|timeout)"'),
      prom("Collector Queue Utilization", '100 * sum by (exporter, data_type) (otelcol_exporter_queue_size) / clamp_min(sum by (exporter, data_type) (otelcol_exporter_queue_capacity), 1)', unit: "percent"),
      prom("PostgreSQL Up", 'min by (namespace, pod) (pg_up{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)"})', type: "stat", unit: "none")
    ]],
    ["logs-80-service-trace-detail.json", "dropmong-logs-80-service-trace-detail", "Logs 80 - Service Trace Detail", logs_variables, [
      text("Final Service Step", "Keep one service selected and join its RED metrics, structured logs and Tempo traces."),
      prom("Request Rate", request_rate, unit: "reqps"),
      prom("p95 / p99 Duration", [[p95, "p95"], [p99, "p99"]], unit: "s"),
      prom("5xx Ratio", error_ratio("5.."), unit: "percent"),
      loki("Recent Error Logs", APP_LOGS + ' | json | severity_text=~"ERROR|CRITICAL"'),
      loki("Slow Request Logs", APP_LOGS + ' | json | event="http.request.completed" | duration_ms >= $min_duration_ms'),
      loki("Selected Request Logs", APP_LOGS + ' | json | request_id=~"$request_id"'),
      loki("Selected Trace Logs", APP_LOGS + ' | json | trace_id=~"$trace_id"'),
      tempo_trace,
      tempo_search("Recent Error or Slow Traces", '{ resource.service.name =~ "${service:regex}" && (status = error || duration > 1s) }')
    ]],
    ["logs-30-kafka-correlation.json", "dropmong-logs-30-kafka-correlation", "Logs 30 - Kafka Correlation", logs_variables, [
      text("Kafka Scope", "Only interest, order, payment and notification use the active broker contract. IDs remain JSON fields."),
      loki("Operations by Topic", 'sum by (service_name, messaging_destination_name, outcome) (count_over_time({service_name=~"(interest-service|order-service|payment-service|notification-service)"} | json | event=~"kafka[.]message[.](publish|process)" | messaging_destination_name=~"${topic:regex}" | outcome=~"${outcome:regex}" [$__interval]))', type: "timeseries"),
      loki("Kafka Failures", 'sum(count_over_time({service_name=~"(interest-service|order-service|payment-service|notification-service)"} | json | event=~"kafka[.]message[.](publish|process)" | outcome="failure" [$__range]))', type: "stat"),
      loki("Kafka Completion Logs", '{service_name=~"(interest-service|order-service|payment-service|notification-service)"} | json | event=~"kafka[.]message[.](publish|process)" | messaging_destination_name=~"${topic:regex}" | outcome=~"${outcome:regex}" | line_format "service={{.service_name}} topic={{.messaging_destination_name}} operation={{.messaging_operation}} outcome={{.outcome}} correlation_id={{.correlation_id}} trace_id={{.trace_id}} span_id={{.span_id}}"'),
      loki("Correlation ID Across Services", '{k8s_namespace_name=~"dropmong-.*"} | json | correlation_id=~"$correlation_id"'),
      tempo_search("Recent Kafka Traces", '{ resource.service.name =~ "(interest-service|order-service|payment-service|notification-service)" && span.messaging.system = "kafka" }'),
      tempo_trace
    ]]
  ],
  "db" => [
    ["db-10-operations-overview.json", "dropmong-db-10-operations", "DB 10 - PostgreSQL Operations Overview", db_variables, [
      text("DB Owners", "Scope is limited to auth, user, catalog, coupon, interest, order and payment PostgreSQL. notification and dropmong-web are excluded from the active DB contract."),
      prom("PostgreSQL Up", 'min by (namespace, pod) (pg_up{namespace=~"${namespace:regex}"})', type: "stat", unit: "none"),
      prom("Connection Usage", '100 * sum by (namespace) (pg_stat_activity_count{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}) / clamp_min(sum by (namespace) (pg_settings_max_connections{namespace=~"${namespace:regex}"}), 1)', unit: "percent"),
      prom("Transactions per Second", [['sum by (namespace) (rate(pg_stat_database_xact_commit{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]))', "commit {{namespace}}"], ['sum by (namespace) (rate(pg_stat_database_xact_rollback{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]))', "rollback {{namespace}}"]], unit: "ops"),
      prom("Rollback Ratio", '100 * sum by (namespace) (rate(pg_stat_database_xact_rollback{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval])) / clamp_min(sum by (namespace) (rate(pg_stat_database_xact_commit{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]) + rate(pg_stat_database_xact_rollback{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval])), 0.001)', unit: "percent"),
      prom("Cache Hit Ratio", '100 * sum by (namespace) (rate(pg_stat_database_blks_hit{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval])) / clamp_min(sum by (namespace) (rate(pg_stat_database_blks_hit{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]) + rate(pg_stat_database_blks_read{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval])), 0.001)', unit: "percent"),
      prom("Deadlock Increase", 'sum by (namespace) (increase(pg_stat_database_deadlocks{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]))'),
      prom("Locks by Mode", 'sum by (namespace, mode) (pg_locks_count{namespace=~"${namespace:regex}"})')
    ]],
    ["db-20-instance-resources.json", "dropmong-db-20-instance-resources", "DB 20 - Instance Resources", db_variables, [
      text("Scope", "After DB 10 identifies an owner namespace, inspect its PostgreSQL Pod and storage resources."),
      prom("Ready DB Pods", 'sum by (namespace, pod) (kube_pod_status_ready{namespace=~"${namespace:regex}",pod=~".*-db-.*",condition="true"} == 1)', type: "stat"),
      prom("DB Pod Restarts", 'sum by (namespace, pod, container) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}",pod=~".*-db-.*"}[$__range]))'),
      prom("DB OOMKilled", 'sum by (namespace, pod, container) (max_over_time(kube_pod_container_status_last_terminated_reason{namespace=~"${namespace:regex}",pod=~".*-db-.*",reason="OOMKilled"}[$__range]) == 1)'),
      prom("DB Pod CPU", "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{#{DB_PODS}}[$__rate_interval]))", unit: "cores"),
      prom("DB Pod Memory", "sum by (namespace, pod) (container_memory_working_set_bytes{#{DB_PODS}})", unit: "bytes"),
      prom("DB Network Receive", 'sum by (namespace, pod) (rate(container_network_receive_bytes_total{namespace=~"${namespace:regex}",pod=~".*-db-.*"}[$__rate_interval]))', unit: "Bps"),
      prom("DB Network Transmit", 'sum by (namespace, pod) (rate(container_network_transmit_bytes_total{namespace=~"${namespace:regex}",pod=~".*-db-.*"}[$__rate_interval]))', unit: "Bps"),
      prom("PVC Usage", '100 * kubelet_volume_stats_used_bytes{namespace=~"${namespace:regex}"} / clamp_min(kubelet_volume_stats_capacity_bytes{namespace=~"${namespace:regex}"}, 1)', unit: "percent")
    ]],
    ["db-30-workload-and-slow-queries.json", "dropmong-db-30-workload", "DB 30 - Workload and Slow Operations", db_variables, [
      text("Signal Boundary", "PostgreSQL exporter workload is verified locally. Application slow-operation metrics are not assumed; slow DB work is searched through Tempo spans and structured error logs."),
      prom("Connections by State", 'sum by (namespace, state) (pg_stat_activity_count{namespace=~"${namespace:regex}",datname!~"template.*|postgres"})'),
      prom("Transactions", [['sum by (namespace) (rate(pg_stat_database_xact_commit{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]))', "commit"], ['sum by (namespace) (rate(pg_stat_database_xact_rollback{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]))', "rollback"]], unit: "ops"),
      prom("Tuple Workload", 'sum by (namespace) (rate(pg_stat_database_tup_fetched{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]) + rate(pg_stat_database_tup_inserted{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]) + rate(pg_stat_database_tup_updated{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]) + rate(pg_stat_database_tup_deleted{namespace=~"${namespace:regex}",datname!~"template.*|postgres"}[$__rate_interval]))', unit: "ops"),
      prom("Locks", 'sum by (namespace, mode) (pg_locks_count{namespace=~"${namespace:regex}"})'),
      prom("Deadlocks", 'sum by (namespace) (increase(pg_stat_database_deadlocks{namespace=~"${namespace:regex}"}[$__range]))'),
      tempo_search("Slow or Failed PostgreSQL Spans", '{ resource.service.name =~ "${service:regex}" && span.db.system = "postgresql" && (status = error || duration > $min_duration) }'),
      loki("DB-owner Service Errors", APP_LOGS + ' | json | severity_text=~"ERROR|CRITICAL" | line_format "service={{.service_name}} event={{.event}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"')
    ]],
    ["db-40-trace-and-log-correlation.json", "dropmong-db-40-trace-correlation", "DB 40 - Trace and Log Correlation", db_variables, [
      text("Final DB Step", "Select a slow or failed PostgreSQL span, copy its trace_id, then compare the same trace, request and span in Loki and Tempo."),
      tempo_search("Slow or Failed PostgreSQL Traces", '{ resource.service.name =~ "${service:regex}" && span.db.system = "postgresql" && (status = error || duration > $min_duration) }'),
      loki("Selected Trace Logs", APP_LOGS + ' | json | trace_id=~"$trace_id" | line_format "service={{.service_name}} event={{.event}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"'),
      loki("Selected Request Logs", APP_LOGS + ' | json | request_id=~"$request_id"'),
      loki("Selected Span Logs", APP_LOGS + ' | json | trace_id=~"$trace_id" | span_id=~"$span_id"'),
      tempo_trace
    ]]
  ],
  "load" => [
    ["load-10-api-load-overview.json", "dropmong-load-10-api-overview", "Load 10 - API Load Overview", load_variables, [
      text("Load Entry", "Use current service and route templates. This screen reports observed application traffic; it does not infer a target RPS without runner evidence."),
      prom("Request Rate by Route", request_rate(HTTP, by: "service_name, http_route"), unit: "reqps"),
      prom("p95 / p99 by Route", [[p95(HTTP, by: "service_name, http_route"), "p95 {{service_name}} {{http_route}}"], [p99(HTTP, by: "service_name, http_route"), "p99 {{service_name}} {{http_route}}"]], unit: "s"),
      prom("5xx Ratio by Route", error_ratio("5..", HTTP, by: "service_name, http_route"), unit: "percent"),
      prom("Active Requests", "sum by (service_name, http_route) (http_server_active_requests{#{HTTP}})"),
      prom("Service Readiness", 'min by (service_name) (service_ready{service_name=~"${service:regex}"})', type: "stat", unit: "none"),
      prom("Pod CPU", "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{#{APP_CONTAINERS}}[$__rate_interval]))", unit: "cores"),
      prom("Pod Memory", "sum by (namespace, pod) (container_memory_working_set_bytes{#{APP_CONTAINERS}})", unit: "bytes")
    ]],
    ["load-20-latency-and-errors.json", "dropmong-load-20-latency-errors", "Load 20 - Latency and Errors", load_variables, [
      text("Scope", "Compare latency percentiles, average duration and status families for the selected current route templates."),
      prom("p50 Latency", 'histogram_quantile(0.50, sum by (service_name, http_route, le) (rate(http_server_request_duration_seconds_bucket{' + HTTP + '}[$__rate_interval])))', unit: "s"),
      prom("p95 Latency", p95(HTTP, by: "service_name, http_route"), unit: "s"),
      prom("p99 Latency", p99(HTTP, by: "service_name, http_route"), unit: "s"),
      prom("Average Latency", 'sum by (service_name, http_route) (rate(http_server_request_duration_seconds_sum{' + HTTP + '}[$__rate_interval])) / clamp_min(sum by (service_name, http_route) (rate(http_server_request_duration_seconds_count{' + HTTP + '}[$__rate_interval])), 0.001)', unit: "s"),
      prom("4xx Ratio", error_ratio("4..", HTTP, by: "service_name, http_route"), unit: "percent"),
      prom("5xx Ratio", error_ratio("5..", HTTP, by: "service_name, http_route"), unit: "percent"),
      prom("Response Code Distribution", 'sum by (service_name, http_route, http_response_status_code) (rate(http_server_request_duration_seconds_count{' + HTTP + '}[$__rate_interval]))', unit: "reqps")
    ]],
    ["load-30-service-saturation.json", "dropmong-load-30-saturation", "Load 30 - Service Saturation", load_variables, [
      text("Scope", "Correlate active requests with CPU, throttling, memory and restarts. A high value is a candidate, not proof of root cause."),
      prom("Active Requests", "sum by (service_name, http_route) (http_server_active_requests{#{HTTP}})"),
      prom("CPU Usage", "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{#{APP_CONTAINERS}}[$__rate_interval]))", unit: "cores"),
      prom("CPU Throttling", '100 * sum by (namespace, pod) (rate(container_cpu_cfs_throttled_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])) / clamp_min(sum by (namespace, pod) (rate(container_cpu_cfs_periods_total{namespace=~"${namespace:regex}",container!="",container!="POD"}[$__rate_interval])), 0.001)', unit: "percent"),
      prom("Memory Working Set", "sum by (namespace, pod) (container_memory_working_set_bytes{#{APP_CONTAINERS}})", unit: "bytes"),
      prom("Memory Limit Ratio", '100 * sum by (namespace, pod) (container_memory_working_set_bytes{namespace=~"${namespace:regex}",container!="",container!="POD"}) / clamp_min(sum by (namespace, pod) (kube_pod_container_resource_limits{namespace=~"${namespace:regex}",resource="memory",unit="byte"}), 1)', unit: "percent"),
      prom("Pod Restarts", 'sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}"}[$__range]))'),
      prom("HPA Desired vs Current", [['sum by (namespace, horizontalpodautoscaler) (kube_horizontalpodautoscaler_status_desired_replicas{namespace=~"${namespace:regex}"})', "desired"], ['sum by (namespace, horizontalpodautoscaler) (kube_horizontalpodautoscaler_status_current_replicas{namespace=~"${namespace:regex}"})', "current"]])
    ]],
    ["load-40-cause-candidates.json", "dropmong-load-40-candidates", "Load 40 - Cause Candidates", load_variables, [
      text("Candidate Rule", "This screen narrows candidates; it does not declare the cause. Compare the same time range across request pressure, compute, PostgreSQL and restarts."),
      prom("Request Pressure", "sum by (service_name) (http_server_active_requests{#{HTTP}})"),
      prom("p99 Latency", p99, unit: "s"),
      prom("Pod CPU", "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{#{APP_CONTAINERS}}[$__rate_interval]))", unit: "cores"),
      prom("PostgreSQL Connection Usage", '100 * sum by (namespace) (pg_stat_activity_count{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)",datname!~"template.*|postgres"}) / clamp_min(sum by (namespace) (pg_settings_max_connections{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)"}), 1)', unit: "percent"),
      prom("PostgreSQL Rollbacks", 'sum by (namespace) (rate(pg_stat_database_xact_rollback{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)",datname!~"template.*|postgres"}[$__rate_interval]))', unit: "ops"),
      prom("Pod Restarts", 'sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{namespace=~"${namespace:regex}"}[$__range]))'),
      prom("Collector Queue Utilization", '100 * sum by (exporter, data_type) (otelcol_exporter_queue_size) / clamp_min(sum by (exporter, data_type) (otelcol_exporter_queue_capacity), 1)', unit: "percent")
    ]],
    ["load-50-service-resource-and-traffic.json", "dropmong-load-50-resources", "Load 50 - Service, DB and Kafka Resources", load_variables, [
      text("Scope", "Compare application traffic with current service, PostgreSQL and Kafka Pod resources. No MongoDB or Kong metric is assumed."),
      prom("Service Request Rate", request_rate, unit: "reqps"),
      prom("Service CPU", "sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{#{APP_CONTAINERS}}[$__rate_interval]))", unit: "cores"),
      prom("Service Memory", "sum by (namespace, pod) (container_memory_working_set_bytes{#{APP_CONTAINERS}})", unit: "bytes"),
      prom("Service Network RX", 'sum by (namespace, pod) (rate(container_network_receive_bytes_total{namespace=~"${namespace:regex}",pod!=""}[$__rate_interval]))', unit: "Bps"),
      prom("PostgreSQL CPU", 'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)",pod=~".*-db-.*",container!="",container!="POD"}[$__rate_interval]))', unit: "cores"),
      prom("PostgreSQL Memory", 'sum by (namespace, pod) (container_memory_working_set_bytes{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)",pod=~".*-db-.*",container!="",container!="POD"})', unit: "bytes"),
      prom("PostgreSQL Connections", 'sum by (namespace, state) (pg_stat_activity_count{namespace=~"dropmong-(auth|user|catalog|coupon|interest|order|payment)",datname!~"template.*|postgres"})'),
      prom("Kafka CPU", 'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{namespace="dropmong-messaging",pod=~"kafka-.*",container!="",container!="POD"}[$__rate_interval]))', unit: "cores"),
      prom("Kafka Memory", 'sum by (namespace, pod) (container_memory_working_set_bytes{namespace="dropmong-messaging",pod=~"kafka-.*",container!="",container!="POD"})', unit: "bytes")
    ]],
    ["load-60-runner-execution.json", "dropmong-load-60-runner", "Load 60 - Runner Execution Evidence", load_variables, [
      text("Verified Boundary", "The Collector accepts application/k6 stdout JSON, but k6 Prometheus remote-write metrics are not enabled. This screen uses runner logs only; an empty screen means no runner log was collected."),
      loki("Runner Log Volume", 'sum by (k8s_pod_name) (count_over_time({k8s_namespace_name=~"dropmong-.*",k8s_pod_name=~".*k6.*"} [$__interval]))', type: "timeseries"),
      loki("Selected Run Logs", '{k8s_namespace_name=~"dropmong-.*",k8s_pod_name=~".*k6.*"} | json | run_id=~"$run_id"'),
      loki("Runner Failures", '{k8s_namespace_name=~"dropmong-.*",k8s_pod_name=~".*k6.*"} | json |~ "(?i)(fail|error|threshold)"'),
      loki("Run Conditions", '{k8s_namespace_name=~"dropmong-.*",k8s_pod_name=~".*k6.*"} | json | run_id=~"$run_id" | line_format "run_id={{.run_id}} scenario={{.scenario}} profile={{.profile}} target={{.target}} result={{.result}}"')
    ]],
    ["load-70-slow-trace-discovery.json", "dropmong-load-70-slow-traces", "Load 70 - Slow Trace Discovery", load_variables, [
      text("Final Load Step", "Use route and time range from Load 10-50, find slow request logs, copy trace_id, then open the matching Tempo trace."),
      loki("Slow Request Count by Route", 'sum by (service_name, http_route) (count_over_time(' + APP_LOGS + ' | json | event="http.request.completed" | http_route=~"${route:regex}" | duration_ms >= $min_duration_ms [$__interval]))', type: "timeseries"),
      loki("Slow Request Logs", APP_LOGS + ' | json | event="http.request.completed" | http_route=~"${route:regex}" | duration_ms >= $min_duration_ms | line_format "service={{.service_name}} route={{.http_route}} duration_ms={{.duration_ms}} request_id={{.request_id}} trace_id={{.trace_id}} span_id={{.span_id}}"'),
      tempo_search("Tempo Traces over Threshold", '{ resource.service.name =~ "${service:regex}" && duration > 1s }'),
      loki("Selected Trace Logs", '{k8s_namespace_name=~"dropmong-.*"} | json | trace_id=~"$trace_id"'),
      tempo_trace
    ]]
  ]
}.freeze

GROUPS.each do |group, definitions|
  directory = File.join(ROOT, "dashboards", group)
  FileUtils.mkdir_p(directory)
  expected = definitions.map(&:first)
  Dir.glob(File.join(directory, "*.json")).each do |path|
    File.delete(path) unless expected.include?(File.basename(path))
  end
  definitions.each_with_index do |(filename, uid, title, variables, panels), index|
    previous_uid = index.zero? ? nil : definitions[index - 1][1]
    next_uid = index == definitions.length - 1 ? nil : definitions[index + 1][1]
    output = dashboard(uid: uid, title: title, group: group, variables: variables, panels: panels, previous_uid: previous_uid, next_uid: next_uid)
    File.write(File.join(directory, filename), JSON.pretty_generate(output) + "\n")
  end
end

puts GROUPS.map { |group, definitions| "#{group}=#{definitions.length}" }.join(" ")
