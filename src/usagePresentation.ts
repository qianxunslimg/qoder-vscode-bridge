import type { UsageInfo } from '@qoder-ai/qoder-agent-sdk';

export interface UsageBucketSnapshot {
  readonly used?: number;
  readonly total?: number;
  readonly remaining?: number;
  readonly percentage?: number;
  readonly unit: string;
}

export interface UsageSnapshot {
  readonly plan: string;
  readonly source: 'organization' | 'personal' | 'none';
  /** Account/plan expiry returned by Qoder; the resource package has no separate expiry field. */
  readonly expiresAt?: number;
  readonly primary?: UsageBucketSnapshot;
  readonly personal?: UsageBucketSnapshot;
  readonly organization?: UsageBucketSnapshot;
  readonly sessionCredits?: number;
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function timestampMillis(value: number | undefined): number | undefined {
  const timestamp = finite(value);
  if (timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Accept both Unix seconds and milliseconds because the SDK type is numeric
  // and older account endpoints have used both representations.
  return timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
}

function percentage(
  value: number | undefined,
  used: number | undefined,
  total: number | undefined,
): number | undefined {
  const explicit = finite(value);
  if (explicit !== undefined) {
    // Some Qoder endpoints use 0..1 while the account endpoint uses 0..100.
    return Math.max(0, Math.min(100, explicit <= 1 ? explicit * 100 : explicit));
  }
  if (used !== undefined && total !== undefined && total > 0) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  return undefined;
}

function bucket(
  value:
    | {
        readonly used?: number;
        readonly total?: number;
        readonly remaining?: number;
        readonly percentage?: number;
        readonly unit?: string;
      }
    | undefined,
  totalOverride?: number,
): UsageBucketSnapshot | undefined {
  if (!value) {
    return undefined;
  }
  const total = finite(totalOverride ?? value.total);
  const remaining = finite(value.remaining);
  const used = finite(
    value.used ??
      (total !== undefined && remaining !== undefined
        ? total - remaining
        : undefined),
  );
  return {
    used,
    total,
    remaining,
    percentage: percentage(value.percentage, used, total),
    unit: value.unit?.trim() || 'credits',
  };
}

export function usageSnapshotFromInfo(info: UsageInfo): UsageSnapshot {
  const personal = bucket(info.userQuota);
  const organization = bucket(info.orgResourcePackage, info.orgResourcePackage?.cap);
  const enterprise = info.userType?.toLowerCase().includes('enterprise') === true;
  const hasOrganizationTotal = (organization?.total ?? 0) > 0;
  const hasPersonalTotal = (personal?.total ?? 0) > 0;
  const useOrganization = Boolean(
    organization && (enterprise || (hasOrganizationTotal && !hasPersonalTotal)),
  );
  const primary = useOrganization ? organization : personal ?? organization;

  return {
    plan: info.userType ?? 'unknown',
    source: primary === organization && organization
      ? 'organization'
      : primary === personal && personal
        ? 'personal'
        : 'none',
    expiresAt: timestampMillis(info.expiresAt),
    primary,
    personal,
    organization,
    sessionCredits: finite(info.session?.total_credits),
  };
}
