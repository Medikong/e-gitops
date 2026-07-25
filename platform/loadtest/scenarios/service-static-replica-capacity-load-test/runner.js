import {
  createSearchState,
  evaluateK6Summary,
  finalizeSearch,
  nextSearchCandidate,
  recordTrial,
} from '../../scripts/adaptive.js';

function integerCandidate(value, state) {
  let candidate = Math.max(Math.round(value), Math.ceil(state.start_rps));
  candidate = Math.min(candidate, Math.floor(state.max_rps));
  if (state.last_pass_rps != null) candidate = Math.max(candidate, Math.floor(state.last_pass_rps) + 1);
  if (state.first_fail_rps != null) candidate = Math.min(candidate, Math.ceil(state.first_fail_rps) - 1);
  const attempted = new Set(state.trials.filter((trial) => trial.metrics).map((trial) => Math.trunc(trial.metrics.target_rps)));
  return candidate < state.start_rps || candidate > state.max_rps || attempted.has(candidate) ? null : candidate;
}

function policy(profile) {
  return {
    rps_tolerance: Number(profile.adaptive.rpsTolerance),
    max_error_rate: Number(profile.thresholds.errorRate),
    min_check_pass_rate: Number(profile.thresholds.checkPassRate),
    max_dropped_iterations: 0,
    p95_slo_ms: Number(profile.thresholds.p95Ms),
    p99_slo_ms: Number(profile.thresholds.p99Ms),
    // Observability is a post-run attachment. Its absence must not turn a
    // successful HTTP run into a failed capacity decision.
    required_observations: [],
  };
}

function verificationDecision(performanceDecision) {
  const executionReasons = performanceDecision.reasons.filter((reason) => reason.category === 'execution');
  return {
    passed: executionReasons.length === 0,
    conclusive: executionReasons.length === 0,
    threshold_passed: null,
    k6_exit_code: performanceDecision.k6_exit_code,
    criteria: 'execution_only',
    reasons: executionReasons,
    performance_evaluation: {
      applied: false,
      passed: performanceDecision.passed,
      conclusive: performanceDecision.conclusive,
      threshold_passed: performanceDecision.threshold_passed,
      reasons: performanceDecision.reasons,
    },
  };
}

function trialId(service, replicas, phase, sequence) {
  return `${service.slice(0, 10)}-r${replicas}-${phase.slice(0, 5)}-${String(sequence).padStart(2, '0')}`;
}

async function measuredTrial(context, service, targetRps, seconds, phase, sequence) {
  const replicas = context.experiment.run.deployment.replicas;
  const id = trialId(service, replicas, phase, sequence);
  const profile = context.profiles[service];
  const writeAllocations = context.writeAllocations(service, targetRps, seconds);
  const raw = await context.runK6({
    service,
    trialId: id,
    phase,
    targetRps,
    measureSeconds: seconds,
    writeAllocations,
    eventProducer: service === 'notification-service',
  });
  let evaluated;
  try {
    evaluated = evaluateK6Summary(raw.summary, policy(profile), {
      targetRps,
      durationSeconds: seconds,
      k6ExitCode: raw.k6ExitCode,
    });
  } catch (error) {
    const record = {
      trial_id: id,
      service,
      replicas,
      phase,
      metrics: null,
      raw_k6_summary: raw.summary ?? null,
      observability: raw.observability,
      decision: {
        passed: false,
        conclusive: false,
        threshold_passed: false,
        k6_exit_code: raw.k6ExitCode,
        reasons: [{ code: 'k6_summary_unavailable', category: 'execution', message: error.message }],
      },
      started_at: raw.startedAt,
      finished_at: raw.finishedAt,
      error: error.message,
    };
    context.recordTrial(record);
    return record;
  }
  const decision = context.experiment.run.verificationOnly
    ? verificationDecision(evaluated.decision)
    : evaluated.decision;
  const record = {
    trial_id: id,
    service,
    replicas,
    phase,
    metrics: evaluated.metrics,
    raw_k6_summary: raw.summary,
    observability: raw.observability,
    decision,
    started_at: raw.startedAt,
    finished_at: raw.finishedAt,
    error: null,
  };
  context.recordTrial(record);
  return record;
}

