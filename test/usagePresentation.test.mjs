import assert from 'node:assert/strict';
import test from 'node:test';

import { usageSnapshotFromInfo } from '../out/usagePresentation.js';

test('prefers the enterprise resource package over an empty personal quota', () => {
  const snapshot = usageSnapshotFromInfo({
    userType: 'enterprise',
    userQuota: { total: 0, remaining: 0, unit: 'credits' },
    orgResourcePackage: { cap: 10_000, remaining: 5_085, unit: 'credits' },
  });

  assert.equal(snapshot.source, 'organization');
  assert.deepEqual(snapshot.primary, {
    used: 4_915,
    total: 10_000,
    remaining: 5_085,
    percentage: 49.15,
    unit: 'credits',
  });
});

test('keeps a meaningful personal quota as the primary usage bucket', () => {
  const snapshot = usageSnapshotFromInfo({
    userType: 'plus',
    userQuota: { total: 100, used: 25, remaining: 75, unit: 'credits' },
    orgResourcePackage: { cap: 1_000, used: 100, remaining: 900 },
  });

  assert.equal(snapshot.source, 'personal');
  assert.equal(snapshot.primary?.percentage, 25);
  assert.equal(snapshot.organization?.total, 1_000);
});

test('preserves the account or plan expiry timestamp', () => {
  const expiresAt = Date.UTC(2026, 11, 31);
  const snapshot = usageSnapshotFromInfo({
    userType: 'enterprise',
    expiresAt,
    orgResourcePackage: { cap: 10_000, remaining: 5_085 },
  });

  assert.equal(snapshot.expiresAt, expiresAt);
});

test('normalizes second-based expiry timestamps', () => {
  const expiresAtSeconds = Math.floor(Date.UTC(2026, 11, 31) / 1_000);
  const snapshot = usageSnapshotFromInfo({
    userType: 'enterprise',
    expiresAt: expiresAtSeconds,
  });

  assert.equal(snapshot.expiresAt, expiresAtSeconds * 1_000);
});
