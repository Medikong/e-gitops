# syntax=docker/dockerfile:1.7
FROM grafana/k6:2.0.0

USER root
WORKDIR /loadtest

RUN install -d -o 12345 -g 12345 /loadtest /home/k6 \
  && cat > /usr/local/bin/run-k6 <<'EOF'
#!/bin/sh
set -u

report_dir="${LOADTEST_REPORT_DIR:-/loadtest/reports/unknown}"
service="${LOADTEST_SERVICE:-unknown}"
trial_id="${LOADTEST_TRIAL_ID:-unknown}"
control_dir="${report_dir}/control/${service}"
started_marker="${control_dir}/${trial_id}.started"
finished_marker="${control_dir}/${trial_id}.finished"

mkdir -p "${report_dir}/raw/k6/${service}" "${control_dir}"
exit_code=$?
if [ "${exit_code}" -ne 0 ]; then
  printf '{"event":"loadtest_runner_status","timestamp":"%s","run_id":"%s","service":"%s","trial_id":"%s","status":"failed","exit_code":%s,"reason":"report_directory"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOADTEST_RUN_ID:-unknown}" "${service}" "${trial_id}" "${exit_code}"
  exit "${exit_code}"
fi

rm -f "${started_marker}" "${finished_marker}"
date -u +%Y-%m-%dT%H:%M:%SZ > "${started_marker}.tmp"
mv "${started_marker}.tmp" "${started_marker}"

set +e
k6 "$@"
exit_code=$?
set -e

date -u +%Y-%m-%dT%H:%M:%SZ > "${finished_marker}.tmp"
mv "${finished_marker}.tmp" "${finished_marker}"

status=failed
if [ "${exit_code}" -eq 0 ]; then
  status=success
fi

printf '{"event":"loadtest_runner_status","timestamp":"%s","run_id":"%s","service":"%s","trial_id":"%s","status":"%s","exit_code":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOADTEST_RUN_ID:-unknown}" "${service}" "${trial_id}" "${status}" "${exit_code}"

# Preserve every k6 failure, including threshold exit codes 99 and 201.
exit "${exit_code}"
EOF

RUN chmod 0755 /usr/local/bin/run-k6 \
  && chown -R 12345:12345 /loadtest /home/k6

COPY --chown=12345:12345 workloads ./workloads
COPY --chown=12345:12345 lib ./lib

USER 12345:12345
ENTRYPOINT ["/usr/local/bin/run-k6"]
CMD ["run", "/loadtest/workloads/catalog-service.js"]
