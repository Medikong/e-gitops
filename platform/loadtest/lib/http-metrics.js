export const HTTP_STEP_METADATA = {
  'read_api.concerts': { route: 'GET /concerts', service: 'concert-service' },
  'read_api.performances': { route: 'GET /concerts/{id}/performances', service: 'concert-service' },
  'read_api.seats': { route: 'GET /performances/{id}/seats', service: 'concert-service' },
  'dataset.customer.signup': { route: 'POST /auth/signup', service: 'auth-service' },
  'dataset.customer.login_verify': { route: 'POST /auth/login', service: 'auth-service' },
  'auth_login.login': { route: 'POST /auth/login', service: 'auth-service' },
  'reservation_journey.setup.pre_login': { route: 'POST /auth/signup|login', service: 'auth-service' },
  'reservation_journey.concerts': { route: 'GET /concerts', service: 'concert-service' },
  'reservation_journey.performances': { route: 'GET /concerts/{id}/performances', service: 'concert-service' },
  'reservation_journey.seats': { route: 'GET /performances/{id}/seats', service: 'concert-service' },
  'reservation_journey.reservation.create': { route: 'POST /reservations', service: 'reservation-service' },
  'reservation_journey.payment.approve': { route: 'POST /payments', service: 'payment-service' },
  'reservation_journey.ticket.list': { route: 'GET /tickets/me', service: 'ticket-service' },
  'reservation_create.setup.pre_login': { route: 'POST /auth/signup|login', service: 'auth-service' },
  'reservation_create.concerts': { route: 'GET /concerts', service: 'concert-service' },
  'reservation_create.performances': { route: 'GET /concerts/{id}/performances', service: 'concert-service' },
  'reservation_create.seats': { route: 'GET /performances/{id}/seats', service: 'concert-service' },
  'reservation_create.reservation.create': { route: 'POST /reservations', service: 'reservation-service' },
  'reservation_seat_contention.setup.pre_login': { route: 'POST /auth/signup|login', service: 'auth-service' },
  'reservation_seat_contention.concerts': { route: 'GET /concerts', service: 'concert-service' },
  'reservation_seat_contention.performances': { route: 'GET /concerts/{id}/performances', service: 'concert-service' },
  'reservation_seat_contention.seats': { route: 'GET /performances/{id}/seats', service: 'concert-service' },
  'reservation_seat_contention.reservation.create': { route: 'POST /reservations', service: 'reservation-service' },
  'ticket_service_read.setup.pre_login': { route: 'POST /auth/signup|login', service: 'auth-service' },
  'ticket_service_read.setup.ticket_issue': { route: 'POST /tickets/issue', service: 'ticket-service' },
  'ticket-list': { route: 'GET /tickets/me', service: 'ticket-service' },
  'ticket-list-pagination': { route: 'GET /tickets/me', service: 'ticket-service' },
  'ticket-wait-by-list': { route: 'GET /tickets/me', service: 'ticket-service' },
};

export const HTTP_STEP_ROUTES = Object.fromEntries(
  Object.entries(HTTP_STEP_METADATA).map(([step, metadata]) => [step, metadata.route]),
);

export const HTTP_STEP_SERVICES = Object.fromEntries(
  Object.entries(HTTP_STEP_METADATA).map(([step, metadata]) => [step, metadata.service]),
);

export const READ_API_STEPS = [
  'read_api.concerts',
  'read_api.performances',
  'read_api.seats',
];

export const RESERVATION_JOURNEY_STEPS = [
  'reservation_journey.concerts',
  'reservation_journey.performances',
  'reservation_journey.seats',
  'reservation_journey.reservation.create',
  'reservation_journey.payment.approve',
  'reservation_journey.ticket.list',
];

export const RESERVATION_CREATE_STEPS = [
  'reservation_create.concerts',
  'reservation_create.performances',
  'reservation_create.seats',
  'reservation_create.reservation.create',
];

export const RESERVATION_SEAT_CONTENTION_STEPS = [
  'reservation_seat_contention.concerts',
  'reservation_seat_contention.performances',
  'reservation_seat_contention.seats',
  'reservation_seat_contention.reservation.create',
];

export const AUTH_LOGIN_STEPS = [
  'auth_login.login',
];

export const TICKET_SERVICE_READ_STEPS = [
  'ticket-list',
  'ticket-list-pagination',
  'ticket-wait-by-list',
];

export function routeLabel(step, method, path) {
  return HTTP_STEP_ROUTES[step] || `${method} ${step || path}`;
}

export function serviceLabel(step) {
  return HTTP_STEP_SERVICES[step] || 'unknown';
}

export function durationSeconds(value) {
  const text = String(value || '').trim();
  if (text === '') {
    return 0;
  }
  let total = 0;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    matched = true;
    const amount = Number(match[1]);
    if (match[2] === 'ms') {
      total += amount / 1000;
    } else if (match[2] === 's') {
      total += amount;
    } else if (match[2] === 'm') {
      total += amount * 60;
    } else if (match[2] === 'h') {
      total += amount * 3600;
    }
  }
  if (!matched) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : 0;
  }
  return total;
}

export function loadStageId(stage, index = 0) {
  const target = Number(stage && stage.target);
  const targetLabel = Number.isFinite(target) ? String(target).replace(/\./g, '_') : `unknown_${index + 1}`;
  return `stage_${targetLabel}_journey_s`;
}

export function loadStageLabel(stage) {
  return `${stage.target} journey/s`;
}

export function loadStageForElapsed(stages, elapsedSeconds) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return null;
  }
  let upperBound = 0;
  for (let index = 0; index < stages.length; index += 1) {
    upperBound += durationSeconds(stages[index].duration);
    if (elapsedSeconds <= upperBound || index === stages.length - 1) {
      return {
        ...stages[index],
        id: loadStageId(stages[index], index),
        label: loadStageLabel(stages[index]),
        index,
      };
    }
  }
  return null;
}

export function httpStepThresholds(steps, thresholds) {
  const result = {};
  for (const step of steps) {
    result[`http_req_duration{step:${step}}`] = [
      `p(95)<${thresholds.httpReqDurationP95Ms}`,
      `p(99)<${thresholds.httpReqDurationP99Ms}`,
    ];
    result[`http_req_failed{step:${step}}`] = [`rate<${thresholds.httpReqFailedRate}`];
    result[`http_reqs{step:${step}}`] = ['rate>=0'];
    result[`checks{step:${step}}`] = [`rate>${thresholds.checksRate}`];
  }
  return result;
}

export function httpStageThresholds(stages, thresholds) {
  const result = {};
  for (let index = 0; index < (stages || []).length; index += 1) {
    const stageId = loadStageId(stages[index], index);
    result[`http_req_duration{load_stage:${stageId}}`] = [
      `p(95)<${thresholds.httpReqDurationP95Ms}`,
      `p(99)<${thresholds.httpReqDurationP99Ms}`,
    ];
    result[`http_req_failed{load_stage:${stageId}}`] = [`rate<${thresholds.httpReqFailedRate}`];
    result[`http_reqs{load_stage:${stageId}}`] = ['rate>=0'];
  }
  return result;
}
