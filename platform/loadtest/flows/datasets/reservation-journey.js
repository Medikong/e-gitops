import { fail } from 'k6';

import { loginWithCredentials } from '../../lib/auth.js';
import { customerPoolAccount } from '../../lib/customer-pool.js';
import { requestWithExpectedStatuses } from '../../lib/http.js';
import { requireField } from '../../lib/pick.js';
import { setupReadApiBasicDataset } from './read-api-basic.js';

function parseJson(response, step) {
  try {
    return response.json();
  } catch (error) {
    fail(`${step} returned invalid json: ${error.message}`);
  }
  return null;
}

function verifyCustomerToken(body, account, step) {
  const user = requireField(body, 'user', step);
  const email = requireField(user, 'email', step);
  if (String(email).toLowerCase() !== account.email) {
    fail(`${step} returned unexpected user email`);
  }
  if (requireField(user, 'role', step) !== 'CUSTOMER') {
    fail(`${step} returned non-CUSTOMER user`);
  }
  requireField(body, 'accessToken', step);
}

function signupOrVerifyCustomer(config, index) {
  const account = customerPoolAccount(config, index);
  const signupStep = 'dataset.customer.signup';
  const response = requestWithExpectedStatuses(
    config,
    signupStep,
    'POST',
    '/auth/signup',
    {
      email: account.email,
      password: account.password,
      displayName: account.displayName,
    },
    {},
    {},
    [201, 409],
  );

  if (response.status === 201) {
    verifyCustomerToken(parseJson(response, signupStep), account, signupStep);
    return { created: true };
  }

  const loginStep = 'dataset.customer.login_verify';
  const login = loginWithCredentials(config, loginStep, account.email, account.password);
  verifyCustomerToken(login, account, loginStep);
  return { created: false };
}

function setupCustomerPool(config) {
  const state = {
    createdCustomers: 0,
    reusedCustomers: 0,
    verifiedCustomers: 0,
  };

  for (let index = 0; index < config.customerPool.size; index += 1) {
    const result = signupOrVerifyCustomer(config, index);
    if (result.created) {
      state.createdCustomers += 1;
    } else {
      state.reusedCustomers += 1;
    }
    state.verifiedCustomers += 1;
  }

  return state;
}

export function setupReservationJourneyDataset(config, tokens) {
  return {
    ...setupCustomerPool(config),
    ...setupReadApiBasicDataset(config, tokens),
  };
}
