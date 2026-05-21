#!/usr/bin/env bash
set -euo pipefail

url="${LOCAL_API_GATEWAY_URL:-http://10.10.10.240}"
staff_token="${STAFF_TOKEN:-}"
response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT

if [ -z "${staff_token}" ]; then
  staff_token="$(
    python3 - <<'PY'
import base64
import hashlib
import hmac
import json
import time

def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def sign(payload, secret):
    header = {"alg": "HS256", "typ": "JWT"}
    header_part = b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_part = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_part}.{payload_part}".encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_part}.{payload_part}.{b64url(signature)}"

print(sign({"iss": "staff", "sub": "staff-1", "role": "STAFF", "exp": int(time.time()) + 900}, "staff-secret"))
PY
  )"
fi

for _ in $(seq 1 20); do
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' "${url}/patients" || true)"
  if [ "${status_code}" = "401" ] || [ "${status_code}" = "200" ] || [ "${status_code}" = "403" ]; then
    break
  fi
  sleep 1
done

status_code="$(
  curl -sS -o "${response_file}" -w '%{http_code}' -X POST "${url}/patients" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${staff_token}" \
    -d '{"name":"K8s Smoke Patient","birthDate":"1990-01-01","gender":"F","contact":"010-0000-0000","primaryDoctorId":10}' \
    || true
)"

if [ "${status_code}" -lt 200 ] || [ "${status_code}" -ge 300 ]; then
  printf "patient create failed: HTTP %s\n" "${status_code}" >&2
  cat "${response_file}" >&2
  printf "\n" >&2
  exit 1
fi

patient_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' < "${response_file}")"

status_code="$(
  curl -sS -o "${response_file}" -w '%{http_code}' "${url}/patients/${patient_id}" \
    -H "Authorization: Bearer ${staff_token}" \
    || true
)"

if [ "${status_code}" -lt 200 ] || [ "${status_code}" -ge 300 ]; then
  printf "patient read failed: HTTP %s\n" "${status_code}" >&2
  cat "${response_file}" >&2
  printf "\n" >&2
  exit 1
fi

printf "ok: patient CRUD smoke passed with patientId=%s\n" "$patient_id"
