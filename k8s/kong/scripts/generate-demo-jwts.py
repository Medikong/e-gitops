#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import os
import time


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign(payload: dict, secret: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_part = b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_part = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_part}.{payload_part}".encode("ascii")
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_part}.{payload_part}.{b64url(signature)}"


def main() -> None:
    now = int(time.time())
    exp = now + int(os.environ.get("DEMO_TOKEN_TTL_SECONDS", "900"))
    patient_id = int(os.environ.get("DEMO_PATIENT_ID", "1"))
    doctor_id = int(os.environ.get("DEMO_DOCTOR_ID", "10"))
    tokens = {
        "STAFF": sign({"iss": "staff", "sub": "staff-1", "role": "STAFF", "exp": exp}, "staff-secret"),
        "PATIENT": sign(
            {"iss": "patient", "sub": f"patient-{patient_id}", "role": "PATIENT", "patientId": patient_id, "exp": exp},
            "patient-secret",
        ),
        "DOCTOR": sign(
            {"iss": "doctor", "sub": f"doctor-{doctor_id}", "role": "DOCTOR", "doctorId": doctor_id, "exp": exp},
            "doctor-secret",
        ),
    }

    for name, token in tokens.items():
        print(f"{name}_TOKEN={token}")


if __name__ == "__main__":
    main()
