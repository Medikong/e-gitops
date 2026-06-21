#!/usr/bin/env python3
import base64
import csv
import hashlib
import io
import json
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg2
from psycopg2.extras import execute_values
from pymongo.errors import BulkWriteError
from pymongo import MongoClient


REVISION = os.getenv("LOADTEST_DATASET_REVISION", "capacity-baseline-half-year-early-growth-v2")
PASSWORD = os.getenv("LOADTEST_CUSTOMER_POOL_PASSWORD", "loadtest1234")
EMAIL_PREFIX = os.getenv("LOADTEST_CUSTOMER_POOL_EMAIL_PREFIX", "capacity-customer")
EMAIL_DOMAIN = os.getenv("LOADTEST_CUSTOMER_POOL_EMAIL_DOMAIN", "loadtest.medikong.local")
CUSTOMER_COUNT = int(os.getenv("LOADTEST_CUSTOMER_POOL_SIZE", "100000"))
PROVIDER_ID = 910001
ADMIN_ID = 910002
CUSTOMER_ID_BASE = 920000
BASE_SHOWTIME_DATE = os.getenv("LOADTEST_CAPACITY_BASELINE_PERFORMANCE_DATE", "2026-07-01")
PAYMENT_AMOUNT = int(os.getenv("LOADTEST_CAPACITY_BASELINE_PAYMENT_AMOUNT", "50000"))


def env_int(name: str, fallback: int) -> int:
    value = os.getenv(name)
    return fallback if value in (None, "") else int(value)


