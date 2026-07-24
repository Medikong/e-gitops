import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseUrlForNamespace } from '../scripts/prepare-local-inputs.js';

test('Dataset Job input changes a short database Service host to the owning namespace FQDN', () => {
  assert.equal(
    databaseUrlForNamespace('postgres://auth-db:5432/auth_db?sslmode=disable', 'dropmong-auth'),
    'postgres://auth-db.dropmong-auth.svc.cluster.local:5432/auth_db?sslmode=disable',
  );
});

test('Dataset Job input preserves already-qualified and local database hosts', () => {
  assert.equal(
    databaseUrlForNamespace('postgres://catalog-db.dropmong-catalog.svc.cluster.local:5432/catalog_db', 'dropmong-catalog'),
    'postgres://catalog-db.dropmong-catalog.svc.cluster.local:5432/catalog_db',
  );
  assert.equal(
    databaseUrlForNamespace('postgres://localhost:5432/catalog_db', 'dropmong-catalog'),
    'postgres://localhost:5432/catalog_db',
  );
});
