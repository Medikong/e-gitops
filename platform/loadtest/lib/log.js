function emit(event, fields) {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    test_type: 'loadtest',
    ...fields,
  }));
}

function compact(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function datasetShape(config) {
  if (!config.dataset || !config.customerPool) {
    return {};
  }
  const seatsPerPerformance = (
    config.dataset.seatSections
    * config.dataset.seatRows
    * config.dataset.seatsPerRow
  );
  const totalPerformances = config.dataset.concerts * config.dataset.performancesPerConcert;

  return {
    dataset_profile: config.dataset.profile,
    dataset_revision: config.dataset.revision,
    dataset_title_prefix: config.dataset.titlePrefix,
    dataset_concerts: config.dataset.concerts,
    dataset_performances_per_concert: config.dataset.performancesPerConcert,
    dataset_total_performances: totalPerformances,
    dataset_seat_sections: config.dataset.seatSections,
    dataset_seat_rows: config.dataset.seatRows,
    dataset_seats_per_row: config.dataset.seatsPerRow,
    dataset_seats_per_performance: seatsPerPerformance,
    dataset_total_seats: totalPerformances * seatsPerPerformance,
    dataset_discovery_limit: config.dataset.discoveryLimit,
    customer_pool_size: config.customerPool.size,
    customer_pool_revision: config.customerPool.revision,
    customer_pool_email_prefix: config.customerPool.emailPrefix,
    customer_pool_email_domain: config.customerPool.emailDomain,
  };
}

function trafficModelShape(config) {
  const model = config.trafficModel || {};
  return {
    traffic_model_preset: model.preset,
    traffic_model_mau: model.mau,
    traffic_model_stickiness: model.stickiness,
    traffic_model_peak_participation_rate: model.peakParticipationRate,
    traffic_model_peak_window_minutes: model.peakWindowMinutes,
    traffic_model_journeys_per_user: model.journeysPerUser,
    traffic_model_safety_factor: model.safetyFactor,
    traffic_model_target_tickets_per_customer: model.targetTicketsPerCustomer,
    traffic_model_calculated_journey_rate: model.calculatedJourneyRate,
    traffic_model_expected_journeys: model.expectedJourneys,
  };
}

export function experimentConditionFields(config, phase) {
  const thresholds = config.thresholds || {};
  return compact({
    loadtest_run_id: config.runId,
    phase,
    scenario: config.scenario,
    environment: config.environment,
    target: config.target,
    target_base_url: config.baseUrl,
    revision: config.revision,
    image: config.image,
    image_tag: config.imageTag,
    release: config.release,
    namespace: config.namespace,
    k6_command: config.k6Command,
    k6_command_args: config.k6CommandArgs,
    k6_extra_args: config.k6ExtraArgs,
    k6_output: config.k6Output,
    k6_scenario_file: config.k6ScenarioFile,
    executor: config.executor,
    vus: config.vus,
    rate: config.rate,
    time_unit: config.timeUnit,
    pre_allocated_vus: config.preAllocatedVUs,
    max_vus: config.maxVUs,
    duration: config.duration,
    stages: config.stages,
    graceful_stop: config.gracefulStop,
    think_time_seconds: config.thinkTimeSeconds,
    poll_seconds: config.pollSeconds,
    poll_interval_seconds: config.pollIntervalSeconds,
    ticket_list_limit: config.ticketListLimit,
    ticket_list_pagination_pages: config.ticketListPaginationPages,
    ticket_list_max_pages: config.ticketListMaxPages,
    ticket_setup_tickets_per_customer: config.ticketSetupTicketsPerCustomer,
    ticket_wait_target_ticket_position: config.ticketWaitTargetTicketPosition,
    active_customer_count: config.activeCustomerCount,
    payment_amount: config.paymentAmount,
    max_seat_attempts: config.maxSeatAttempts,
    seat_candidate_count: config.seatCandidateCount,
    seat_selection_mode: config.seatSelectionMode,
    allow_reservation_conflicts: config.allowReservationConflicts,
    concert_limit: config.concertLimit,
    performance_limit: config.performanceLimit,
    seat_limit: config.seatLimit,
    threshold_http_req_failed_rate: thresholds.httpReqFailedRate,
    threshold_http_req_duration_p95_ms: thresholds.httpReqDurationP95Ms,
    threshold_http_req_duration_p99_ms: thresholds.httpReqDurationP99Ms,
    threshold_checks_rate: thresholds.checksRate,
    threshold_auth_login_success_rate: thresholds.authLoginSuccessRate,
    threshold_reservation_journey_success_rate: thresholds.reservationJourneySuccessRate,
    threshold_reservation_conflict_rate: thresholds.reservationConflictRate,
    threshold_ticket_issued_rate: thresholds.ticketIssuedRate,
    measurement_window_source: 'grafana_time_range',
    ...trafficModelShape(config),
    ...datasetShape(config),
  });
}

export function logExperimentConditions(config, phase) {
  emit('loadtest_experiment_conditions', experimentConditionFields(config, phase));
}

export function logRunStarted(config) {
  emit('loadtest_run_started', {
    loadtest_run_id: config.runId,
    iteration_id: config.iterationId,
    scenario: config.scenario,
    target: config.target,
    target_base_url: config.baseUrl,
    executor: config.executor,
    vus: config.vus,
    rate: config.rate,
    time_unit: config.timeUnit,
    duration: config.duration,
  });
}

export function logStep(config, step, response, extra = {}) {
  emit('loadtest_step', {
    loadtest_run_id: config.runId,
    iteration_id: config.iterationId,
    scenario: config.scenario,
    step,
    target: config.target,
    target_base_url: config.baseUrl,
    http_status: response.status,
    request_id: response.headers['X-Request-Id'] || response.headers['x-request-id'] || config.requestIdBase,
    ...extra,
  });
}

export function logRunFinished(config, state = {}) {
  emit('loadtest_run_finished', {
    loadtest_run_id: config.runId,
    iteration_id: config.iterationId,
    scenario: config.scenario,
    target: config.target,
    target_base_url: config.baseUrl,
    concert_id: state.concertId,
    performance_id: state.performanceId,
    showtime_id: state.showtimeId,
    seat_id: state.seatId,
    reservation_id: state.reservationId,
    payment_id: state.paymentId,
    ticket_id: state.ticketId,
    seat_count: state.seatCount,
    seat_candidate_count: state.seatCandidateCount,
  });
}

export function logRunFailed(config, step, error, state = {}) {
  emit('loadtest_run_failed', {
    loadtest_run_id: config.runId,
    iteration_id: config.iterationId,
    scenario: config.scenario,
    step,
    target: config.target,
    target_base_url: config.baseUrl,
    error_message: error && error.message ? error.message : String(error),
    request_id: config.requestIdBase,
    concert_id: state.concertId,
    performance_id: state.performanceId,
    showtime_id: state.showtimeId,
    seat_id: state.seatId,
    reservation_id: state.reservationId,
    payment_id: state.paymentId,
    ticket_id: state.ticketId,
    seat_count: state.seatCount,
    seat_candidate_count: state.seatCandidateCount,
    failure_class: state.failureClass,
  });
}

export function logAuthLoginAccountPoolPrepared(config, state = {}) {
  emit('loadtest_auth_login_account_pool_prepared', {
    loadtest_run_id: config.runId,
    scenario: config.scenario,
    target: config.target,
    target_base_url: config.baseUrl,
    customer_pool_size: config.customerPool.size,
    created_customers: state.createdCustomers || 0,
    reused_customers: state.reusedCustomers || 0,
    verified_customers: state.verifiedCustomers || 0,
  });
}

export function logJourneyStep(config, step, outcome, state = {}) {
  emit('loadtest_journey_step', {
    loadtest_run_id: config.runId,
    iteration_id: config.iterationId,
    scenario: config.scenario,
    step,
    outcome,
    target: config.target,
    target_base_url: config.baseUrl,
    concert_id: state.concertId,
    performance_id: state.performanceId,
    showtime_id: state.showtimeId,
    seat_id: state.seatId,
    reservation_id: state.reservationId,
    payment_id: state.paymentId,
    ticket_id: state.ticketId,
    seat_count: state.seatCount,
    seat_candidate_count: state.seatCandidateCount,
  });
}

export function logDatasetFinished(config, state = {}) {
  emit('loadtest_dataset_finished', {
    loadtest_run_id: config.runId,
    scenario: config.scenario,
    target: config.target,
    target_base_url: config.baseUrl,
    profile: config.dataset.profile,
    revision: config.dataset.revision,
    desired_concerts: config.dataset.concerts,
    desired_performances_per_concert: config.dataset.performancesPerConcert,
    desired_seats_per_performance: config.dataset.seatSections * config.dataset.seatRows * config.dataset.seatsPerRow,
    customer_pool_size: config.customerPool.size,
    customer_pool_revision: config.customerPool.revision,
    created_customers: state.createdCustomers || 0,
    reused_customers: state.reusedCustomers || 0,
    verified_customers: state.verifiedCustomers || 0,
    created_concerts: state.createdConcerts || 0,
    reused_concerts: state.reusedConcerts || 0,
    created_performances: state.createdPerformances || 0,
    verified_performances: state.verifiedPerformances || 0,
    verified_seats: state.verifiedSeats || 0,
    verified_concerts: state.verifiedConcerts || 0,
  });
}

function metricValue(metrics, name, key) {
  const metric = metrics && metrics[name];
  if (!metric || !metric.values) {
    return null;
  }
  return metric.values[key] === undefined ? null : metric.values[key];
}

function metricNameForSummary(config, name) {
  return config.summaryStep ? `${name}{step:${config.summaryStep}}` : name;
}

function summaryMetricValue(config, metrics, name, key) {
  return metricValue(metrics, metricNameForSummary(config, name), key);
}

export function summaryLine(config, data) {
  const metrics = data.metrics || {};
  return JSON.stringify({
    event: 'loadtest_summary',
    timestamp: new Date().toISOString(),
    test_type: 'loadtest',
    loadtest_run_id: config.runId || __ENV.LOADTEST_RUN_ID || null,
    scenario: config.scenario || __ENV.LOADTEST_SCENARIO || 'read-api-baseline',
    target: config.target || __ENV.LOADTEST_TARGET || 'local',
    summary_step: config.summaryStep,
    http_req_duration_p50_ms: summaryMetricValue(config, metrics, 'http_req_duration', 'med'),
    http_req_duration_p95_ms: summaryMetricValue(config, metrics, 'http_req_duration', 'p(95)'),
    http_req_duration_p99_ms: summaryMetricValue(config, metrics, 'http_req_duration', 'p(99)'),
    http_req_failed_rate: summaryMetricValue(config, metrics, 'http_req_failed', 'rate'),
    http_reqs_rate: summaryMetricValue(config, metrics, 'http_reqs', 'rate'),
    rps: summaryMetricValue(config, metrics, 'http_reqs', 'rate'),
    http_reqs_count: summaryMetricValue(config, metrics, 'http_reqs', 'count'),
    checks_rate: summaryMetricValue(config, metrics, 'checks', 'rate'),
    iterations: metricValue(metrics, 'iterations', 'count'),
    vus_max: metricValue(metrics, 'vus_max', 'value'),
  });
}
