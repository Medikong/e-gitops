import {
  classifyBottleneck,
  evaluateCompletedWindows,
  parseK6Points,
  rampExitIsExecutionFailure,
  reduceWindowDecisions,
} from './window.js';

function rampTrialId(service, replicas) {
  return `${service.slice(0, 10)}-r${replicas}-ramp-01`;
}

async function monitorRamp(context, service, trialId, handle) {
  const profile = context.profiles[service];
  const schedule = profile.ramp.schedule;
  const controlPath = `control/${service}/${trialId}.started`;
  const samplesPath = `raw/k6/${service}/${trialId}.samples.json`;
  const startDeadline = Date.now() + 130_000;
  let markerStartedAt = null;
  while (!markerStartedAt && Date.now() < startDeadline) {
    const marker = context.artifactTryRead(controlPath)?.trim();
    if (marker && Number.isFinite(Date.parse(marker))) markerStartedAt = marker;
    else if (handle.isDone()) break;
    else await context.sleep(500);
  }
  if (!markerStartedAt) throw context.executionError('k6_script', `${service} ramp 시작 marker를 확인하지 못했습니다`);

  let evaluationStartedAt = null;
  let offset = 0;
  let carry = '';
  let points = [];
  let windows = [];
  let stopRequested = false;
  let stopRequestedAt = null;
  let decision = reduceWindowDecisions([], profile.ramp.consecutiveBreachWindows);
  const hardDeadline = Date.parse(markerStartedAt) + (schedule.durationSeconds + 180) * 1000;
  do {
    const chunk = context.artifactReadIncremental(samplesPath, offset);
    offset = chunk.nextOffset;
    const combined = carry + chunk.text;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline >= 0) {
      points.push(...parseK6Points(combined.slice(0, lastNewline + 1)));
      carry = combined.slice(lastNewline + 1);
    } else carry = combined;
    const firstRequest = points.find((point) => point.metric === 'loadtest_requests');
    if (!evaluationStartedAt && firstRequest) evaluationStartedAt = new Date(firstRequest.timestamp).toISOString();
    if (!evaluationStartedAt) {
      if (handle.isDone()) break;
      await context.sleep(250);
      continue;
    }
    const evaluated = evaluateCompletedWindows(points, {
      startedAt: evaluationStartedAt,
      now: new Date().toISOString(),
      schedule,
      evaluationWindowSeconds: profile.ramp.evaluationWindowSeconds,
      minimumSamplesPerWindow: profile.ramp.minimumSamplesPerWindow,
      slo: profile.slo,
      endpointMix: profile.endpointMix,
    });
    if (evaluated.length !== windows.length) {
      windows = evaluated;
      decision = reduceWindowDecisions(windows, profile.ramp.consecutiveBreachWindows);
      context.execution.services[service].ramp = {
        status: 'running',
        schedule,
        evaluation_window_seconds: profile.ramp.evaluationWindowSeconds,
        minimum_samples_per_window: profile.ramp.minimumSamplesPerWindow,
        consecutive_breach_windows: profile.ramp.consecutiveBreachWindows,
        windows,
        last_healthy_rps: decision.last_healthy_rps,
        first_degraded_rps: decision.first_degraded_rps,
        stop_condition: decision.termination,
      };
      context.persist();
    }
    if (decision.termination && !stopRequested) {
      context.stopK6(trialId);
      stopRequested = true;
      stopRequestedAt = context.now();
    }
    if (handle.isDone()) break;
    if (Date.now() >= hardDeadline) throw context.executionError('kubernetes', `${service} ramp monitor timeout`);
    await context.sleep(1000);
  } while (true);
  return {
    startedAt: evaluationStartedAt ?? markerStartedAt,
    markerStartedAt,
    windows,
    decision,
    stopRequested,
    stopRequestedAt,
  };
}

export async function executeService(context, service) {
  const replicas = context.experiment.run.deployment.replicas;
  const profile = context.profiles[service];
  const schedule = profile.ramp.schedule;
  const trialId = rampTrialId(service, replicas);
  const durationSeconds = schedule.durationSeconds;
  const averageRps = (schedule.startRps + schedule.maxRps) / 2;
  const iterationBudget = Math.ceil(averageRps * durationSeconds) + 2;
  const writeAllocations = context.writeAllocations(service, averageRps, durationSeconds);

  // One Dataset Job per service. The same prepared fixture pool is used by the
  // continuous k6 ramp; it is never restored for each window or RPS segment.
  await context.prepareDataset(service, `${service.slice(0, 10)}-r${replicas}-ramp-dataset`);
  const handle = await context.beginK6({
    service,
    trialId,
    phase: 'ramp',
    targetRps: schedule.maxRps,
    measureSeconds: durationSeconds,
    writeAllocations,
    iterationBudget,
    eventProducer: service === 'notification-service',
  });
  const monitor = await monitorRamp(context, service, trialId, handle);
  const k6ExitCode = await handle.completion;
  const finishedAt = context.artifactTryRead(`control/${service}/${trialId}.finished`)?.trim() ?? context.now();
  const summary = context.readK6Summary(service, trialId, { allowMissing: true });
  const observability = await context.snapshotObservability({
    service,
    profile,
    startedAt: monitor.startedAt,
    finishedAt,
  });
  const decision = reduceWindowDecisions(monitor.windows, profile.ramp.consecutiveBreachWindows);
  const firstDegraded = decision.termination
    ? monitor.windows.find((window) => window.index === decision.termination.first_window_index)
    : null;
  const executionReasons = [];
  if (rampExitIsExecutionFailure(k6ExitCode, monitor.stopRequested)) {
    executionReasons.push({
      code: 'k6_execution_exit',
      category: 'execution',
      message: `k6 exited ${k6ExitCode}`,
    });
  }
  const status = executionReasons.length
    ? 'failed'
    : decision.termination
      ? 'bottleneck_reached'
      : 'max_rps_reached';
  const ramp = {
    status,
    schedule,
    evaluation_window_seconds: profile.ramp.evaluationWindowSeconds,
    minimum_samples_per_window: profile.ramp.minimumSamplesPerWindow,
    consecutive_breach_windows: profile.ramp.consecutiveBreachWindows,
    dataset_preparations: 1,
    dataset_profile: context.experiment.dataset.profile,
    replicas,
    trial_id: trialId,
    windows: monitor.windows,
    last_healthy_rps: decision.last_healthy_rps,
    first_degraded_rps: decision.first_degraded_rps,
    terminated_at: monitor.stopRequestedAt ?? finishedAt,
    stop_condition: decision.termination,
    first_bottleneck_candidate: classifyBottleneck(firstDegraded),
    k6_exit_code: k6ExitCode,
    execution_reasons: executionReasons,
    observability,
  };
  const record = {
    trial_id: trialId,
    service,
    replicas,
    phase: 'ramp',
    raw_k6_summary: summary,
    observability,
    metrics: {
      last_healthy_rps: ramp.last_healthy_rps,
      first_degraded_rps: ramp.first_degraded_rps,
      window_count: ramp.windows.length,
    },
    decision: {
      passed: executionReasons.length === 0,
      conclusive: true,
      criteria: 'execution_success',
      reasons: executionReasons,
    },
    started_at: monitor.startedAt,
    finished_at: ramp.terminated_at,
    error: executionReasons[0]?.message ?? null,
  };
  context.recordTrial(record);
  context.execution.services[service].ramp = ramp;
  context.execution.services[service].status = status;
  context.persist();
  if (executionReasons.length) throw context.executionError(executionReasons[0].category, executionReasons[0].message);
  return ['bottleneck_reached', 'max_rps_reached'].includes(status);
}
