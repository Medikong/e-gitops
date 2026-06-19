import { fail, sleep } from 'k6';

import { authHeaders, getJson, requestJson, requestWithExpectedStatuses } from '../../lib/http.js';
import { itemsFrom, requireField } from '../../lib/pick.js';

function isoMinutesFromNow(minutes) {
  const date = new Date(Date.now() + minutes * 60 * 1000);
  return date.toISOString();
}

function isoDaysFromNow(days) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

function concertTitle(config, index) {
  return `${config.dataset.titlePrefix} ${config.dataset.profile} ${config.dataset.revision} ${String(index).padStart(4, '0')}`;
}

function buildSeatMap(config) {
  const sections = [];
  for (let section = 1; section <= config.dataset.seatSections; section += 1) {
    const rows = [];
    for (let row = 1; row <= config.dataset.seatRows; row += 1) {
      const seatNumbers = [];
      for (let seat = 1; seat <= config.dataset.seatsPerRow; seat += 1) {
        seatNumbers.push(String(seat));
      }
      rows.push({ name: String(row), seatNumbers });
    }
    sections.push({ name: `L${section}`, rows });
  }
  return { sections };
}

function existingDatasetConcerts(config) {
  const body = getJson(config, 'dataset.public_concerts.discover', '/concerts', {
    limit: config.dataset.discoveryLimit,
  });
  const expectedPrefix = `${config.dataset.titlePrefix} ${config.dataset.profile} ${config.dataset.revision} `;
  return itemsFrom(body, 'dataset.public_concerts.discover')
    .filter((concert) => String(concert.title || '').startsWith(expectedPrefix));
}

function createVenue(config, providerToken, concertIndex, performanceIndex) {
  const totalSeats = config.dataset.seatSections * config.dataset.seatRows * config.dataset.seatsPerRow;
  return requestJson(
    config,
    'dataset.venue.create',
    'POST',
    '/provider/venues',
    {
      name: `${config.dataset.venuePrefix} ${config.dataset.profile} ${config.dataset.revision} ${concertIndex}-${performanceIndex}`,
      address: 'Loadtest dataset',
      totalSeats,
    },
    authHeaders(providerToken),
  );
}

function createConcert(config, providerToken, index) {
  return requestJson(
    config,
    'dataset.concert.create',
    'POST',
    '/provider/concerts',
    {
      title: concertTitle(config, index),
      description: `Loadtest dataset ${config.dataset.profile}/${config.dataset.revision}/${index}`,
      ageRating: 'ALL',
      runningMinutes: 90,
    },
    authHeaders(providerToken),
  );
}

function createShowtime(config, providerToken, concert, venue, concertIndex, performanceIndex) {
  const concertId = requireField(concert, 'id', 'dataset.concert.create');
  const venueId = requireField(venue, 'id', 'dataset.venue.create');
  const offsetMinutes = (config.dataset.lookaheadDays * 24 * 60)
    + ((concertIndex * config.dataset.performancesPerConcert) + performanceIndex) * config.dataset.startsAtSpacingMinutes;
  return requestJson(
    config,
    'dataset.showtime.create',
    'POST',
    `/provider/concerts/${encodeURIComponent(concertId)}/showtimes`,
    {
      venueId,
      startsAt: isoMinutesFromNow(offsetMinutes),
    },
    authHeaders(providerToken),
  );
}

function uploadSeatMap(config, providerToken, showtime) {
  const showtimeId = requireField(showtime, 'id', 'dataset.showtime.create');
  requestWithExpectedStatuses(
    config,
    'dataset.seat_map.upload',
    'POST',
    `/provider/showtimes/${encodeURIComponent(showtimeId)}/seat-map`,
    buildSeatMap(config),
    authHeaders(providerToken),
    {},
    [204],
  );
}

