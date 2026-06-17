export const HTTP_STEP_METADATA = {
  'read_api.concerts': { route: 'GET /concerts', service: 'concert-service' },
  'read_api.performances': { route: 'GET /concerts/{id}/performances', service: 'concert-service' },
  'read_api.seats': { route: 'GET /performances/{id}/seats', service: 'concert-service' },
  'dataset.customer.signup': { route: 'POST /auth/signup', service: 'auth-service' },
  'dataset.customer.login_verify': { route: 'POST /auth/login', service: 'auth-service' },
  'reservation_journey.concerts': { route: 'GET /concerts', service: 'concert-service' },
  'reservation_journey.performances': { route: 'GET /concerts/{id}/performances', service: 'concert-service' },
  'reservation_journey.seats': { route: 'GET /performances/{id}/seats', service: 'concert-service' },
  'reservation_journey.reservation.create': { route: 'POST /reservations', service: 'reservation-service' },
  'reservation_journey.payment.approve': { route: 'POST /payments', service: 'payment-service' },
  'reservation_journey.ticket.list': { route: 'GET /tickets/me', service: 'ticket-service' },
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

export function routeLabel(step, method, path) {
  return HTTP_STEP_ROUTES[step] || `${method} ${step || path}`;
}

export function serviceLabel(step) {
  return HTTP_STEP_SERVICES[step] || 'unknown';
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
