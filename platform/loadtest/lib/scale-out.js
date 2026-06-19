import http from 'k6/http';
import { Trend } from 'k6/metrics';

const SCALE_OUT_ENABLED = __ENV.LOADTEST_SCALE_OUT_REPORT_ENABLED === 'true';
const SERVICE_ACCOUNT_TOKEN = SCALE_OUT_ENABLED ? open('/var/run/secrets/kubernetes.io/serviceaccount/token') : '';
const KUBERNETES_API = (__ENV.KUBERNETES_SERVICE_HOST && __ENV.KUBERNETES_SERVICE_PORT)
  ? `https://${__ENV.KUBERNETES_SERVICE_HOST}:${__ENV.KUBERNETES_SERVICE_PORT}`
  : 'https://kubernetes.default.svc';

function safeMetricSuffix(target) {
  return `${target.namespace}_${target.service}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

function metricSet(target) {
  const suffix = safeMetricSuffix(target);
  return {
    baselineReplicas: new Trend(`loadtest_scale_out_${suffix}_baseline_replicas`),
    desiredReplicas: new Trend(`loadtest_scale_out_${suffix}_desired_replicas`),
    hpaDecisionSeconds: new Trend(`loadtest_scale_out_${suffix}_hpa_decision_seconds`),
    readySeconds: new Trend(`loadtest_scale_out_${suffix}_ready_seconds`),
  };
}

const SCALE_OUT_TARGETS = SCALE_OUT_ENABLED ? JSON.parse(__ENV.LOADTEST_SCALE_OUT_REPORT_TARGETS || '[]') : [];
const SCALE_OUT_METRICS = Object.fromEntries(SCALE_OUT_TARGETS.map((target) => [target.service, metricSet(target)]));

function kubernetesGet(path) {
  const response = http.get(`${KUBERNETES_API}${path}`, {
    headers: {
      Authorization: `Bearer ${SERVICE_ACCOUNT_TOKEN}`,
      Accept: 'application/json',
    },
    timeout: '5s',
    responseCallback: http.expectedStatuses(200),
  });
  if (response.status !== 200) {
    throw new Error(`Kubernetes API ${path} returned ${response.status}`);
  }
  try {
    return response.json();
  } catch (error) {
    throw new Error(`Kubernetes API ${path} returned invalid JSON: ${error.message}`);
  }
}

function hpaPath(target) {
  return `/apis/autoscaling/v2/namespaces/${encodeURIComponent(target.namespace)}/horizontalpodautoscalers/${encodeURIComponent(target.hpa || target.service)}`;
}

function deploymentPath(target) {
  return `/apis/apps/v1/namespaces/${encodeURIComponent(target.namespace)}/deployments/${encodeURIComponent(target.deployment || target.service)}`;
}

function targetStatus(target) {
  const hpa = kubernetesGet(hpaPath(target));
  const deployment = kubernetesGet(deploymentPath(target));
  const desiredReplicas = Number(hpa.status && hpa.status.desiredReplicas !== undefined ? hpa.status.desiredReplicas : hpa.spec.minReplicas);
  const currentReplicas = Number(hpa.status && hpa.status.currentReplicas !== undefined ? hpa.status.currentReplicas : 0);
  const readyReplicas = Number(deployment.status && deployment.status.readyReplicas !== undefined ? deployment.status.readyReplicas : 0);
  return {
    service: target.service,
    namespace: target.namespace,
    baselineReplicas: Number.isFinite(currentReplicas) ? currentReplicas : 0,
    desiredReplicas: Number.isFinite(desiredReplicas) ? desiredReplicas : 0,
    readyReplicas: Number.isFinite(readyReplicas) ? readyReplicas : 0,
  };
}

export function scaleOutOptions(config) {
  return config.scaleOutReport && config.scaleOutReport.enabled
    ? { insecureSkipTLSVerify: true }
    : {};
}

export function setupScaleOutBaselines(config) {
  if (!config.scaleOutReport || !config.scaleOutReport.enabled) {
    return [];
  }
  return config.scaleOutReport.targets.map((target) => targetStatus(target));
}

export function observeScaleOut(config, setupData, iteration) {
  const scaleOut = config.scaleOutReport || {};
  if (!scaleOut.enabled || !Array.isArray(setupData.scaleOutBaselines)) {
    return;
  }
  const pollEvery = Math.max(1, scaleOut.pollEveryIterations || 10);
  if (iteration % pollEvery !== 0) {
    return;
  }
  const elapsedSeconds = (Date.now() - setupData.measurementStartedAtMs) / 1000;
  const baselines = Object.fromEntries(setupData.scaleOutBaselines.map((target) => [target.service, target]));
  for (const target of scaleOut.targets) {
    const baseline = baselines[target.service];
    if (!baseline) {
      throw new Error(`Missing scale-out baseline for ${target.service}`);
    }
    const status = targetStatus(target);
    const metrics = SCALE_OUT_METRICS[target.service];
    metrics.baselineReplicas.add(baseline.baselineReplicas);
    metrics.desiredReplicas.add(status.desiredReplicas);
    if (status.desiredReplicas > baseline.baselineReplicas) {
      metrics.hpaDecisionSeconds.add(elapsedSeconds);
    }
    if (status.readyReplicas > baseline.baselineReplicas) {
      metrics.readySeconds.add(elapsedSeconds);
    }
  }
}
