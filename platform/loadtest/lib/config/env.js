export function optional(name, fallback = '') {
  const value = __ENV[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

export function required(name) {
  const value = optional(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function positiveNumber(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export function nonNegativeNumber(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

export function positiveInteger(name, fallback) {
  const value = positiveNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

export function nonNegativeInteger(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function rate(name, fallback) {
  const value = positiveNumber(name, fallback);
  if (value >= 1) {
    throw new Error(`${name} must be lower than 1`);
  }
  return value;
}

export function parseStages(name) {
  const raw = optional(name, '[]');
  let stages;
  try {
    stages = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(stages)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return stages.map((stage, index) => {
    if (!stage || typeof stage !== 'object') {
      throw new Error(`${name}[${index}] must be an object`);
    }
    const duration = String(stage.duration || '').trim();
    const target = Number(stage.target);
    if (!duration) {
      throw new Error(`${name}[${index}].duration is required`);
    }
    if (!Number.isInteger(target) || target < 0) {
      throw new Error(`${name}[${index}].target must be a non-negative integer`);
    }
    return { duration, target };
  });
}

export function parseStringArray(name) {
  const raw = optional(name, '[]');
  let values;
  try {
    values = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return values.map((value, index) => {
    if (typeof value !== 'string') {
      throw new Error(`${name}[${index}] must be a string`);
    }
    return value;
  });
}
