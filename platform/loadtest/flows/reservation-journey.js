import { fail, sleep } from 'k6';

import { authHeaders, getJson, requestJson, requestWithExpectedStatuses } from '../lib/http.js';
import { itemsFrom, requireField } from '../lib/pick.js';

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function pickByRunId(items, step, runId, offset = 0) {
  if (!items || items.length === 0) {
    fail(`${step} returned no candidate items`);
  }
  return items[(hashString(runId) + offset) % items.length];
}

function availableSeats(items) {
  return (items || []).filter((seat) => String(seat.status || '').toLowerCase() === 'available');
}

function datasetConcerts(config, concerts) {
  const expectedPrefix = `${config.dataset.titlePrefix} ${config.dataset.profile} ${config.dataset.revision} `;
  const candidates = concerts.filter((concert) => String(concert.title || '').startsWith(expectedPrefix));
  if (candidates.length === 0) {
    fail(`reservation_journey.concerts returned no dataset concerts with prefix ${expectedPrefix}`);
  }
  return candidates;
}

export function selectReservationTarget(config, attempt = 0) {
  const selectionId = config.iterationId || config.runId;
  const concertsBody = getJson(config, 'reservation_journey.concerts', '/concerts', { limit: config.concertLimit });
  const concerts = datasetConcerts(config, itemsFrom(concertsBody, 'reservation_journey.concerts'));
  const concert = pickByRunId(concerts, 'reservation_journey.concerts', `${selectionId}:concert`, attempt);
  const concertId = requireField(concert, 'id', 'reservation_journey.concerts');

  const performancesBody = getJson(
    config,
    'reservation_journey.performances',
    `/concerts/${encodeURIComponent(concertId)}/performances`,
    { limit: config.performanceLimit },
  );
  const performances = itemsFrom(performancesBody, 'reservation_journey.performances');
  const performance = pickByRunId(performances, 'reservation_journey.performances', `${selectionId}:performance`, attempt);
  const performanceId = requireField(performance, 'id', 'reservation_journey.performances');

  const seatsBody = getJson(
    config,
    'reservation_journey.seats',
    `/performances/${encodeURIComponent(performanceId)}/seats`,
    { limit: config.seatLimit },
  );
  const seats = availableSeats(itemsFrom(seatsBody, 'reservation_journey.seats'));
  const seat = pickByRunId(seats, 'reservation_journey.seats', `${selectionId}:seat`, attempt);

  return {
    concertId,
    performanceId,
    showtimeId: performanceId,
    seatId: requireField(seat, 'id', 'reservation_journey.seats'),
    seatCount: seats.length,
  };
}

function createReservation(config, token, target, onConflict) {
  const response = requestWithExpectedStatuses(
    config,
    'reservation_journey.reservation.create',
    'POST',
    '/reservations',
    {
      concertId: target.concertId,
      showtimeId: target.showtimeId,
      performanceId: target.performanceId,
      seatId: target.seatId,
    },
    authHeaders(token),
    {},
    [201, 409],
  );
  const isConflict = response.status === 409;
  onConflict(isConflict);
  if (isConflict) {
    return null;
  }
  let body;
  try {
    body = response.json();
  } catch (error) {
    fail(`reservation_journey.reservation.create returned invalid json: ${error.message}`);
  }
  requireField(body, 'id', 'reservation_journey.reservation.create');
  return body;
}

export function createReservationWithSeatRetry(config, token, selectTarget, onConflict) {
  for (let attempt = 0; attempt < config.maxSeatAttempts; attempt += 1) {
    const target = selectTarget(attempt);
    const reservation = createReservation(config, token, target, onConflict);
    if (reservation) {
      return { target, reservation };
    }
  }
  fail(`reservation_journey.reservation.create exhausted ${config.maxSeatAttempts} seat attempts`);
  return null;
}

export function approvePayment(config, token, reservation, target) {
  const body = requestJson(
    config,
    'reservation_journey.payment.approve',
    'POST',
    '/payments',
    {
      reservationId: reservation.id,
      concertId: target.concertId,
      seatId: target.seatId,
      amount: config.paymentAmount,
      method: 'mock',
      simulation: 'approve',
    },
    {
      ...authHeaders(token),
      'Idempotency-Key': `${config.requestIdBase}-${reservation.id}`,
    },
  );
  requireField(body, 'id', 'reservation_journey.payment.approve');
  requireField(body, 'status', 'reservation_journey.payment.approve');
  return body;
}

function ticketMatches(ticket, reservation) {
  return String(ticket.reservationId) === String(reservation.id);
}

export function waitForTicket(config, token, reservation) {
  const deadline = Date.now() + config.pollSeconds * 1000;
  while (Date.now() <= deadline) {
    const body = requestJson(
      config,
      'reservation_journey.ticket.list',
      'GET',
      '/tickets/me',
      null,
      authHeaders(token),
    );
    const items = Array.isArray(body) ? body : body.items || [];
    const ticket = items.find((item) => ticketMatches(item, reservation));
    if (ticket) {
      return ticket;
    }
    sleep(config.pollIntervalSeconds);
  }
  fail(`reservation_journey.ticket.list did not return a ticket for reservation ${reservation.id}`);
  return null;
}