async function runVerification(context, service) {
  const replicas = context.experiment.run.deployment.replicas;
  const adaptive = context.profiles[service].adaptive;
  const targetRps = Number(adaptive.startRps);
  const warmup = Number(adaptive.trialWarmupSeconds);
  const measure = Number(adaptive.trialMeasureSeconds);
  const trials = [];

  // The Dataset Job is intentionally run exactly once per service. Fixture
  // pools are sized for all low-RPS smoke trials that follow.
  await context.prepareDataset(service, `${service.slice(0, 10)}-r${replicas}-dataset`);
  if (warmup > 0) {
    const warm = await measuredTrial(context, service, targetRps, warmup, 'warmup', 1);
    trials.push(warm);
    if (!warm.decision.passed) throw context.executionError('verification', `${service}/replicas-${replicas} warmup 실행 경로를 완료하지 못했습니다`);
  }
  const measurement = await measuredTrial(context, service, targetRps, measure, 'measurement', 1);
  trials.push(measurement);
  if (!measurement.decision.passed) throw context.executionError('verification', `${service}/replicas-${replicas} 측정 실행 경로를 완료하지 못했습니다`);
  await context.stabilize(service);
  return {
    replicas,
    search: { status: 'not_applicable', reliable_stable_rps: null, last_pass_rps: null, first_fail_rps: null },
    trials,
    confirmation: { stable_rps: null, repetitions: [] },
    verification: { execution_completed: true, performance_criteria_applied: false, measurement_trial_id: measurement.trial_id },
    status: 'completed',
  };
}

async function runCapacity(context, service) {
  const replicas = context.experiment.run.deployment.replicas;
  const adaptive = context.profiles[service].adaptive;
  const start = Number(adaptive.startRps);
  const max = Number(adaptive.maxRps);
  const warmup = Number(adaptive.trialWarmupSeconds);
  const measure = Number(adaptive.trialMeasureSeconds);
  let state = createSearchState(service, start, max, {
    searchTolerance: Number(adaptive.searchTolerance),
    maxTrials: Number(adaptive.maxTrials),
  });
  const capacityTrials = [];
  let sequence = 1;

  await context.prepareDataset(service, `${service.slice(0, 10)}-r${replicas}-dataset`);
  while (state.status === 'searching') {
    const rawCandidate = nextSearchCandidate(state);
    const candidate = rawCandidate == null ? null : integerCandidate(rawCandidate, state);
    if (candidate == null) break;
    if (warmup > 0) {
      const warm = await measuredTrial(context, service, candidate, warmup, 'warmup', sequence);
      capacityTrials.push(warm);
      if (warm.decision.k6_exit_code !== 0 && ![99, 201].includes(warm.decision.k6_exit_code)) {
        throw context.executionError('k6_script', `${service}/replicas-${replicas} warmup failed`);
      }
    }
    const trial = await measuredTrial(context, service, candidate, measure, sequence === 1 ? 'calibration' : 'search', sequence);
    capacityTrials.push(trial);
    state = recordTrial(state, trial);
    sequence += 1;
    if (!trial.decision.conclusive) break;
    await context.stabilize(service);
  }
  const search = finalizeSearch(state);
  const result = {
    replicas,
    search,
    trials: capacityTrials,
    confirmation: { stable_rps: search.reliable_stable_rps, repetitions: [] },
    status: 'incomplete',
  };
  if (search.reliable_stable_rps == null) {
    result.status = search.status === 'start_rps_failed' ? 'failed' : 'incomplete';
    return result;
  }
  const repetitions = Number(adaptive.repetitions);
  const confirmationMeasure = Number(adaptive.confirmationMeasureSeconds);
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    if (warmup > 0) {
      const warm = await measuredTrial(context, service, search.reliable_stable_rps, warmup, 'confirmation-warmup', repetition);
      capacityTrials.push(warm);
      if (warm.decision.k6_exit_code !== 0 && ![99, 201].includes(warm.decision.k6_exit_code)) {
        throw context.executionError('k6_script', `${service}/replicas-${replicas} confirmation warmup failed`);
      }
    }
    const trial = await measuredTrial(context, service, search.reliable_stable_rps, confirmationMeasure, 'confirmation', repetition);
    result.confirmation.repetitions.push(trial);
    capacityTrials.push(trial);
    await context.stabilize(service);
  }
  result.status = result.confirmation.repetitions.every((trial) => trial.decision.passed && trial.decision.conclusive)
    ? 'passed'
    : result.confirmation.repetitions.some((trial) => trial.decision.conclusive)
      ? 'failed'
      : 'incomplete';
  return result;
}

export async function executeService(context, service) {
  const capacity = context.experiment.run.verificationOnly
    ? await runVerification(context, service)
    : await runCapacity(context, service);
  context.execution.services[service].capacity = capacity;
  context.execution.services[service].status = capacity.status;
  context.persist();
  return ['passed', 'completed'].includes(capacity.status);
}

export const __test__ = { policy, verificationDecision };
