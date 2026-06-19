import http from 'k6/http';
import { check, fail, group } from 'k6';
import { Rate } from 'k6/metrics';

import { getConfig, requireCustomerPool } from '../lib/config.js';
import { authHeaders, requestJson } from '../lib/http.js';
import { httpStepThresholds, TICKET_SERVICE_READ_STEPS } from '../lib/http-metrics.js';
import {
  logExperimentConditions,
  logJourneyStep,
  logRunFailed,
  logRunFinished,
  logRunStarted,
} from '../lib/log.js';
import { itemsFrom, requireField } from '../lib/pick.js';
import { summaryOutput } from '../lib/report.js';
import {
  customerTokenForIteration,
  executorConfig,
  iterationConfig,
  pauseBetweenIterations,
  prepareCustomerTokens,
  runScopedConfig,
} from '../flows/reservation-load-setup.js';

const config = getConfig();
const ticketServiceReadSuccess = new Rate('loadtest_ticket_service_read_success');
const PRE_LOGIN_STEP = 'ticket_service_read.setup.pre_login';
const SETUP_TICKET_ISSUE_STEP = 'ticket_service_read.setup.ticket_issue';
const TICKET_LIST_STEP = 'ticket-list';
const TICKET_LIST_PAGINATION_STEP = 'ticket-list-pagination';
const TICKET_WAIT_BY_LIST_STEP = 'ticket-wait-by-list';

function setupTags(runConfig) {
  return {
    environment: runConfig.environment,
    profile: runConfig.dataset.profile,
    test_type: runConfig.testType,
    target: runConfig.target,
    phase: 'setup',
  };
}

