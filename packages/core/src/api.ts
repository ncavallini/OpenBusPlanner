/**
 * Versioned public API schema (v1), shared by the API server (validation + OpenAPI) and the
 * web client (types). Changing a response field is a breaking change: bump API_VERSION.
 */
import { z } from 'zod';

export const API_VERSION = 'v1' as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

export const PlaceKind = z.enum(['city', 'station']);

export const Place = z.object({
  id: z.string().describe('Place id: "city:<id>" or "station:<id>"'),
  kind: PlaceKind,
  name: z.string(),
  cityName: z.string().nullable(),
  countryCode: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  timezone: z.string(),
  stationCount: z.number().int().describe('Stations with timetable data grouped under this place'),
  matchedAlias: z.string().nullable(),
});
export type Place = z.infer<typeof Place>;

export const PlaceSearchResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  places: z.array(Place),
});
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponse>;

export const SortKey = z.enum([
  'recommended',
  'arrival',
  'departure',
  'duration',
  'transfers',
  'price',
  'reliability',
  'walking',
]);
export type SortKey = z.infer<typeof SortKey>;

export const DataScope = z.enum(['all', 'real', 'synthetic']);
export type DataScope = z.infer<typeof DataScope>;

export const JourneySearchRequest = z.object({
  origin: z.string().min(1).describe('Place id from /places/search'),
  destination: z.string().min(1),
  mode: z.enum(['depart', 'arrive']).default('depart'),
  date: isoDate.describe('Local date at the origin (depart) or destination (arrive)'),
  timeWindow: z
    .object({ from: hhmm, to: hhmm })
    .default({ from: '00:00', to: '23:59' })
    .describe('Window for departure (depart mode) or arrival (arrive mode). "to" earlier than "from" wraps past midnight.'),
  departureNotBefore: z
    .object({ date: isoDate, time: hhmm })
    .optional()
    .describe('Arrive mode: earliest acceptable departure, local time at origin'),
  arrivalNotAfter: z
    .object({ date: isoDate, time: hhmm })
    .optional()
    .describe('Depart mode: latest acceptable arrival, local time at destination'),
  maxTransfers: z.number().int().min(0).max(6).default(3),
  minTransferMinutes: z.number().int().min(0).max(240).default(10),
  maxTransferWaitMinutes: z.number().int().min(5).max(24 * 60).default(8 * 60),
  maxDurationHours: z.number().min(1).max(72).default(30),
  maxWalkMeters: z.number().int().min(0).max(5000).default(1500),
  transportModes: z.array(z.enum(['bus', 'rail'])).min(1).default(['bus']),
  includeOperators: z.array(z.string()).optional(),
  excludeOperators: z.array(z.string()).optional(),
  riskPreference: z.enum(['cautious', 'balanced', 'adventurous']).default('balanced'),
  excludeRiskyTransfers: z.boolean().default(false),
  maxBudget: z.object({ amount: z.number().positive(), currency: z.string().length(3) }).optional(),
  sort: SortKey.default('recommended'),
  alternatives: z.boolean().default(true).describe('Also search corridors via other transfer cities'),
  dataScope: DataScope.optional().describe('Defaults to the server configuration'),
  limit: z.number().int().min(1).max(100).default(40),
});
export type JourneySearchRequest = z.input<typeof JourneySearchRequest>;
export type JourneySearchQuery = z.output<typeof JourneySearchRequest>;

export const TimePoint = z.object({
  epoch: z.number().int().describe('Unix seconds'),
  local: z.string().describe('ISO-8601 local time with offset'),
  timezone: z.string().describe('IANA time zone of the stop'),
});
export type TimePoint = z.infer<typeof TimePoint>;

export const StopRef = z.object({
  stationId: z.string(),
  name: z.string(),
  cityId: z.string().nullable(),
  cityName: z.string().nullable(),
  countryCode: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  timezone: z.string(),
});
export type StopRef = z.infer<typeof StopRef>;

export const Freshness = z.enum(['fresh', 'aging', 'stale', 'unknown']);

