function positive(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be a positive number`);
  return number;
}

export function buildRampSchedule({ startRps, maxRps, increaseRpsPerSecond }) {
  const start = positive('startRps', startRps);
  const maximum = positive('maxRps', maxRps);
  const increase = positive('increaseRpsPerSecond', increaseRpsPerSecond);
  if (maximum <= start) throw new TypeError('maxRps must be greater than startRps');
  const durationSeconds = (maximum - start) / increase;
  return {
    startRps: start,
    maxRps: maximum,
    increaseRpsPerSecond: increase,
    durationSeconds,
    stages: [{ duration: `${durationSeconds}s`, target: maximum }],
  };
}

export function targetRpsAt(schedule, elapsedSeconds) {
  const elapsed = Math.max(0, Number(elapsedSeconds));
  if (!Number.isFinite(elapsed)) throw new TypeError('elapsedSeconds must be finite');
  return Math.min(schedule.maxRps, schedule.startRps + schedule.increaseRpsPerSecond * elapsed);
}

export function averageTargetRps(schedule, startSeconds, endSeconds) {
  const start = targetRpsAt(schedule, startSeconds);
  const end = targetRpsAt(schedule, endSeconds);
  return (start + end) / 2;
}
