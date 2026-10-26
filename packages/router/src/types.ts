import type { RiskPreference } from '@openbus/core';

export type TransportMode = 'bus' | 'rail' | 'other';

/** A physical stop / station after entity resolution. */
export interface RouterStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  timezone: string;
  countryCode: string | null;
  cityId: string | null;
  /** Station-specific minimum transfer time (same stop), seconds. */
  minTransferSeconds: number;
}

/** Fare for riding a trip between two stop positions (inclusive indices of `stops`). */
export interface SegmentFare {
  fromIndex: number;
  toIndex: number;
  amount: number;
  currency: string;
  kind: 'indicative' | 'live';
}

/**
 * One dated vehicle journey: a trip on a concrete service date with absolute times.
 * Times are Unix epoch seconds, so time zones, midnight crossings and DST are already
 * resolved by the loader (see @openbus/core serviceDayReference).
 */
export interface RouterTrip {
  /** Unique key of the dated instance, e.g. "<tripId>@<serviceDate>". */
  id: string;
  tripId: string;
  serviceDate: string;
  operatorId: string;
  routeId: string;
  mode: TransportMode;
  sourceId: string;
  synthetic: boolean;
  stops: string[];
  arrivals: number[];
  departures: number[];
  /** Boarding allowed at position i (GTFS pickup_type != 1). Defaults to true. */
  pickup?: boolean[];
  /** Alighting allowed at position i (GTFS drop_off_type != 1). Defaults to true. */
  dropoff?: boolean[];
  fares?: SegmentFare[];
}

export interface RouterFootpath {
  from: string;
  to: string;
  durationSeconds: number;
  distanceMeters: number;
  method: 'estimated' | 'pedestrian_router' | 'feed';
}

export interface TimetableInput {
  stops: RouterStop[];
  trips: RouterTrip[];
  footpaths: RouterFootpath[];
  /**
   * Conversion factors to a common currency (EUR) used *only* to compare prices during
   * the search. Currencies without a factor are treated as "price unknown" for dominance.
   */
  fxToEur?: Record<string, number>;
  /** Higher priority wins when equivalent trips appear in several sources. */
  sourcePriority?: Record<string, number>;
}

export interface RouterRequest {
  originStopIds: string[];
  destinationStopIds: string[];
  mode: 'depart' | 'arrive';
  /** Departure window (depart mode) or arrival window (arrive mode), epoch seconds. */
  windowStart: number;
  windowEnd: number;
  /** Hard lower bound on departure (arrive mode). Defaults to windowStart - maxDuration. */
  earliestDeparture?: number;
  /** Hard upper bound on arrival (depart mode). Defaults to windowEnd + maxDuration. */
  latestArrival?: number;
  maxTransfers: number;
  minTransferSeconds: number;
  maxTransferWaitSeconds: number;
  maxDurationSeconds: number;
  maxWalkMeters: number;
  riskPreference: RiskPreference;
  excludeRiskyTransfers?: boolean;
  modes?: TransportMode[];
  includeOperators?: string[];
  excludeOperators?: string[];
  /** Upper bound on known total price, in EUR. Journeys with unknown price are kept. */
  maxBudgetEur?: number;
  /** Search additional corridors by excluding transfer cities already used. */
  alternatives?: boolean;
  maxAlternativeRounds?: number;
  /** Stations at which transferring is not allowed. */
  bannedTransferStopIds?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JourneyLeg {
  tripIndex: number;
  trip: RouterTrip;
  /** Positions in trip.stops (real direction). */
  boardIndex: number;
  alightIndex: number;
  departure: number;
  arrival: number;
  price: { amount: number; currency: string; kind: 'indicative' | 'live' } | null;
}

export interface JourneyWalk {
  fromStopId: string;
  toStopId: string;
  durationSeconds: number;
  distanceMeters: number;
  method: RouterFootpath['method'];
}

export interface JourneyConnection {
  atStopId: string;
  toStopId: string;
  arrival: number;
  departure: number;
  walk: JourneyWalk | null;
  slackSeconds: number;
  quality: 0 | 1 | 2;
  reasons: string[];
  nightSeconds: number;
}

export interface Journey {
  legs: JourneyLeg[];
  connections: JourneyConnection[];
  access: JourneyWalk | null;
  egress: JourneyWalk | null;
  departure: number;
  arrival: number;
  transfers: number;
  walkMeters: number;
  worstQuality: 0 | 1 | 2 | null;
  /** Comparable price in EUR, NaN when any leg price is unknown or not convertible. */
  priceEur: number;
  overnightWaitSeconds: number;
  paretoOptimal: boolean;
  /** City ids (or stop ids) that were excluded when this alternative was found. */
  alternativeTo: string[];
  signature: string;
}

export interface SearchStats {
  rounds: number;
  labelsCreated: number;
  searchesRun: number;
  truncated: boolean;
  durationMs: number;
}

export interface RouterResult {
  journeys: Journey[];
  stats: SearchStats;
}