export const Provenance = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  synthetic: z.boolean().describe('True for generated test fixtures — never real departures'),
  license: z.string().nullable(),
  attribution: z.string().nullable(),
  importedAt: z.string().nullable(),
  feedVersion: z.string().nullable(),
  freshness: Freshness,
  realtimeApplied: z.boolean(),
  alsoFoundIn: z.array(z.string()).describe('Other sources containing an equivalent trip (deduplicated)'),
});
export type Provenance = z.infer<typeof Provenance>;

export const LegPrice = z.object({
  status: z.enum(['known', 'unknown']),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  kind: z.enum(['indicative', 'live']).nullable(),
  observedAt: z.string().nullable(),
  source: z.string().nullable(),
});
export type LegPrice = z.infer<typeof LegPrice>;

export const BookingLink = z.object({
  kind: z.enum(['departure_specific', 'route_search', 'operator_homepage', 'none']),
  url: z.string().nullable(),
  label: z.string(),
});
export type BookingLink = z.infer<typeof BookingLink>;

export const Operator = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  countryCode: z.string().nullable(),
  synthetic: z.boolean(),
  sources: z.array(z.string()),
});
export type Operator = z.infer<typeof Operator>;

export const IntermediateStop = z.object({
  stationId: z.string(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  arrival: TimePoint.nullable(),
  departure: TimePoint.nullable(),
});

export const VehicleLeg = z.object({
  type: z.literal('vehicle'),
  tripId: z.string(),
  serviceDate: isoDate,
  mode: z.enum(['bus', 'rail', 'other']),
  operator: Operator.pick({ id: true, name: true, website: true, synthetic: true }),
  routeName: z.string().nullable(),
  headsign: z.string().nullable(),
  from: StopRef,
  to: StopRef,
  departure: TimePoint,
  arrival: TimePoint,
  durationSeconds: z.number().int(),
  intermediateStops: z.array(IntermediateStop),
  crossesBorder: z.boolean(),
  price: LegPrice,
  availability: z.enum(['not_verified']).describe('Seat availability is never verified in v1'),
  booking: BookingLink,
  provenance: Provenance,
});
export type VehicleLeg = z.infer<typeof VehicleLeg>;

export const TransferQualityName = z.enum(['comfortable', 'reasonable', 'risky']);

export const Connection = z.object({
  fromStop: StopRef,
  toStop: StopRef,
  arrival: TimePoint,
  departure: TimePoint,
  walk: z
    .object({
      meters: z.number().int(),
      seconds: z.number().int(),
      method: z.enum(['estimated', 'pedestrian_router', 'feed']),
    })
    .nullable(),
  waitSeconds: z.number().int().describe('Departure minus arrival, including walking'),
  slackSeconds: z.number().int().describe('Buffer left after walking'),
  quality: TransferQualityName,
  reasons: z.array(z.string()),
  separateTickets: z.boolean(),
  nightSeconds: z.number().int().describe('Part of the wait between 00:00 and 05:00 local'),
});
export type Connection = z.infer<typeof Connection>;

export const Warning = z.object({
  code: z.enum([
    'separate_tickets',
    'risky_connection',
    'night_transfer',
    'walking_transfer',
    'synthetic_data',
    'stale_data',
    'price_unknown',
    'availability_not_verified',
    'generic_booking_link',
    'cross_border',
    'overnight_wait',
  ]),
  message: z.string(),
});
export type Warning = z.infer<typeof Warning>;

export const PriceSummary = z.object({
  status: z.enum(['complete', 'partial', 'unknown']),
  totals: z.array(z.object({ amount: z.number(), currency: z.string() })).describe('Only when status is complete'),
  kind: z.enum(['indicative', 'live', 'mixed']).nullable(),
  knownLegs: z.number().int(),
  totalLegs: z.number().int(),
});

export const Itinerary = z.object({
  id: z.string(),
  departure: TimePoint,
  arrival: TimePoint,
  durationSeconds: z.number().int(),
  arrivalDayOffset: z.number().int().describe('Calendar days between departure and arrival local dates'),
  transfers: z.number().int(),
  legs: z.array(VehicleLeg),
  connections: z.array(Connection),
  operators: z.array(Operator.pick({ id: true, name: true })),
  separateTickets: z.boolean(),
  worstConnection: TransferQualityName.nullable(),
  walkingMeters: z.number().int(),
  overnightWaitSeconds: z.number().int(),
  price: PriceSummary,
  warnings: z.array(Warning),
  paretoOptimal: z.boolean().describe('False for alternatives found through other transfer cities'),
  alternativeTo: z.array(z.string()).describe('Transfer cities excluded when this alternative was found'),
  synthetic: z.boolean(),
  score: z.number().describe('Recommended-sort score, lower is better'),
});
export type Itinerary = z.infer<typeof Itinerary>;

export const SourceCoverage = z.object({
  id: z.string(),
  name: z.string(),
  synthetic: z.boolean(),
  status: z.enum(['used', 'no_service_in_window', 'unavailable', 'stale', 'excluded_by_scope']),
  reason: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  importedAt: z.string().nullable(),
  freshness: Freshness,
  tripsInWindow: z.number().int(),
});
export type SourceCoverage = z.infer<typeof SourceCoverage>;

export const SearchOutcome = z.enum([
  'results',
  'no_journey_in_available_data',
  'no_timetable_data_for_dates',
  'sources_unavailable',
  'place_not_served',
]);
export type SearchOutcome = z.infer<typeof SearchOutcome>;

export const Coverage = z.object({
  sourcesConsulted: z.number().int(),
  sourcesWithServiceInWindow: z.number().int(),
  sources: z.array(SourceCoverage),
  operatorsRepresented: z.array(z.string()),
  dateCoverage: z.object({ from: isoDate, to: isoDate, fullyCovered: z.boolean() }),
  livePricesQueried: z.boolean(),
  availabilityVerified: z.boolean(),
  syntheticDataIncluded: z.boolean(),
  message: z.string().describe('Generated from execution metadata'),
});
export type Coverage = z.infer<typeof Coverage>;

export const JourneySearchResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  searchId: z.string(),
  outcome: SearchOutcome,
  outcomeMessage: z.string(),
  query: z.object({
    origin: Place,
    destination: Place,
    mode: z.enum(['depart', 'arrive']),
    windowStart: TimePoint,
    windowEnd: TimePoint,
    earliestDeparture: TimePoint,
    latestArrival: TimePoint,
  }),
  itineraries: z.array(Itinerary),
  coverage: Coverage,
  diagnostics: z.object({
    durationMs: z.number(),
    timetableBuildMs: z.number(),
    routingMs: z.number(),
    rounds: z.number().int(),
    labelsCreated: z.number().int(),
    searchesRun: z.number().int(),
    truncated: z.boolean(),
    cached: z.boolean(),
  }),
});
export type JourneySearchResponse = z.infer<typeof JourneySearchResponse>;

export const OperatorsResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  operators: z.array(Operator),
});

export const DataSourceStatus = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  synthetic: z.boolean(),
  adapterStatus: z.enum(['implemented', 'fixture_only', 'not_implemented']),
  liveStatus: z.enum(['verified_working', 'failing', 'never_run', 'not_applicable']),
  enabled: z.boolean(),
  license: z.string().nullable(),
  lastImport: z
    .object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      status: z.enum(['running', 'success', 'skipped_unchanged', 'failed']),
      message: z.string().nullable(),
      stats: z.record(z.string(), z.number()).nullable(),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
    })
    .nullable(),
  health: z
    .object({ checkedAt: z.string(), ok: z.boolean(), latencyMs: z.number().nullable(), message: z.string().nullable() })
    .nullable(),
  freshness: Freshness,
  counts: z.object({ stations: z.number().int(), trips: z.number().int(), operators: z.number().int() }),
});
export type DataSourceStatus = z.infer<typeof DataSourceStatus>;

export const DataSourcesResponse = z.object({
  apiVersion: z.literal(API_VERSION),
  sources: z.array(DataSourceStatus),
});

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
