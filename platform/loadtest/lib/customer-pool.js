export function customerPoolEmail(config, index) {
  const ordinal = String(index + 1).padStart(config.customerPool.padWidth, '0');
  return `${config.customerPool.emailPrefix}-${config.customerPool.revision}-${ordinal}@${config.customerPool.emailDomain}`;
}

export function customerPoolDisplayName(config, index) {
  return `${config.customerPool.displayNamePrefix} ${config.customerPool.revision} ${String(index + 1).padStart(config.customerPool.padWidth, '0')}`;
}

export function customerPoolAccount(config, index) {
  return {
    email: customerPoolEmail(config, index),
    password: config.customerPool.password,
    displayName: customerPoolDisplayName(config, index),
  };
}

export function activeCustomerCount(config) {
  return config.activeCustomerCount || config.customerPool.size;
}

export function customerPoolIndexForIteration(config, vu, iteration) {
  const vuIndex = Math.max(0, Number(vu) - 1);
  const iterationIndex = Math.max(0, Number(iteration));
  return (vuIndex + (iterationIndex * config.plannedMaxVus)) % activeCustomerCount(config);
}