def _hash_password(password: str) -> str:
    salt = b"capacity-baseline"
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210000)
    return "pbkdf2_sha256$210000$%s$%s" % (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


PASSWORD_HASH = os.getenv("LOADTEST_CAPACITY_BASELINE_PASSWORD_HASH", _hash_password(PASSWORD))


def uuid_id(*parts: object) -> str:
    name = ":".join([REVISION, *(str(part) for part in parts)])
    digest = bytearray(hashlib.sha256(name.encode("utf-8")).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x80
    digest[8] = (digest[8] & 0x3F) | 0x80
    value = digest.hex()
    return f"{value[:8]}-{value[8:12]}-{value[12:16]}-{value[16:20]}-{value[20:]}"


def concert_id(index: int) -> str:
    return uuid_id("concert", index)


def venue_id(index: int) -> str:
    return uuid_id("venue", index)


def showtime_id(concert_index: int, performance_index: int) -> str:
    return uuid_id("showtime", concert_index, performance_index)


def seat_id(index: int) -> str:
    return uuid_id("seat", index)


def delete_uuid_values(cursor, table: str, column: str, values: list[str], chunk_size: int = 5000):
    for start in range(0, len(values), chunk_size):
        cursor.execute(
            f"delete from {table} where {column} = any(%s::uuid[])",
            (values[start:start + chunk_size],),
        )


def pg_dsn(env_name: str, fallback: str) -> str:
    dsn = os.getenv(env_name, fallback)
    return dsn.replace("postgresql+psycopg://", "postgresql://")


@contextmanager
def pg(env_name: str, fallback: str):
    connection = psycopg2.connect(pg_dsn(env_name, fallback))
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def emit(event: str, **fields):
    print(json.dumps({
        "event": event,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "test_type": "loadtest",
        "loadtest_run_id": os.getenv("LOADTEST_RUN_ID", ""),
        "scenario": os.getenv("LOADTEST_SCENARIO", "setup-capacity-baseline-dataset"),
        **fields,
    }, default=str), flush=True)


def require_table(cursor, table: str, columns: set[str]):
    cursor.execute(
        """
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = %s
        """,
        (table,),
    )
    actual_columns = {row[0] for row in cursor.fetchall()}
    missing_columns = columns - actual_columns
    if missing_columns:
        raise RuntimeError(f"{table} missing columns: {sorted(missing_columns)}")


def require_unique_columns(cursor, table: str, columns: tuple[str, ...]):
    cursor.execute(
        """
        select array_agg(attribute.attname order by key.ordinality)
        from pg_index ix
        join pg_class table_class on table_class.oid = ix.indrelid
        join unnest(ix.indkey) with ordinality as key(attnum, ordinality) on true
        join pg_attribute attribute
          on attribute.attrelid = table_class.oid
         and attribute.attnum = key.attnum
        where table_class.relname = %s
          and ix.indisunique
          and key.attnum > 0
        group by ix.indexrelid
        """,
        (table,),
    )
    unique_sets = [tuple(row[0]) for row in cursor.fetchall()]
    if columns not in unique_sets:
        raise RuntimeError(f"{table} missing unique columns: {columns}")


def row_count(cursor, sql: str, params: tuple = ()) -> int:
    cursor.execute(sql, params)
    return int(cursor.fetchone()[0])


def expect_count(name: str, actual: int, expected: int):
    if actual != expected:
        raise RuntimeError(f"{name} row count mismatch: expected={expected} actual={actual}")
    return actual


def _copy_value(value):
    if value is None:
        return r"\N"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return value


def copy_rows(cursor, table: str, columns: tuple[str, ...], rows: list[tuple]):
    if not rows:
        return
    stream = io.StringIO()
    writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
    for row in rows:
        writer.writerow([_copy_value(value) for value in row])
    stream.seek(0)
    column_list = ", ".join(columns)
    cursor.copy_expert(
        f"copy {table} ({column_list}) from stdin with (format csv, delimiter E'\\t', null '\\N')",
        stream,
    )


def seed_auth(counts: dict):
    with pg("LOADTEST_CAPACITY_BASELINE_AUTH_DATABASE_URL", "postgresql://user:password@auth-db:5432/auth_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "users", {"id", "email", "password_hash", "display_name", "role", "is_active"})
        require_unique_columns(cursor, "users", ("email",))
        cursor.execute(
            """
            delete from users
            where email like %s
               or email in (
                 'capacity-provider@loadtest.medikong.local',
                 'capacity-admin@loadtest.medikong.local'
               )
            """,
            (f"{EMAIL_PREFIX}-%@{EMAIL_DOMAIN}",),
        )
        users = [
            (PROVIDER_ID, "capacity-provider@loadtest.medikong.local", PASSWORD_HASH, "Capacity Provider", "PROVIDER", True),
            (ADMIN_ID, "capacity-admin@loadtest.medikong.local", PASSWORD_HASH, "Capacity Admin", "ADMIN", True),
        ]
        for index in range(1, CUSTOMER_COUNT + 1):
            users.append((
                CUSTOMER_ID_BASE + index,
                f"{EMAIL_PREFIX}-{index:06d}@{EMAIL_DOMAIN}",
                PASSWORD_HASH,
                f"Capacity Customer {index:06d}",
                "CUSTOMER",
                True,
            ))
        copy_rows(cursor, "users", ("id", "email", "password_hash", "display_name", "role", "is_active"), users)
        counts["auth.users"] = expect_count(
            "auth.users",
            row_count(
                cursor,
                """
                select count(*)
                from users
                where email like %s
                   or email in (
                     'capacity-provider@loadtest.medikong.local',
                     'capacity-admin@loadtest.medikong.local'
                   )
                """,
                (f"{EMAIL_PREFIX}-%@{EMAIL_DOMAIN}",),
            ),
            CUSTOMER_COUNT + 2,
        )


def seed_concert(counts: dict):
    concert_count = env_int("LOADTEST_DATASET_CONCERTS", 270)
    performances_per_concert = env_int("LOADTEST_DATASET_PERFORMANCES_PER_CONCERT", 3)
    seat_rows = env_int("LOADTEST_DATASET_SEAT_ROWS", 20)
    seats_per_row = env_int("LOADTEST_DATASET_SEATS_PER_ROW", 35)
    total_seats_per_performance = seat_rows * seats_per_row
    now = datetime.now(timezone.utc)
    base_date = datetime.fromisoformat(BASE_SHOWTIME_DATE).replace(tzinfo=timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_CONCERT_DATABASE_URL", "postgresql://user:password@concert-db:5432/concert_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "concerts", {"id", "provider_id", "title", "age_rating", "running_minutes", "status", "created_at", "opens_at", "open_schedule_status"})
        require_table(cursor, "venues", {"id", "name", "address", "total_seats"})
        require_table(cursor, "showtimes", {"id", "concert_id", "venue_id", "starts_at", "ends_at", "status"})
        require_table(cursor, "seats", {"id", "showtime_id", "section", "row_label", "number", "status"})
        require_unique_columns(cursor, "seats", ("showtime_id", "section", "row_label", "number"))
        require_table(cursor, "seat_grades", {"id", "showtime_id", "name", "price", "color"})
        require_unique_columns(cursor, "seat_grades", ("showtime_id", "name"))
        concert_ids = [concert_id(index) for index in range(1, concert_count + 1)]
        venue_ids = [venue_id(index) for index in range(1, concert_count + 1)]
        showtime_ids = [
            showtime_id(concert_index, performance_index)
            for concert_index in range(1, concert_count + 1)
            for performance_index in range(1, performances_per_concert + 1)
        ]
        delete_uuid_values(cursor, "seats", "showtime_id", showtime_ids)
        delete_uuid_values(cursor, "seat_grades", "showtime_id", showtime_ids)
        delete_uuid_values(cursor, "showtimes", "id", showtime_ids)
        delete_uuid_values(cursor, "venues", "id", venue_ids)
        delete_uuid_values(cursor, "concerts", "id", concert_ids)

        venues = []
        concerts = []
        showtimes = []
        grades = []
        seats = []
        seat_seq = 1
        for concert_index in range(1, concert_count + 1):
            current_concert_id = concert_id(concert_index)
            current_venue_id = venue_id(concert_index)
            venues.append((current_venue_id, f"Capacity Hall {concert_index:04d}", "Loadtest", total_seats_per_performance))
            concerts.append((
                current_concert_id,
                str(PROVIDER_ID),
                f"Capacity Baseline Concert {concert_index:04d}",
                "Loadtest concert",
                None,
                "ALL",
                120,
                "open",
                now,
                now,
                now - timedelta(days=1),
                "open",
                now,
                None,
            ))
            for performance_index in range(1, performances_per_concert + 1):
                current_showtime_id = showtime_id(concert_index, performance_index)
                starts_at = base_date + timedelta(days=concert_index - 1, hours=performance_index - 1)
                showtimes.append((current_showtime_id, current_concert_id, current_venue_id, starts_at, starts_at + timedelta(hours=2), "open"))
                for grade_index, (grade_name, price, color) in enumerate((
                    ("VIP", 150000, "#d97706"),
                    ("R", 120000, "#2563eb"),
                    ("S", 90000, "#16a34a"),
                    ("A", 60000, "#7c3aed"),
                ), start=1):
                    grades.append((uuid_id("grade", concert_index, performance_index, grade_index), current_showtime_id, grade_name, price, color))
                for row in range(1, seat_rows + 1):
                    for number in range(1, seats_per_row + 1):
                        section = chr(ord("A") + ((row - 1) % 4))
                        seats.append((seat_id(seat_seq), current_showtime_id, section, f"{row}", f"{number}", "sellable"))
                        seat_seq += 1
        copy_rows(cursor, "venues", ("id", "name", "address", "total_seats"), venues)
        copy_rows(
            cursor,
            "concerts",
            ("id", "provider_id", "title", "description", "poster_url", "age_rating", "running_minutes", "status", "created_at", "updated_at", "opens_at", "open_schedule_status", "last_reviewed_at", "review_reason"),
            concerts,
        )
        copy_rows(cursor, "showtimes", ("id", "concert_id", "venue_id", "starts_at", "ends_at", "status"), showtimes)
        copy_rows(cursor, "seat_grades", ("id", "showtime_id", "name", "price", "color"), grades)
        copy_rows(cursor, "seats", ("id", "showtime_id", "section", "row_label", "number", "status"), seats)
        counts["concert.concerts"] = expect_count("concert.concerts", row_count(cursor, "select count(*) from concerts where id = any(%s::uuid[])", (concert_ids,)), concert_count)
        counts["concert.showtimes"] = expect_count("concert.showtimes", row_count(cursor, "select count(*) from showtimes where id = any(%s::uuid[])", (showtime_ids,)), concert_count * performances_per_concert)
        counts["concert.seats"] = expect_count("concert.seats", row_count(cursor, "select count(*) from seats where showtime_id = any(%s::uuid[])", (showtime_ids,)), len(seats))
        counts["concert.seat_grades"] = expect_count("concert.seat_grades", row_count(cursor, "select count(*) from seat_grades where showtime_id = any(%s::uuid[])", (showtime_ids,)), len(grades))


def seed_reservation(counts: dict):
    concert_count = env_int("LOADTEST_DATASET_CONCERTS", 270)
    performances_per_concert = env_int("LOADTEST_DATASET_PERFORMANCES_PER_CONCERT", 3)
    total_seats = concert_count * performances_per_concert * env_int("LOADTEST_DATASET_SEAT_ROWS", 20) * env_int("LOADTEST_DATASET_SEATS_PER_ROW", 35)
    reservation_history_count = env_int("LOADTEST_CAPACITY_BASELINE_RESERVATION_HISTORY_COUNT", 261000)
    paid_history_count = env_int("LOADTEST_CAPACITY_BASELINE_RESERVATION_PAID_COUNT", 170000)
    canceled_history_count = env_int("LOADTEST_CAPACITY_BASELINE_RESERVATION_CANCELED_COUNT", 45500)
    payment_pool = env_int("LOADTEST_CAPACITY_BASELINE_PAYMENT_POOL_COUNT", 184000)
    now = datetime.now(timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_RESERVATION_DATABASE_URL", "postgresql://user:password@reservation-db:5432/reservation_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "sales_states", {"concert_id", "sales_status", "total_seats", "updated_at"})
        require_table(cursor, "queue_policies", {"concert_id", "enabled", "max_entrants_per_minute", "waiting_room_url"})
        require_table(cursor, "traffic_policies", {"concert_id", "macro_protection_enabled", "max_requests_per_user_per_minute", "block_suspicious_traffic"})
        require_table(cursor, "reservations", {"id", "user_id", "concert_id", "showtime_id", "performance_id", "seat_id", "status", "active_seat_key", "expires_at", "created_at", "updated_at"})
        require_unique_columns(cursor, "reservations", ("active_seat_key",))
        concert_ids = [concert_id(index) for index in range(1, concert_count + 1)]
        delete_uuid_values(cursor, "reservations", "concert_id", concert_ids)
        delete_uuid_values(cursor, "sales_states", "concert_id", concert_ids)
        delete_uuid_values(cursor, "queue_policies", "concert_id", concert_ids)
        delete_uuid_values(cursor, "traffic_policies", "concert_id", concert_ids)
        sales = [(concert_id(index), "open", total_seats, now) for index in range(1, concert_count + 1)]
        execute_values(cursor, "insert into sales_states (concert_id, sales_status, total_seats, updated_at) values %s on conflict (concert_id) do update set sales_status = excluded.sales_status, total_seats = excluded.total_seats, updated_at = excluded.updated_at", sales)
        execute_values(cursor, "insert into queue_policies (concert_id, enabled, max_entrants_per_minute, waiting_room_url) values %s on conflict (concert_id) do update set enabled = excluded.enabled, max_entrants_per_minute = excluded.max_entrants_per_minute", [(row[0], False, None, None) for row in sales])
        execute_values(cursor, "insert into traffic_policies (concert_id, macro_protection_enabled, max_requests_per_user_per_minute, block_suspicious_traffic) values %s on conflict (concert_id) do update set macro_protection_enabled = excluded.macro_protection_enabled, max_requests_per_user_per_minute = excluded.max_requests_per_user_per_minute, block_suspicious_traffic = excluded.block_suspicious_traffic", [(row[0], False, None, False) for row in sales])
        reservations = []
        for index in range(1, reservation_history_count + 1):
            if index <= paid_history_count:
                status = "paid"
            elif index <= paid_history_count + canceled_history_count:
                status = "canceled"
            else:
                status = "expired"
            concert_index = ((index - 1) % concert_count) + 1
            performance_index = ((index - 1) % performances_per_concert) + 1
            current_showtime_id = showtime_id(concert_index, performance_index)
            current_seat_id = uuid_id("history-seat", index)
            reservations.append((
                uuid_id("reservation-history", index),
                str(CUSTOMER_ID_BASE + ((index - 1) % CUSTOMER_COUNT) + 1),
                concert_id(concert_index),
                current_showtime_id,
                current_showtime_id,
                current_seat_id,
                status,
                None,
                now - timedelta(days=1),
                now - timedelta(days=index % 180),
                now - timedelta(days=index % 180),
            ))
        for index in range(1, payment_pool + 1):
            payment_seat_id = uuid_id("payment-seat", index)
            first_showtime_id = showtime_id(1, 1)
            reservations.append((
                uuid_id("pending-reservation", index),
                str(CUSTOMER_ID_BASE + ((index - 1) % CUSTOMER_COUNT) + 1),
                concert_id(1),
                first_showtime_id,
                first_showtime_id,
                payment_seat_id,
                "pending",
                payment_seat_id,
                now + timedelta(minutes=30),
                now,
                now,
            ))
        copy_rows(cursor, "reservations", ("id", "user_id", "concert_id", "showtime_id", "performance_id", "seat_id", "status", "active_seat_key", "expires_at", "created_at", "updated_at"), reservations)
        history_ids = [uuid_id("reservation-history", index) for index in range(1, reservation_history_count + 1)]
        pending_ids = [uuid_id("pending-reservation", index) for index in range(1, payment_pool + 1)]
        counts["reservation.sales_states"] = expect_count("reservation.sales_states", row_count(cursor, "select count(*) from sales_states where concert_id = any(%s::uuid[])", (concert_ids,)), concert_count)
        counts["reservation.history"] = expect_count("reservation.history", row_count(cursor, "select count(*) from reservations where id = any(%s::uuid[])", (history_ids,)), reservation_history_count)
        counts["reservation.pending_pool"] = expect_count("reservation.pending_pool", row_count(cursor, "select count(*) from reservations where id = any(%s::uuid[])", (pending_ids,)), payment_pool)


def seed_payment(counts: dict):
    payment_count = env_int("LOADTEST_CAPACITY_BASELINE_PAYMENT_HISTORY_COUNT", 184000)
    approved_count = env_int("LOADTEST_CAPACITY_BASELINE_PAYMENT_APPROVED_COUNT", 170000)
    now = datetime.now(timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_PAYMENT_DATABASE_URL", "postgresql://user:password@payment-db:5432/payment_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "payments", {"id", "reservation_id", "concert_id", "user_id", "amount", "method", "status", "idempotency_key", "approved_at", "created_at"})
        require_table(cursor, "payment_events", {"id", "event_type", "payment_id", "payload", "trace_context", "publish_status", "published_at", "publish_attempts", "last_publish_error", "created_at"})
        require_unique_columns(cursor, "payments", ("user_id", "idempotency_key"))
        payment_ids = [uuid_id("payment", index) for index in range(1, payment_count + 1)]
        event_ids = [uuid_id("payment-event", index) for index in range(1, payment_count + 1)]
        delete_uuid_values(cursor, "payment_events", "id", event_ids)
        delete_uuid_values(cursor, "payments", "id", payment_ids)
        payments = []
        events = []
        for index in range(1, payment_count + 1):
            status = "approved" if index <= approved_count else "failed"
            current_payment_id = uuid_id("payment", index)
            current_event_id = uuid_id("payment-event", index)
            reservation_id = uuid_id("payment-history-reservation", index)
            current_concert_id = concert_id(((index - 1) % env_int("LOADTEST_DATASET_CONCERTS", 270)) + 1)
            user_id = str(CUSTOMER_ID_BASE + ((index - 1) % CUSTOMER_COUNT) + 1)
            payments.append((
                current_payment_id,
                reservation_id,
                current_concert_id,
                user_id,
                PAYMENT_AMOUNT,
                "CARD",
                status,
                f"{REVISION}-payment-idempotency-history-{index:06d}",
                now if status == "approved" else None,
                now,
            ))
            events.append((
                current_event_id,
                "payment-approved" if status == "approved" else "payment-failed",
                current_payment_id,
                {
                    "eventId": current_event_id,
                    "reservationId": reservation_id,
                    "paymentId": current_payment_id,
                    "concertId": current_concert_id,
                    "sourceId": current_payment_id,
                    "status": status,
                },
                None,
                "published",
                now,
                0,
                None,
                now,
            ))
        copy_rows(cursor, "payments", ("id", "reservation_id", "concert_id", "user_id", "amount", "method", "status", "idempotency_key", "approved_at", "created_at"), payments)
        copy_rows(cursor, "payment_events", ("id", "event_type", "payment_id", "payload", "trace_context", "publish_status", "published_at", "publish_attempts", "last_publish_error", "created_at"), events)
        counts["payment.payments"] = expect_count("payment.payments", row_count(cursor, "select count(*) from payments where id = any(%s::uuid[])", (payment_ids,)), payment_count)
        counts["payment.payment_events"] = expect_count("payment.payment_events", row_count(cursor, "select count(*) from payment_events where id = any(%s::uuid[])", (event_ids,)), payment_count)


def seed_ticket(counts: dict):
    ticket_count = env_int("LOADTEST_CAPACITY_BASELINE_TICKET_HISTORY_COUNT", 170000)
    ticket_issue_pool = env_int("LOADTEST_CAPACITY_BASELINE_TICKET_ISSUE_POOL_COUNT", ticket_count)
    now = datetime.now(timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_TICKET_DATABASE_URL", "postgresql://user:password@ticket-db:5432/ticket_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "tickets", {"id", "reservation_id", "user_id", "concert_id", "seat_id", "status", "qr_url", "pdf_url", "issued_at"})
        require_unique_columns(cursor, "tickets", ("reservation_id",))
        ticket_ids = [uuid_id("ticket", index) for index in range(1, ticket_count + 1)]
        ticket_reservation_ids = [uuid_id("ticket-reservation", index) for index in range(1, ticket_count + 1)]
        issued_reservation_ids = [uuid_id("paid-reservation", index) for index in range(1, ticket_issue_pool + 1)]
        delete_uuid_values(cursor, "tickets", "id", ticket_ids)
        delete_uuid_values(cursor, "tickets", "reservation_id", ticket_reservation_ids)
        delete_uuid_values(cursor, "tickets", "reservation_id", issued_reservation_ids)
        cursor.execute(
            """
            delete from tickets
            where qr_url like %s
               or pdf_url like %s
            """,
            (
                f"https://tickets.local/{REVISION}/%",
                f"https://tickets.local/{REVISION}/%",
            ),
        )
        rows = []
        for index in range(1, ticket_count + 1):
            rows.append((
                uuid_id("ticket", index),
                uuid_id("ticket-reservation", index),
                str(CUSTOMER_ID_BASE + ((index - 1) % CUSTOMER_COUNT) + 1),
                concert_id(((index - 1) % env_int("LOADTEST_DATASET_CONCERTS", 270)) + 1),
                uuid_id("ticket-seat", index),
                "ISSUED",
                f"https://tickets.local/{REVISION}/{index}.png",
                f"https://tickets.local/{REVISION}/{index}.pdf",
                now,
            ))
        copy_rows(cursor, "tickets", ("id", "reservation_id", "user_id", "concert_id", "seat_id", "status", "qr_url", "pdf_url", "issued_at"), rows)
        counts["ticket.tickets"] = expect_count("ticket.tickets", row_count(cursor, "select count(*) from tickets where qr_url like %s", (f"https://tickets.local/{REVISION}/%",)), len(rows))


def seed_notification(counts: dict):
    notification_count = env_int("LOADTEST_CAPACITY_BASELINE_NOTIFICATION_COUNT", 354000)
    client = MongoClient(os.getenv("LOADTEST_CAPACITY_BASELINE_MONGODB_URL", os.getenv("MONGODB_URL", "mongodb://notification-db:27017")))
    db = client[os.getenv("LOADTEST_CAPACITY_BASELINE_MONGODB_DB_NAME", os.getenv("MONGODB_DB_NAME", "notification_db"))]
    db.notifications.delete_many({"metadata.dataset_revision": REVISION})
    documents = []
    now = datetime.now(timezone.utc)
    for index in range(1, notification_count + 1):
        source_id = uuid_id("notification-source", index)
        documents.append({
            "_id": source_id,
            "user_id": str(CUSTOMER_ID_BASE + ((index - 1) % CUSTOMER_COUNT) + 1),
            "type": "capacity-baseline",
            "message": f"Capacity baseline notification {index}",
            "status": "CREATED",
            "source_id": source_id,
            "metadata": {"dataset_revision": REVISION},
            "created_at": now - timedelta(days=index % 90),
        })
    if documents:
        try:
            for start in range(0, len(documents), 1000):
                db.notifications.insert_many(documents[start:start + 1000], ordered=False)
        except BulkWriteError as error:
            unexpected_errors = [
                write_error for write_error in error.details.get("writeErrors", [])
                if write_error.get("code") != 11000
            ]
            if unexpected_errors:
                raise
    count = db.notifications.count_documents({"metadata.dataset_revision": REVISION})
    counts["notification.notifications"] = expect_count("notification.notifications", count, len(documents))
    db.notifications.create_index([("user_id", 1), ("_id", -1)])
    client.close()


def main():
    counts = {}
    emit(
        "loadtest_experiment_conditions",
        phase="capacity_baseline_dataset_setup",
        dataset_revision=REVISION,
        seed_method="deterministic_bulk_insert",
    )
    seed_auth(counts)
    seed_concert(counts)
    seed_reservation(counts)
    seed_payment(counts)
    seed_ticket(counts)
    seed_notification(counts)
    emit(
        "loadtest_experiment_conditions",
        phase="capacity_baseline_dataset_ready",
        dataset_revision=REVISION,
        seed_method="deterministic_bulk_insert",
        seed_row_counts=counts,
    )


if __name__ == "__main__":
    main()
