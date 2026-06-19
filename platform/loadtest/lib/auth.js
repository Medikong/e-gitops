import { requireField } from './pick.js';
import { requestJson } from './http.js';

export function loginWithCredentials(config, step, email, password) {
  const body = requestJson(config, step, 'POST', '/auth/login', {
    email,
    password,
  });
  return {
    accessToken: requireField(body, 'accessToken', step),
    user: requireField(body, 'user', step),
  };
}

export function loginProvider(config) {
  return loginWithCredentials(
    config,
    'dataset.auth.login_provider',
    config.dataset.providerEmail,
    config.dataset.providerPassword,
  );
}

export function loginAdmin(config) {
  return loginWithCredentials(
    config,
    'dataset.auth.login_admin',
    config.dataset.adminEmail,
    config.dataset.adminPassword,
  );
}