function setupRequestJson(runConfig, token, method, path, body, expectedStatuses) {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const route = `${method} ${path}`;
  const response = http.request(method, `${runConfig.baseUrl}${path}`, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
      ...authHeaders(token),
    },
    responseCallback: http.expectedStatuses(...expectedStatuses),
    timeout: `${runConfig.timeoutSeconds}s`,
    tags: {
      ...setupTags(runConfig),
      name: route,
      route,
      service: 'ticket-service',
      step: SETUP_TICKET_ISSUE_STEP,
    },
  });

  const ok = check(response, {
    [`${SETUP_TICKET_ISSUE_STEP} returned expected status`]: (res) => expectedStatuses.includes(res.status),
    [`${SETUP_TICKET_ISSUE_STEP} returned json`]: (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, {
    ...setupTags(runConfig),
    route,
    service: 'ticket-service',
    step: SETUP_TICKET_ISSUE_STEP,
  });
  if (!ok) {
    fail(`${SETUP_TICKET_ISSUE_STEP} ${method} ${path} failed with status ${response.status}`);
  }

  try {
    return response.json();
  } catch (error) {
    fail(`${SETUP_TICKET_ISSUE_STEP} ${method} ${path} returned invalid json: ${error.message}`);
  }
  return null;
}

function validateTicketServiceReadConfig(runConfig) {
  const requiredForPagination = runConfig.ticketListLimit * runConfig.ticketListPaginationPages;
  const requiredTickets = Math.max(requiredForPagination, runConfig.ticketWaitTargetTicketPosition);
  if (runConfig.ticketSetupTicketsPerCustomer < requiredTickets) {
    throw new Error('LOADTEST_TICKET_SERVICE_READ_TICKETS_PER_CUSTOMER must cover pagination pages and wait target position');
  }
  if (runConfig.ticketWaitTargetTicketPosition > runConfig.ticketListLimit * runConfig.ticketListMaxPages) {
    throw new Error('LOADTEST_TICKET_SERVICE_READ_WAIT_TARGET_TICKET_POSITION must be reachable within ticket list max pages');
  }
}

function ticketReservationId(runConfig, customerIndex, ticketPosition) {
  return `${runConfig.dataset.revision}-customer-${String(customerIndex + 1).padStart(6, '0')}-ticket-${String(ticketPosition).padStart(6, '0')}`;
}

function issueTicket(runConfig, token, customerId, customerIndex, ticketPosition) {
  const reservationId = ticketReservationId(runConfig, customerIndex, ticketPosition);
  const ticket = setupRequestJson(
    runConfig,
    token,
    'POST',
    '/tickets/issue',
    {
      reservationId,
      userId: customerId,
      concertId: `${runConfig.dataset.revision}-concert-read-path`,
      seatId: `${runConfig.dataset.revision}-seat-${String(ticketPosition).padStart(6, '0')}`,
    },
    [200],
  );
  requireField(ticket, 'id', SETUP_TICKET_ISSUE_STEP);
  return {
    ticketId: requireField(ticket, 'id', SETUP_TICKET_ISSUE_STEP),
    reservationId,
  };
}

function prepareTicketDataset(runConfig, customerTokens) {
  const ticketTargets = [];
  const state = {
    createdTickets: 0,
    activeCustomers: customerTokens.length,
    ticketsPerCustomer: runConfig.ticketSetupTicketsPerCustomer,
  };
  for (const token of customerTokens) {
    let target = null;
    for (let position = 1; position <= runConfig.ticketSetupTicketsPerCustomer; position += 1) {
      const issued = issueTicket(
        runConfig,
        token.accessToken,
        token.customerId,
        token.customerIndex,
        position,
      );
      state.createdTickets += 1;
      if (position === runConfig.ticketWaitTargetTicketPosition) {
        target = issued;
      }
    }
    if (!target) {
      fail(`${SETUP_TICKET_ISSUE_STEP} did not prepare a wait target for customer index ${token.customerIndex}`);
    }
    ticketTargets[token.customerIndex] = target;
  }
  return { state, ticketTargets };
}

function firstPage(runConfig, token) {
  const body = requestJson(
    runConfig,
    TICKET_LIST_STEP,
    'GET',
    '/tickets/me',
    null,
    authHeaders(token),
    { limit: runConfig.ticketListLimit },
  );
  const items = itemsFrom(body, TICKET_LIST_STEP);
  if (items.length === 0) {
    fail(`${TICKET_LIST_STEP} returned no tickets`);
  }
  return {
    firstTicketId: requireField(items[0], 'id', TICKET_LIST_STEP),
    nextCursor: body.nextCursor || null,
    itemCount: items.length,
  };
}

function paginateTickets(runConfig, token) {
  let cursor = null;
  let itemCount = 0;
  let pagesRead = 0;
  for (let page = 0; page < runConfig.ticketListPaginationPages; page += 1) {
    const body = requestJson(
      runConfig,
      TICKET_LIST_PAGINATION_STEP,
      'GET',
      '/tickets/me',
      null,
      authHeaders(token),
      {
        limit: runConfig.ticketListLimit,
        cursor,
      },
    );
    const items = itemsFrom(body, TICKET_LIST_PAGINATION_STEP);
    if (items.length === 0) {
      fail(`${TICKET_LIST_PAGINATION_STEP} page ${page + 1} returned no tickets`);
    }
    itemCount += items.length;
    pagesRead += 1;
    cursor = body.nextCursor || null;
    if (page + 1 < runConfig.ticketListPaginationPages && !cursor) {
      fail(`${TICKET_LIST_PAGINATION_STEP} ended before page ${page + 2}`);
    }
  }
  return {
    paginationPagesRead: pagesRead,
    paginationItemCount: itemCount,
    nextCursor: cursor,
  };
}

function findTicketByList(runConfig, token, reservationId) {
  let cursor = null;
  let pagesRead = 0;
  for (let page = 0; page < runConfig.ticketListMaxPages; page += 1) {
    const body = requestJson(
      runConfig,
      TICKET_WAIT_BY_LIST_STEP,
      'GET',
      '/tickets/me',
      null,
      authHeaders(token),
      {
        limit: runConfig.ticketListLimit,
        cursor,
      },
    );
    const items = itemsFrom(body, TICKET_WAIT_BY_LIST_STEP);
    pagesRead += 1;
    const ticket = items.find((item) => String(item.reservationId) === String(reservationId));
    if (ticket) {
      return {
        ticketId: requireField(ticket, 'id', TICKET_WAIT_BY_LIST_STEP),
        waitPagesRead: pagesRead,
      };
    }
    cursor = body.nextCursor || null;
    if (!cursor) {
      break;
    }
  }
  fail(`${TICKET_WAIT_BY_LIST_STEP} did not find reservation ${reservationId}`);
  return null;
}

export const options = {
  setupTimeout: config.setupTimeout,
  scenarios: {
    [config.scenario]: {
      ...executorConfig(config, 'LOADTEST_TICKET_SERVICE_READ'),
      tags: {
        environment: config.environment,
        profile: config.dataset.profile,
        test_type: config.testType,
        target: config.target,
      },
    },
  },
  thresholds: {
    http_req_failed: [`rate<${config.thresholds.httpReqFailedRate}`],
    http_req_duration: [
      `p(95)<${config.thresholds.httpReqDurationP95Ms}`,
      `p(99)<${config.thresholds.httpReqDurationP99Ms}`,
    ],
    checks: [`rate>${config.thresholds.checksRate}`],
    loadtest_ticket_service_read_success: [`rate>${config.thresholds.ticketServiceReadSuccessRate}`],
    ...httpStepThresholds([PRE_LOGIN_STEP, SETUP_TICKET_ISSUE_STEP, ...TICKET_SERVICE_READ_STEPS], config.thresholds),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    target: config.target,
  },
};

export function setup() {
  requireCustomerPool(config);
  validateTicketServiceReadConfig(config);
  const setupConfig = runScopedConfig(config);
  logExperimentConditions(setupConfig, 'ticket_service_read_setup');
  const { customerTokens, state: customerState } = prepareCustomerTokens(setupConfig, PRE_LOGIN_STEP);
  const { state: ticketState, ticketTargets } = prepareTicketDataset(setupConfig, customerTokens);
  logExperimentConditions(setupConfig, 'ticket_service_read_measurement');
  return {
    customerTokens,
    customerState,
    ticketState,
    ticketTargets,
    datasetRevision: setupConfig.dataset.revision,
  };
}

export default function ticketServiceReadLoadTest(setupData) {
  const runConfig = iterationConfig(config, setupData);
  const customerToken = customerTokenForIteration(setupData, runConfig.customer.index, PRE_LOGIN_STEP);
  const target = setupData.ticketTargets[customerToken.customerIndex];
  if (!target || !target.reservationId) {
    fail(`${SETUP_TICKET_ISSUE_STEP} did not prepare a target for customer index ${customerToken.customerIndex}`);
  }

  const state = {
    customerId: customerToken.customerId,
    reservationId: target.reservationId,
  };
  let step = 'init';

  logRunStarted(runConfig);
  try {
    group('ticket-list', () => {
      step = TICKET_LIST_STEP;
      Object.assign(state, firstPage(runConfig, customerToken.accessToken));
      logJourneyStep(runConfig, step, 'success', state);
    });

    group('ticket-list-pagination', () => {
      step = TICKET_LIST_PAGINATION_STEP;
      Object.assign(state, paginateTickets(runConfig, customerToken.accessToken));
      logJourneyStep(runConfig, step, 'success', state);
    });

    group('ticket-wait-by-list', () => {
      step = TICKET_WAIT_BY_LIST_STEP;
      Object.assign(state, findTicketByList(runConfig, customerToken.accessToken, target.reservationId));
      logJourneyStep(runConfig, step, 'success', state);
    });

    ticketServiceReadSuccess.add(true);
    logRunFinished(runConfig, state);
  } catch (error) {
    ticketServiceReadSuccess.add(false);
    logJourneyStep(runConfig, step, 'failed', state);
    logRunFailed(runConfig, step, error, state);
    throw error;
  } finally {
    pauseBetweenIterations(runConfig);
  }
}

export function handleSummary(data) {
  return summaryOutput(config, data);
}
