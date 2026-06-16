export const HTTP_STEP_ROUTES = {
  'read_api.concerts': 'GET /concerts',
  'read_api.performances': 'GET /concerts/{id}/performances',
  'read_api.seats': 'GET /performances/{id}/seats',
  'dataset.customer.signup': 'POST /auth/signup',
  'dataset.customer.login_verify': 'POST /auth/login',
  'reservation_journey.auth.login': 'POST /auth/login',
  'reservation_journey.concerts': 'GET /concerts',
  'reservation_journey.performances': 'GET /concerts/{id}/performances',
  'reservation_journey.seats': 'GET /performances/{id}/seats',
  'reservation_journey.reservation.create': 'POST /reservations',
  'reservation_journey.payment.approve': 'POST /payments',
  'reservation_journey.ticket.list': 'GET /tickets/me',
};

export const READ_API_STEPS = [
  'read_api.concerts',
  'read_api.performances',
  'read_api.seats',
];

export const RESERVATION_JOURNEY_STEPS = [
  'reservation_journey.auth.login',
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
