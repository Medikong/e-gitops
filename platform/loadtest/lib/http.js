import http from 'k6/http';
import { check, fail } from 'k6';

import { routeLabel, serviceLabel } from './http-metrics.js';
import { logStep } from './log.js';

function encodeQuery(params) {
  const entries = Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) {
    return '';
  }
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

export function getJson(config, step, path, query = {}) {
  return requestJson(config, step, 'GET', path, null, {}, query);
}

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export function requestJson(config, step, method, path, body = null, extraHeaders = {}, query = {}) {
  const url = `${config.baseUrl}${path}${encodeQuery(query)}`;
  const route = routeLabel(step, method, path);
  const service = serviceLabel(step);
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const response = http.request(method, url, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
      ...extraHeaders,
    },
    timeout: `${config.timeoutSeconds}s`,
    tags: {
      environment: config.environment,
      profile: config.dataset.profile,
      test_type: config.testType,
      name: route,
      route,
      service,
      step,
      target: config.target,
    },
  });

  logStep(config, step, response, { route, service });
  const ok = check(response, {
    [`${step} returned 2xx`]: (res) => res.status >= 200 && res.status < 300,
    [`${step} returned json`]: (res) => String(res.headers['Content-Type'] || res.headers['content-type'] || '').includes('application/json'),
  }, {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    route,
    service,
    step,
    target: config.target,
  });
  if (!ok) {
    fail(`${step} failed with status ${response.status}`);
  }

  try {
    return response.json();
  } catch (error) {
    fail(`${step} returned invalid json: ${error.message}`);
  }
}

export function requestWithExpectedStatuses(config, step, method, path, body = null, extraHeaders = {}, query = {}, expectedStatuses = []) {
  const response = requestObservedStatuses(config, step, method, path, body, extraHeaders, query, expectedStatuses);
  if (!expectedStatuses.includes(response.status)) {
    fail(`${step} failed with status ${response.status}`);
  }
  return response;
}

export function requestObservedStatuses(config, step, method, path, body = null, extraHeaders = {}, query = {}, expectedStatuses = []) {
  const url = `${config.baseUrl}${path}${encodeQuery(query)}`;
  const route = routeLabel(step, method, path);
  const service = serviceLabel(step);
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const response = http.request(method, url, payload, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Loadtest-Traffic': 'true',
      ...extraHeaders,
    },
    timeout: `${config.timeoutSeconds}s`,
    responseCallback: http.expectedStatuses(...expectedStatuses),
    tags: {
      environment: config.environment,
      profile: config.dataset.profile,
      test_type: config.testType,
      name: route,
      route,
      service,
      step,
      target: config.target,
    },
  });

  logStep(config, step, response, { route, service });
  check(response, {
    [`${step} returned expected status`]: (res) => expectedStatuses.length === 0 || expectedStatuses.includes(res.status),
  }, {
    environment: config.environment,
    profile: config.dataset.profile,
    test_type: config.testType,
    route,
    service,
    step,
    target: config.target,
  });
  return response;
}
