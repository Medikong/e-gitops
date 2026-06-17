import { fail, sleep } from 'k6';

import { authHeaders, getJson, requestJson, requestObservedStatuses, requestWithExpectedStatuses } from '../lib/http.js';
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

function stepName(config, suffix) {
  return `${config.stepPrefix || 'reservation_journey'}.${suffix}`;
}

function datasetConcerts(config, concerts) {
  const expectedPrefix = `${config.dataset.titlePrefix} ${config.dataset.profile} ${config.dataset.revision} `;
  const candidates = concerts.filter((concert) => String(concert.title || '').startsWith(expectedPrefix));
  if (candidates.length === 0) {
    fail(`${stepName(config, 'concerts')} returned no dataset concerts with prefix ${expectedPrefix}`);
  }
  return candidates;
}

export function selectReservationTarget(config, attempt = 0) {
  const selectionId = config.iterationId || config.runId;
  const concertsStep = stepName(config, 'concerts');
  const performancesStep = stepName(config, 'performances');
  const seatsStep = stepName(config, 'seats');
  const concertsBody = getJson(config, concertsStep, '/concerts', { limit: config.concertLimit });
  const concerts = datasetConcerts(config, itemsFrom(concertsBody, concertsStep));
  const concert = pickByRunId(concerts, concertsStep, `${selectionId}:concert`, attempt);
  const concertId = requireField(concert, 'id', concertsStep);

  const performancesBody = getJson(
    config,
    performancesStep,
    `/concerts/${encodeURIComponent(concertId)}/performances`,
    { limit: config.performanceLimit },
  );
  const performances = itemsFrom(performancesBody, performancesStep);
  const performance = pickByRunId(performances, performancesStep, `${selectionId}:performance`, attempt);
  const performanceId = requireField(performance, 'id', performancesStep);

  const seatsBody = getJson(
    config,
    seatsStep,
    `/performances/${encodeURIComponent(performanceId)}/seats`,
    { limit: config.seatLimit },
  );
  const seats = availableSeats(itemsFrom(seatsBody, seatsStep));
  const seat = pickByRunId(seats, seatsStep, `${selectionId}:seat`, attempt);

  return {
    concertId,
    performanceId,
    showtimeId: performanceId,
    seatId: requireField(seat, 'id', seatsStep),
    seatCount: seats.length,
  };
}

export function selectSeatContentionTarget(config, attempt = 0) {
  const selectionId = config.runId || config.iterationId;
  const concertsStep = stepName(config, 'concerts');
  const performancesStep = stepName(config, 'performances');
  const seatsStep = stepName(config, 'seats');
  const concertsBody = getJson(config, concertsStep, '/concerts', { limit: config.concertLimit });
  const concerts = datasetConcerts(config, itemsFrom(concertsBody, concertsStep));
  const concert = pickByRunId(concerts, concertsStep, `${selectionId}:concert`, 0);
  const concertId = requireField(concert, 'id', concertsStep);

  const performancesBody = getJson(
    config,
    performancesStep,
    `/concerts/${encodeURIComponent(concertId)}/performances`,
    { limit: config.performanceLimit },
  );
  const performances = itemsFrom(performancesBody, performancesStep);
  const performance = pickByRunId(performances, performancesStep, `${selectionId}:performance`, 0);
  const performanceId = requireField(performance, 'id', performancesStep);

  const seatsBody = getJson(
    config,
    seatsStep,
    `/performances/${encodeURIComponent(performanceId)}/seats`,
    { limit: config.seatLimit },
  );
  const seats = itemsFrom(seatsBody, seatsStep);
  if (seats.length === 0) {
    fail(`${seatsStep} returned no candidate seats`);
  }
  const candidateCount = Math.min(config.seatCandidateCount || seats.length, seats.length);
  const seat = seats[(hashString(`${config.iterationId}:seat`) + attempt) % candidateCount];

  return {
    concertId,
    performanceId,
    showtimeId: performanceId,
    seatId: requireField(seat, 'id', seatsStep),
    seatCount: seats.length,
    seatCandidateCount: candidateCount,
  };
}

export function createReservationAttempt(config, token, target) {
  return requestObservedStatuses(
    config,
    stepName(config, 'reservation.create'),
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
}

function createReservation(config, token, target, onConflict) {
  const step = stepName(config, 'reservation.create');
  const response = createReservationAttempt(config, token, target);
  const isConflict = response.status === 409;
  onConflict(isConflict);
  if (isConflict) {
    return null;
  }
  if (response.status !== 201) {
    fail(`${step} failed with status ${response.status}`);
  }
  let body;
  try {
    body = response.json();
  } catch (error) {
    fail(`${step} returned invalid json: ${error.message}`);
  }
  requireField(body, 'id', step);
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
    let cursor = null;
    for (let page = 0; page < config.ticketListMaxPages; page += 1) {
      const query = {
        limit: config.ticketListLimit,
        cursor,
      };
      const body = requestJson(
        config,
        'reservation_journey.ticket.list',
        'GET',
        '/tickets/me',
        null,
        authHeaders(token),
        query,
      );
      const items = itemsFrom(body, 'reservation_journey.ticket.list');
      const ticket = items.find((item) => ticketMatches(item, reservation));
      if (ticket) {
        return ticket;
      }
      cursor = body.nextCursor;
      if (!cursor) {
        break;
      }
    }
    sleep(config.pollIntervalSeconds);
  }
  fail(`reservation_journey.ticket.list did not return a ticket for reservation ${reservation.id}`);
  return null;
}
