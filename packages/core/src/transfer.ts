/**
 * Transfer feasibility model.
 *
 * Separates a *theoretically valid* connection (slack >= hard minimum) from a *practically
 * sensible* one. The classification is rule-based and explainable; it never produces a
 * probability, because we have no empirical delay distribution for most operators. When
 * historical delay statistics exist for the inbound service they tighten the rules.
 */

export const TransferQuality = {
  Comfortable: 0,
  Reasonable: 1,
  Risky: 2,
} as const;
export type TransferQualityValue = (typeof TransferQuality)[keyof typeof TransferQuality];
export type TransferQualityName = 'comfortable' | 'reasonable' | 'risky';

export const QUALITY_NAMES: readonly TransferQualityName[] = ['comfortable', 'reasonable', 'risky'];

export type RiskPreference = 'cautious' | 'balanced' | 'adventurous';

export interface TransferPolicy {
  /** Hard minimum the user accepts for any transfer (seconds). */
  minTransferSeconds: number;
  /** Maximum waiting time between arrival (after walking) and the next departure. */
  maxWaitSeconds: number;
  riskPreference: RiskPreference;
}

export interface DelayStatistics {
  /** Median arrival delay of the inbound service at this stop, seconds. */
  p50Seconds: number;
  /** 90th percentile arrival delay, seconds. */
  p90Seconds: number;
  samples: number;
}

export interface TransferContext {
  /** Slack: next departure minus (arrival + walking), seconds. */
  slackSeconds: number;
  /** Walking between two distinct stops was required. */
  walked: boolean;
  walkSeconds: number;
  /** The inbound vehicle crosses a national border (more delay uncertainty). */
  inboundInternational: boolean;
  /** Part of the transfer (arrival..departure) lies in local night hours 00:00–05:00. */
  atNight: boolean;
  /** Station-specific minimum transfer time (from feed transfers.txt or defaults). */
  stationMinTransferSeconds: number;
  delayStats?: DelayStatistics | undefined;
}

/** Baseline thresholds for long-distance coach connections (balanced preference). */
export const BASE_THRESHOLDS = {
  comfortableSeconds: 45 * 60,
  reasonableSeconds: 20 * 60,
  internationalExtraSeconds: 15 * 60,
  walkExtraSeconds: 10 * 60,
  nightWalkExtraSeconds: 10 * 60,
} as const;

const PREFERENCE_FACTOR: Record<RiskPreference, number> = {
  cautious: 1.5,
  balanced: 1,
  adventurous: 0.67,
};

export interface Thresholds {
  hardMinSeconds: number;
  reasonableSeconds: number;
  comfortableSeconds: number;
}

export function transferThresholds(
  policy: TransferPolicy,
  ctx: Omit<TransferContext, 'slackSeconds'>,
): Thresholds {
  const factor = PREFERENCE_FACTOR[policy.riskPreference];
  let extra = 0;
  if (ctx.inboundInternational) extra += BASE_THRESHOLDS.internationalExtraSeconds;
  if (ctx.walked) extra += BASE_THRESHOLDS.walkExtraSeconds;
  if (ctx.walked && ctx.atNight) extra += BASE_THRESHOLDS.nightWalkExtraSeconds;
  const hardMinSeconds = Math.max(policy.minTransferSeconds, ctx.stationMinTransferSeconds);
  let reasonable = Math.round((BASE_THRESHOLDS.reasonableSeconds + extra) * factor);
  let comfortable = Math.round((BASE_THRESHOLDS.comfortableSeconds + extra) * factor);
  if (ctx.delayStats && ctx.delayStats.samples >= 20) {
    // Empirical tightening: a connection shorter than the median inbound delay is risky,
    // and only one covering the 90th percentile plus a buffer is comfortable.
    reasonable = Math.max(reasonable, ctx.delayStats.p50Seconds + 10 * 60);
    comfortable = Math.max(comfortable, ctx.delayStats.p90Seconds + 10 * 60);
  }
  reasonable = Math.max(reasonable, hardMinSeconds);
  comfortable = Math.max(comfortable, reasonable);
  return { hardMinSeconds, reasonableSeconds: reasonable, comfortableSeconds: comfortable };
}

/** Returns the quality class, or -1 when the connection is not feasible at all. */
export function classifyTransfer(policy: TransferPolicy, ctx: TransferContext): TransferQualityValue | -1 {
  if (ctx.slackSeconds > policy.maxWaitSeconds) return -1;
  const t = transferThresholds(policy, ctx);
  if (ctx.slackSeconds < t.hardMinSeconds) return -1;
  if (ctx.slackSeconds >= t.comfortableSeconds) return TransferQuality.Comfortable;
  if (ctx.slackSeconds >= t.reasonableSeconds) return TransferQuality.Reasonable;
  return TransferQuality.Risky;
}

/** Human-readable reasons behind a classification (for the UI). */
export function explainTransfer(policy: TransferPolicy, ctx: TransferContext): string[] {
  const t = transferThresholds(policy, ctx);
  const reasons: string[] = [];
  const mins = (s: number) => `${Math.round(s / 60)} min`;
  reasons.push(
    `${mins(ctx.slackSeconds)} buffer after ${ctx.walked ? 'walking' : 'arrival'}; comfortable from ${mins(
      t.comfortableSeconds,
    )}, reasonable from ${mins(t.reasonableSeconds)}, minimum ${mins(t.hardMinSeconds)}`,
  );
  if (ctx.walked) reasons.push(`Requires a ${mins(ctx.walkSeconds)} walk to a different stop`);
  if (ctx.inboundInternational)
    reasons.push('Arriving service crosses a border; border checks and traffic add uncertainty');
  if (ctx.walked && ctx.atNight) reasons.push('Walking transfer during night hours');
  else if (ctx.atNight) reasons.push('Transfer takes place at night');
  if (ctx.delayStats && ctx.delayStats.samples >= 20)
    reasons.push(
      `Historical delay of arriving service: median ${mins(ctx.delayStats.p50Seconds)}, 90th percentile ${mins(
        ctx.delayStats.p90Seconds,
      )} (${ctx.delayStats.samples} observations)`,
    );
  else reasons.push('No historical delay statistics available for the arriving service');
  return reasons;
}