function approveSalePolicy(config, providerToken, adminToken, concert) {
  const concertId = requireField(concert, 'id', 'dataset.concert.create');
  requestJson(
    config,
    'dataset.sale_policy.submit',
    'PUT',
    `/provider/concerts/${encodeURIComponent(concertId)}/sale-policy`,
    {
      presaleEnabled: false,
      fanclubVerificationRequired: false,
      maxTicketsPerUser: 4,
      refundPolicy: 'Loadtest dataset policy.',
    },
    authHeaders(providerToken),
  );
  requestJson(
    config,
    'dataset.sale_policy.approve',
    'POST',
    `/admin/concerts/${encodeURIComponent(concertId)}/sale-policy/approve`,
    {},
    authHeaders(adminToken),
  );
}

function openSales(config, adminToken, concert) {
  const concertId = requireField(concert, 'id', 'dataset.concert.create');
  requestJson(
    config,
    'dataset.open_schedule.update',
    'PUT',
    `/admin/concerts/${encodeURIComponent(concertId)}/open-schedule`,
    {
      opensAt: isoDaysFromNow(-1),
      comment: 'Loadtest dataset open schedule.',
    },
    authHeaders(adminToken),
  );
}

function performancesForConcert(config, concert) {
  const concertId = requireField(concert, 'id', 'dataset.concert.verify');
  const body = getJson(
    config,
    'dataset.performances.verify',
    `/concerts/${encodeURIComponent(concertId)}/performances`,
    { limit: Math.max(config.dataset.performancesPerConcert, 50) },
  );
  return itemsFrom(body, 'dataset.performances.verify');
}

function verifySeats(config, performance) {
  const performanceId = requireField(performance, 'id', 'dataset.performances.verify');
  const body = getJson(
    config,
    'dataset.seats.verify',
    `/performances/${encodeURIComponent(performanceId)}/seats`,
    { limit: config.seatLimit },
  );
  const seats = itemsFrom(body, 'dataset.seats.verify');
  if (seats.length === 0) {
    fail(`dataset.seats.verify returned no seats for performance ${performanceId}`);
  }
  return seats.length;
}

function createPerformanceWithSeats(config, providerToken, concert, concertIndex, performanceIndex) {
  const venue = createVenue(config, providerToken, concertIndex, performanceIndex);
  const showtime = createShowtime(config, providerToken, concert, venue, concertIndex, performanceIndex);
  uploadSeatMap(config, providerToken, showtime);
  return showtime;
}

function pauseAfterDatasetUnit(config) {
  if (config.dataset.createPauseSeconds > 0) {
    sleep(config.dataset.createPauseSeconds);
  }
}

export function setupReadApiBasicDataset(config, tokens) {
  const existing = new Map(existingDatasetConcerts(config).map((concert) => [concert.title, concert]));
  const state = {
    createdConcerts: 0,
    reusedConcerts: 0,
    createdPerformances: 0,
    verifiedConcerts: 0,
    verifiedPerformances: 0,
    verifiedSeats: 0,
  };

  for (let index = 1; index <= config.dataset.concerts; index += 1) {
    const title = concertTitle(config, index);
    let concert = existing.get(title);
    const isNewConcert = !concert;
    if (isNewConcert) {
      concert = createConcert(config, tokens.provider, index);
      state.createdConcerts += 1;
    } else {
      state.reusedConcerts += 1;
    }

    const currentPerformances = isNewConcert ? [] : performancesForConcert(config, concert);
    for (let performanceIndex = currentPerformances.length; performanceIndex < config.dataset.performancesPerConcert; performanceIndex += 1) {
      createPerformanceWithSeats(config, tokens.provider, concert, index, performanceIndex + 1);
      state.createdPerformances += 1;
    }

    if (isNewConcert) {
      approveSalePolicy(config, tokens.provider, tokens.admin, concert);
      openSales(config, tokens.admin, concert);
    }

    const verifiedPerformances = performancesForConcert(config, concert);
    if (verifiedPerformances.length < config.dataset.performancesPerConcert) {
      fail(`dataset.performances.verify expected ${config.dataset.performancesPerConcert} performances for ${title}, got ${verifiedPerformances.length}`);
    }
    state.verifiedPerformances += verifiedPerformances.length;
    state.verifiedSeats += verifySeats(config, verifiedPerformances[0]);
    state.verifiedConcerts += 1;
    pauseAfterDatasetUnit(config);
  }

  return state;
}
