#!/usr/bin/env python3
import base64
import hashlib
import json
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg2
from psycopg2.extras import execute_values
from pymongo import MongoClient, ReplaceOne


REVISION = os.getenv("LOADTEST_DATASET_REVISION", "capacity-baseline-v1")
PASSWORD = os.getenv("LOADTEST_CUSTOMER_POOL_PASSWORD", "loadtest1234")
EMAIL_PREFIX = os.getenv("LOADTEST_CUSTOMER_POOL_EMAIL_PREFIX", "capacity-customer")
EMAIL_DOMAIN = os.getenv("LOADTEST_CUSTOMER_POOL_EMAIL_DOMAIN", "loadtest.medikong.local")
CUSTOMER_COUNT = int(os.getenv("LOADTEST_CUSTOMER_POOL_SIZE", "120"))
PROVIDER_ID = 910001
ADMIN_ID = 910002
CUSTOMER_ID_BASE = 920000


def _hash_password(password: str) -> str:
    salt = b"capacity-baseline"
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 210000)
    return "pbkdf2_sha256$210000$%s$%s" % (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


PASSWORD_HASH = os.getenv("LOADTEST_CAPACITY_BASELINE_PASSWORD_HASH", _hash_password(PASSWORD))


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
        execute_values(
            cursor,
            """
            insert into users (id, email, password_hash, display_name, role, is_active)
            values %s
            on conflict (email) do update set
              password_hash = excluded.password_hash,
              display_name = excluded.display_name,
              role = excluded.role,
              is_active = excluded.is_active
            """,
            users,
        )
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
    concert_count = int(os.getenv("LOADTEST_DATASET_CONCERTS", "8"))
    performances_per_concert = int(os.getenv("LOADTEST_DATASET_PERFORMANCES_PER_CONCERT", "2"))
    seat_rows = int(os.getenv("LOADTEST_DATASET_SEAT_ROWS", "10"))
    seats_per_row = int(os.getenv("LOADTEST_DATASET_SEATS_PER_ROW", "50"))
    total_seats_per_performance = seat_rows * seats_per_row
    now = datetime.now(timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_CONCERT_DATABASE_URL", "postgresql://user:password@concert-db:5432/concert_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "concerts", {"id", "provider_id", "title", "age_rating", "running_minutes", "status", "created_at", "opens_at", "open_schedule_status"})
        require_table(cursor, "venues", {"id", "name", "address", "total_seats"})
        require_table(cursor, "showtimes", {"id", "concert_id", "venue_id", "starts_at", "ends_at", "status"})
        require_table(cursor, "seats", {"id", "showtime_id", "section", "row_label", "number", "status"})
        require_unique_columns(cursor, "seats", ("showtime_id", "section", "row_label", "number"))
        require_table(cursor, "seat_grades", {"id", "showtime_id", "name", "price", "color"})
        require_unique_columns(cursor, "seat_grades", ("showtime_id", "name"))
        cursor.execute("delete from seats where id like %s or showtime_id like %s", (f"{REVISION}-seat-%", f"{REVISION}-showtime-%"))
        cursor.execute("delete from seat_grades where id like %s or showtime_id like %s", (f"{REVISION}-grade-%", f"{REVISION}-showtime-%"))
        cursor.execute("delete from showtimes where id like %s or concert_id like %s", (f"{REVISION}-showtime-%", f"{REVISION}-concert-%"))
        cursor.execute("delete from venues where id like %s", (f"{REVISION}-venue-%",))
        cursor.execute("delete from concerts where id like %s", (f"{REVISION}-concert-%",))

        venues = []
        concerts = []
        showtimes = []
        grades = []
        seats = []
        seat_seq = 1
        for concert_index in range(1, concert_count + 1):
            concert_id = f"{REVISION}-concert-{concert_index:04d}"
            venue_id = f"{REVISION}-venue-{concert_index:04d}"
            venues.append((venue_id, f"Capacity Hall {concert_index:04d}", "Loadtest", total_seats_per_performance))
            concerts.append((
                concert_id,
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
                showtime_id = f"{REVISION}-showtime-{concert_index:04d}-{performance_index:04d}"
                starts_at = now + timedelta(days=concert_index, hours=performance_index)
                showtimes.append((showtime_id, concert_id, venue_id, starts_at, starts_at + timedelta(hours=2), "open"))
                grades.append((f"{REVISION}-grade-{concert_index:04d}-{performance_index:04d}", showtime_id, "R", 50000, "#3366cc"))
                for row in range(1, seat_rows + 1):
                    for number in range(1, seats_per_row + 1):
                        seats.append((f"{REVISION}-seat-{seat_seq:06d}", showtime_id, "A", f"{row}", f"{number}", "sellable"))
                        seat_seq += 1
        execute_values(cursor, "insert into venues (id, name, address, total_seats) values %s on conflict (id) do update set name = excluded.name, address = excluded.address, total_seats = excluded.total_seats", venues)
        execute_values(
            cursor,
            """
            insert into concerts (id, provider_id, title, description, poster_url, age_rating, running_minutes, status, created_at, updated_at, opens_at, open_schedule_status, last_reviewed_at, review_reason)
            values %s
            on conflict (id) do update set
              title = excluded.title,
              status = excluded.status,
              opens_at = excluded.opens_at,
              open_schedule_status = excluded.open_schedule_status
            """,
            concerts,
        )
        execute_values(cursor, "insert into showtimes (id, concert_id, venue_id, starts_at, ends_at, status) values %s on conflict (id) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = excluded.status", showtimes)
        execute_values(cursor, "insert into seat_grades (id, showtime_id, name, price, color) values %s on conflict (id) do update set price = excluded.price, color = excluded.color", grades)
        execute_values(cursor, "insert into seats (id, showtime_id, section, row_label, number, status) values %s on conflict (id) do update set status = excluded.status", seats, page_size=1000)
        counts["concert.concerts"] = expect_count("concert.concerts", row_count(cursor, "select count(*) from concerts where id like %s", (f"{REVISION}-concert-%",)), concert_count)
        counts["concert.showtimes"] = expect_count("concert.showtimes", row_count(cursor, "select count(*) from showtimes where id like %s", (f"{REVISION}-showtime-%",)), concert_count * performances_per_concert)
        counts["concert.seats"] = expect_count("concert.seats", row_count(cursor, "select count(*) from seats where id like %s", (f"{REVISION}-seat-%",)), len(seats))


def seed_reservation(counts: dict):
    total_seats = int(os.getenv("LOADTEST_DATASET_CONCERTS", "8")) * int(os.getenv("LOADTEST_DATASET_PERFORMANCES_PER_CONCERT", "2")) * int(os.getenv("LOADTEST_DATASET_SEAT_ROWS", "10")) * int(os.getenv("LOADTEST_DATASET_SEATS_PER_ROW", "50"))
    now = datetime.now(timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_RESERVATION_DATABASE_URL", "postgresql://user:password@reservation-db:5432/reservation_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "sales_states", {"concert_id", "sales_status", "total_seats", "updated_at"})
        require_table(cursor, "queue_policies", {"concert_id", "enabled", "max_entrants_per_minute", "waiting_room_url"})
        require_table(cursor, "traffic_policies", {"concert_id", "macro_protection_enabled", "max_requests_per_user_per_minute", "block_suspicious_traffic"})
        require_table(cursor, "reservations", {"id", "user_id", "concert_id", "showtime_id", "performance_id", "seat_id", "status", "active_seat_key", "expires_at", "created_at", "updated_at"})
        require_unique_columns(cursor, "reservations", ("active_seat_key",))
        cursor.execute(
            """
            delete from reservations
            where id like %s
               or concert_id like %s
               or showtime_id like %s
               or performance_id like %s
               or seat_id like %s
               or active_seat_key like %s
            """,
            (
                f"{REVISION}-%",
                f"{REVISION}-concert-%",
                f"{REVISION}-showtime-%",
                f"{REVISION}-showtime-%",
                f"{REVISION}-%",
                f"{REVISION}-%",
            ),
        )
        cursor.execute("delete from sales_states where concert_id like %s", (f"{REVISION}-concert-%",))
        cursor.execute("delete from queue_policies where concert_id like %s", (f"{REVISION}-concert-%",))
        cursor.execute("delete from traffic_policies where concert_id like %s", (f"{REVISION}-concert-%",))
        concert_count = int(os.getenv("LOADTEST_DATASET_CONCERTS", "8"))
        sales = [(f"{REVISION}-concert-{index:04d}", "open", total_seats, now) for index in range(1, concert_count + 1)]
        execute_values(cursor, "insert into sales_states (concert_id, sales_status, total_seats, updated_at) values %s on conflict (concert_id) do update set sales_status = excluded.sales_status, total_seats = excluded.total_seats, updated_at = excluded.updated_at", sales)
        execute_values(cursor, "insert into queue_policies (concert_id, enabled, max_entrants_per_minute, waiting_room_url) values %s on conflict (concert_id) do update set enabled = excluded.enabled, max_entrants_per_minute = excluded.max_entrants_per_minute", [(row[0], False, None, None) for row in sales])
        execute_values(cursor, "insert into traffic_policies (concert_id, macro_protection_enabled, max_requests_per_user_per_minute, block_suspicious_traffic) values %s on conflict (concert_id) do update set macro_protection_enabled = excluded.macro_protection_enabled, max_requests_per_user_per_minute = excluded.max_requests_per_user_per_minute, block_suspicious_traffic = excluded.block_suspicious_traffic", [(row[0], False, None, False) for row in sales])
        payment_pool = int(os.getenv("LOADTEST_CAPACITY_BASELINE_PAYMENT_POOL_COUNT", str(total_seats)))
        reservations = []
        for index in range(1, payment_pool + 1):
            reservations.append((
                f"{REVISION}-pending-reservation-{index:06d}",
                str(CUSTOMER_ID_BASE + ((index - 1) % CUSTOMER_COUNT) + 1),
                f"{REVISION}-concert-0001",
                f"{REVISION}-showtime-0001-0001",
                f"{REVISION}-showtime-0001-0001",
                f"{REVISION}-payment-seat-{index:06d}",
                "pending",
                f"{REVISION}-payment-seat-{index:06d}",
                now + timedelta(minutes=30),
                now,
                now,
            ))
        execute_values(cursor, "insert into reservations (id, user_id, concert_id, showtime_id, performance_id, seat_id, status, active_seat_key, expires_at, created_at, updated_at) values %s on conflict (id) do update set status = excluded.status, expires_at = excluded.expires_at, updated_at = excluded.updated_at", reservations, page_size=1000)
        counts["reservation.sales_states"] = expect_count("reservation.sales_states", row_count(cursor, "select count(*) from sales_states where concert_id like %s", (f"{REVISION}-concert-%",)), concert_count)
        counts["reservation.pending_pool"] = expect_count("reservation.pending_pool", row_count(cursor, "select count(*) from reservations where id like %s", (f"{REVISION}-pending-reservation-%",)), payment_pool)


def seed_payment(counts: dict):
    with pg("LOADTEST_CAPACITY_BASELINE_PAYMENT_DATABASE_URL", "postgresql://user:password@payment-db:5432/payment_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "payments", {"id", "reservation_id", "concert_id", "user_id", "amount", "method", "status", "idempotency_key", "approved_at", "created_at"})
        require_unique_columns(cursor, "payments", ("user_id", "idempotency_key"))
        cursor.execute(
            """
            delete from payments
            where reservation_id like %s
               or concert_id like %s
               or idempotency_key like %s
            """,
            (
                f"{REVISION}-%",
                f"{REVISION}-concert-%",
                f"{REVISION}-payment-idempotency-%",
            ),
        )
        counts["payment.payments"] = row_count(cursor, "select count(*) from payments where reservation_id like %s", (f"{REVISION}-%",))


def seed_ticket(counts: dict):
    tickets_per_customer = int(os.getenv("LOADTEST_CAPACITY_BASELINE_TICKETS_PER_CUSTOMER", "20"))
    now = datetime.now(timezone.utc)
    with pg("LOADTEST_CAPACITY_BASELINE_TICKET_DATABASE_URL", "postgresql://user:password@ticket-db:5432/ticket_db") as connection:
        cursor = connection.cursor()
        require_table(cursor, "tickets", {"reservation_id", "user_id", "concert_id", "seat_id", "status", "qr_url", "pdf_url", "issued_at"})
        require_unique_columns(cursor, "tickets", ("reservation_id",))
        cursor.execute(
            """
            delete from tickets
            where reservation_id like %s
               or concert_id like %s
               or seat_id like %s
            """,
            (
                f"{REVISION}-ticket-reservation-%",
                f"{REVISION}-concert-%",
                f"{REVISION}-ticket-seat-%",
            ),
        )
        rows = []
        for customer_index in range(1, CUSTOMER_COUNT + 1):
            user_id = str(CUSTOMER_ID_BASE + customer_index)
            for ticket_index in range(1, tickets_per_customer + 1):
                global_index = ((customer_index - 1) * tickets_per_customer) + ticket_index
                rows.append((
                    f"{REVISION}-ticket-reservation-{global_index:06d}",
                    user_id,
                    f"{REVISION}-concert-0001",
                    f"{REVISION}-ticket-seat-{global_index:06d}",
                    "ISSUED",
                    f"https://tickets.local/{REVISION}/{global_index}.png",
                    f"https://tickets.local/{REVISION}/{global_index}.pdf",
                    now,
                ))
        execute_values(cursor, "insert into tickets (reservation_id, user_id, concert_id, seat_id, status, qr_url, pdf_url, issued_at) values %s on conflict (reservation_id) do update set status = excluded.status, issued_at = excluded.issued_at", rows, page_size=1000)
        counts["ticket.tickets"] = expect_count("ticket.tickets", row_count(cursor, "select count(*) from tickets where reservation_id like %s", (f"{REVISION}-ticket-reservation-%",)), len(rows))


def seed_notification(counts: dict):
    per_customer = int(os.getenv("LOADTEST_CAPACITY_BASELINE_NOTIFICATIONS_PER_CUSTOMER", "20"))
    client = MongoClient(os.getenv("LOADTEST_CAPACITY_BASELINE_MONGODB_URL", os.getenv("MONGODB_URL", "mongodb://notification-db:27017")))
    db = client[os.getenv("LOADTEST_CAPACITY_BASELINE_MONGODB_DB_NAME", os.getenv("MONGODB_DB_NAME", "notification_db"))]
    db.notifications.delete_many({"source_id": {"$regex": f"^{REVISION}-notification-source-"}})
    operations = []
    now = datetime.now(timezone.utc)
    for customer_index in range(1, CUSTOMER_COUNT + 1):
        user_id = str(CUSTOMER_ID_BASE + customer_index)
        for notification_index in range(1, per_customer + 1):
            source_id = f"{REVISION}-notification-source-{customer_index:06d}-{notification_index:04d}"
            operations.append(ReplaceOne(
                {"source_id": source_id},
                {
                    "user_id": user_id,
                    "type": "capacity-baseline",
                    "message": f"Capacity baseline notification {notification_index}",
                    "status": "CREATED",
                    "source_id": source_id,
                    "metadata": {"dataset_revision": REVISION},
                    "created_at": now,
                },
                upsert=True,
            ))
    if operations:
        db.notifications.bulk_write(operations, ordered=False)
    count = db.notifications.count_documents({"source_id": {"$regex": f"^{REVISION}-notification-source-"}})
    counts["notification.notifications"] = expect_count("notification.notifications", count, len(operations))
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
