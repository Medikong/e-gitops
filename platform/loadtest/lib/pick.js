import { fail } from 'k6';

export function itemsFrom(body, step) {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && Array.isArray(body.items)) {
    return body.items;
  }
  fail(`${step} response did not contain an items array`);
}

export function requireField(item, field, step) {
  if (!item || item[field] === undefined || item[field] === null || item[field] === '') {
    fail(`${step} response item did not contain ${field}`);
  }
  return item[field];
}

export function pickByIteration(items, step, offset = 0) {
  if (!items || items.length === 0) {
    fail(`${step} returned no items`);
  }
  return items[(__VU + __ITER + offset) % items.length];
}
