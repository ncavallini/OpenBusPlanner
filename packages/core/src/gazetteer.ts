/**
 * Seed gazetteer of European cities used to group stations into cities and to resolve
 * multilingual aliases (Bozen/Bolzano, Mailand/Milano/Milan). Coordinates are approximate
 * city centres; they are only used to assign stations to a city within a size-dependent
 * radius, never to place a stop. Stations themselves always come from timetable data.
 */
import { haversineMeters } from './geo';
import { nameSimilarity, normalizeName } from './normalize';

export interface Country {
  code: string;
  name: string;
  timezone: string;
}

export const COUNTRIES: Country[] = [
  { code: 'AT', name: 'Austria', timezone: 'Europe/Vienna' },
  { code: 'BE', name: 'Belgium', timezone: 'Europe/Brussels' },
  { code: 'BG', name: 'Bulgaria', timezone: 'Europe/Sofia' },
  { code: 'CH', name: 'Switzerland', timezone: 'Europe/Zurich' },
  { code: 'CZ', name: 'Czechia', timezone: 'Europe/Prague' },
  { code: 'DE', name: 'Germany', timezone: 'Europe/Berlin' },
  { code: 'DK', name: 'Denmark', timezone: 'Europe/Copenhagen' },
  { code: 'ES', name: 'Spain', timezone: 'Europe/Madrid' },
  { code: 'FR', name: 'France', timezone: 'Europe/Paris' },
  { code: 'GB', name: 'United Kingdom', timezone: 'Europe/London' },
  { code: 'HR', name: 'Croatia', timezone: 'Europe/Zagreb' },
  { code: 'HU', name: 'Hungary', timezone: 'Europe/Budapest' },
  { code: 'IT', name: 'Italy', timezone: 'Europe/Rome' },
  { code: 'LI', name: 'Liechtenstein', timezone: 'Europe/Vaduz' },
  { code: 'LU', name: 'Luxembourg', timezone: 'Europe/Luxembourg' },
  { code: 'NL', name: 'Netherlands', timezone: 'Europe/Amsterdam' },
  { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw' },
  { code: 'PT', name: 'Portugal', timezone: 'Europe/Lisbon' },
  { code: 'RO', name: 'Romania', timezone: 'Europe/Bucharest' },
  { code: 'RS', name: 'Serbia', timezone: 'Europe/Belgrade' },
  { code: 'SI', name: 'Slovenia', timezone: 'Europe/Ljubljana' },
  { code: 'SK', name: 'Slovakia', timezone: 'Europe/Bratislava' },
];

export type CitySize = 'major' | 'large' | 'medium' | 'small';

export interface GazetteerCity {
  id: string;
  name: string;
  countryCode: string;
  lat: number;
  lon: number;
  size: CitySize;
  aliases: string[];
  timezone: string;
}

/** Radius within which a station is considered part of the city. */
export const CITY_RADIUS_METERS: Record<CitySize, number> = {
  major: 22_000,
  large: 14_000,
  medium: 9_000,
  small: 6_000,
};

type Row = [id: string, name: string, cc: string, lat: number, lon: number, size: CitySize, aliases?: string[]];

// prettier-ignore
const ROWS: Row[] = [
  // Switzerland
  ['ch-zurich', 'Zürich', 'CH', 47.3769, 8.5417, 'major', ['Zurich', 'Zuerich', 'Zurigo', 'Zurich HB']],
  ['ch-geneva', 'Geneva', 'CH', 46.2044, 6.1432, 'large', ['Genève', 'Genf', 'Ginevra', 'Geneve']],
  ['ch-basel', 'Basel', 'CH', 47.5596, 7.5886, 'large', ['Bâle', 'Basilea', 'Bale']],
  ['ch-bern', 'Bern', 'CH', 46.948, 7.4474, 'large', ['Berne', 'Berna']],
  ['ch-lausanne', 'Lausanne', 'CH', 46.5197, 6.6323, 'medium', ['Losanna']],
  ['ch-lugano', 'Lugano', 'CH', 46.0037, 8.9511, 'medium'],
  ['ch-lucerne', 'Lucerne', 'CH', 47.0502, 8.3093, 'medium', ['Luzern', 'Lucerna']],
  ['ch-st-gallen', 'St. Gallen', 'CH', 47.4245, 9.3767, 'medium', ['Sankt Gallen', 'Saint-Gall', 'San Gallo']],
  ['ch-chur', 'Chur', 'CH', 46.8508, 9.532, 'small', ['Coira', 'Coire']],
  ['ch-winterthur', 'Winterthur', 'CH', 47.4988, 8.7237, 'medium'],
  ['ch-bellinzona', 'Bellinzona', 'CH', 46.1946, 9.0175, 'small', ['Bellenz']],
  ['ch-chiasso', 'Chiasso', 'CH', 45.8323, 9.0313, 'small'],
  ['ch-st-moritz', 'St. Moritz', 'CH', 46.4908, 9.8355, 'small', ['Sankt Moritz', 'San Murezzan', 'San Maurizio']],
  ['ch-buchs-sg', 'Buchs SG', 'CH', 47.1663, 9.4789, 'small', ['Buchs']],
  // Liechtenstein
  ['li-vaduz', 'Vaduz', 'LI', 47.141, 9.5209, 'small'],
  // Italy
  ['it-milan', 'Milan', 'IT', 45.4642, 9.19, 'major', ['Milano', 'Mailand', 'Milán', 'Milão']],
  ['it-bolzano', 'Bolzano', 'IT', 46.4983, 11.3548, 'medium', ['Bozen', 'Bolzano/Bozen', 'Bulsan', 'Bolzano-Bozen']],
  ['it-trento', 'Trento', 'IT', 46.0748, 11.1217, 'medium', ['Trient', 'Trente']],
  ['it-verona', 'Verona', 'IT', 45.4384, 10.9916, 'large', ['Vérone']],
  ['it-venice', 'Venice', 'IT', 45.4408, 12.3155, 'large', ['Venezia', 'Venedig', 'Venise', 'Venezia Mestre', 'Mestre']],
  ['it-bergamo', 'Bergamo', 'IT', 45.6983, 9.6773, 'medium'],
  ['it-brescia', 'Brescia', 'IT', 45.5416, 10.2118, 'medium'],
  ['it-como', 'Como', 'IT', 45.8081, 9.0852, 'small'],
  ['it-turin', 'Turin', 'IT', 45.0703, 7.6869, 'major', ['Torino', 'Turín']],
  ['it-genoa', 'Genoa', 'IT', 44.4056, 8.9463, 'large', ['Genova', 'Genua', 'Gênes']],
  ['it-bologna', 'Bologna', 'IT', 44.4949, 11.3426, 'large', ['Bologne']],
  ['it-florence', 'Florence', 'IT', 43.7696, 11.2558, 'large', ['Firenze', 'Florenz']],
  ['it-rome', 'Rome', 'IT', 41.9028, 12.4964, 'major', ['Roma', 'Rom']],
  ['it-naples', 'Naples', 'IT', 40.8518, 14.2681, 'major', ['Napoli', 'Neapel']],
  ['it-padua', 'Padua', 'IT', 45.4064, 11.8768, 'medium', ['Padova']],
  ['it-vicenza', 'Vicenza', 'IT', 45.5455, 11.5354, 'medium'],
  ['it-merano', 'Merano', 'IT', 46.6713, 11.1594, 'small', ['Meran']],
  ['it-bressanone', 'Bressanone', 'IT', 46.715, 11.656, 'small', ['Brixen']],
  ['it-brunico', 'Brunico', 'IT', 46.7966, 11.9383, 'small', ['Bruneck']],
  ['it-domodossola', 'Domodossola', 'IT', 46.1157, 8.2928, 'small'],
  ['it-aosta', 'Aosta', 'IT', 45.737, 7.3201, 'small', ['Aoste']],
  ['it-varese', 'Varese', 'IT', 45.8206, 8.8251, 'small'],
  ['it-novara', 'Novara', 'IT', 45.4469, 8.622, 'small'],
  ['it-udine', 'Udine', 'IT', 46.0711, 13.2346, 'medium'],
  ['it-trieste', 'Trieste', 'IT', 45.6495, 13.7768, 'medium', ['Triest']],
  ['it-parma', 'Parma', 'IT', 44.8015, 10.3279, 'medium'],
  ['it-modena', 'Modena', 'IT', 44.6471, 10.9252, 'medium'],
  ['it-pisa', 'Pisa', 'IT', 43.7228, 10.4017, 'small'],
  ['it-bari', 'Bari', 'IT', 41.1171, 16.8719, 'large'],
  ['it-ancona', 'Ancona', 'IT', 43.6158, 13.5189, 'medium'],
  ['it-rimini', 'Rimini', 'IT', 44.0678, 12.5695, 'medium'],
  ['it-sondrio', 'Sondrio', 'IT', 46.1699, 9.8715, 'small'],
  // Austria
  ['at-vienna', 'Vienna', 'AT', 48.2082, 16.3738, 'major', ['Wien', 'Vienne', 'Viena', 'Wiedeń']],
  ['at-innsbruck', 'Innsbruck', 'AT', 47.2692, 11.4041, 'medium'],
  ['at-salzburg', 'Salzburg', 'AT', 47.8095, 13.055, 'medium', ['Salisburgo', 'Salzbourg']],
  ['at-graz', 'Graz', 'AT', 47.0707, 15.4395, 'large'],
  ['at-linz', 'Linz', 'AT', 48.3069, 14.2858, 'medium'],
  ['at-klagenfurt', 'Klagenfurt', 'AT', 46.6249, 14.305, 'medium', ['Klagenfurt am Wörthersee', 'Celovec']],
  ['at-villach', 'Villach', 'AT', 46.6103, 13.8558, 'small', ['Beljak']],
  ['at-bregenz', 'Bregenz', 'AT', 47.5031, 9.7471, 'small'],
  ['at-feldkirch', 'Feldkirch', 'AT', 47.238, 9.598, 'small'],
  ['at-landeck', 'Landeck', 'AT', 47.1393, 10.5652, 'small'],
  ['at-lienz', 'Lienz', 'AT', 46.8297, 12.769, 'small'],
  ['at-kufstein', 'Kufstein', 'AT', 47.5833, 12.1667, 'small'],
  ['at-woergl', 'Wörgl', 'AT', 47.4894, 12.0617, 'small', ['Woergl']],
  ['at-bludenz', 'Bludenz', 'AT', 47.1547, 9.8222, 'small'],
  ['at-dornbirn', 'Dornbirn', 'AT', 47.4125, 9.7417, 'small'],
  // Germany
  ['de-munich', 'Munich', 'DE', 48.1351, 11.582, 'major', ['München', 'Muenchen', 'Monaco di Baviera', 'Munique', 'Múnich']],
  ['de-berlin', 'Berlin', 'DE', 52.52, 13.405, 'major', ['Berlino']],
  ['de-frankfurt', 'Frankfurt am Main', 'DE', 50.1109, 8.6821, 'major', ['Frankfurt', 'Francoforte', 'Francfort']],
  ['de-stuttgart', 'Stuttgart', 'DE', 48.7758, 9.1829, 'major', ['Stoccarda']],
  ['de-hamburg', 'Hamburg', 'DE', 53.5511, 9.9937, 'major', ['Amburgo', 'Hambourg']],
  ['de-cologne', 'Cologne', 'DE', 50.9375, 6.9603, 'major', ['Köln', 'Koeln', 'Colonia']],
  ['de-duesseldorf', 'Düsseldorf', 'DE', 51.2277, 6.7735, 'large', ['Duesseldorf', 'Dusseldorf']],
  ['de-nuremberg', 'Nuremberg', 'DE', 49.4521, 11.0767, 'large', ['Nürnberg', 'Nuernberg', 'Norimberga']],
  ['de-augsburg', 'Augsburg', 'DE', 48.3705, 10.8978, 'medium', ['Augusta']],
  ['de-ulm', 'Ulm', 'DE', 48.4011, 9.9876, 'medium'],
  ['de-lindau', 'Lindau', 'DE', 47.546, 9.6838, 'small'],
  ['de-friedrichshafen', 'Friedrichshafen', 'DE', 47.65, 9.48, 'small'],
  ['de-konstanz', 'Konstanz', 'DE', 47.6603, 9.1758, 'small', ['Constance', 'Costanza']],
  ['de-freiburg', 'Freiburg im Breisgau', 'DE', 47.999, 7.8421, 'medium', ['Freiburg', 'Friburgo']],
  ['de-karlsruhe', 'Karlsruhe', 'DE', 49.0069, 8.4037, 'medium'],
  ['de-mannheim', 'Mannheim', 'DE', 49.4875, 8.466, 'medium'],
  ['de-garmisch', 'Garmisch-Partenkirchen', 'DE', 47.4917, 11.0955, 'small', ['Garmisch']],
  ['de-rosenheim', 'Rosenheim', 'DE', 47.8561, 12.1289, 'small'],
  ['de-kempten', 'Kempten', 'DE', 47.7286, 10.3158, 'small', ['Kempten (Allgäu)']],
  ['de-memmingen', 'Memmingen', 'DE', 47.9867, 10.1813, 'small'],
  ['de-dresden', 'Dresden', 'DE', 51.0504, 13.7373, 'large', ['Dresda']],
  ['de-leipzig', 'Leipzig', 'DE', 51.3397, 12.3731, 'large', ['Lipsia']],
  ['de-hanover', 'Hanover', 'DE', 52.3759, 9.732, 'large', ['Hannover']],
  ['de-bremen', 'Bremen', 'DE', 53.0793, 8.8017, 'large', ['Brema']],
  ['de-regensburg', 'Regensburg', 'DE', 49.0134, 12.1016, 'medium', ['Ratisbona']],
  ['de-wuerzburg', 'Würzburg', 'DE', 49.7913, 9.9534, 'medium', ['Wuerzburg']],
  ['de-passau', 'Passau', 'DE', 48.5665, 13.4312, 'small'],
  ['de-singen', 'Singen', 'DE', 47.759, 8.8403, 'small', ['Singen (Hohentwiel)']],
  // France
  ['fr-paris', 'Paris', 'FR', 48.8566, 2.3522, 'major', ['Parigi', 'París']],
  ['fr-lyon', 'Lyon', 'FR', 45.764, 4.8357, 'major', ['Lione', 'Lyons']],
  ['fr-marseille', 'Marseille', 'FR', 43.2965, 5.3698, 'major', ['Marsiglia', 'Marseilles']],
  ['fr-nice', 'Nice', 'FR', 43.7102, 7.262, 'large', ['Nizza']],
  ['fr-strasbourg', 'Strasbourg', 'FR', 48.5734, 7.7521, 'large', ['Strassburg', 'Straßburg', 'Strasburgo']],
  ['fr-mulhouse', 'Mulhouse', 'FR', 47.7508, 7.3359, 'medium', ['Mülhausen']],
  ['fr-grenoble', 'Grenoble', 'FR', 45.1885, 5.7245, 'medium'],
  ['fr-annecy', 'Annecy', 'FR', 45.8992, 6.1294, 'small'],
  ['fr-chambery', 'Chambéry', 'FR', 45.5646, 5.9178, 'small', ['Chambery']],
  ['fr-dijon', 'Dijon', 'FR', 47.322, 5.0415, 'medium'],
  ['fr-toulouse', 'Toulouse', 'FR', 43.6047, 1.4442, 'major', ['Tolosa']],
  ['fr-bordeaux', 'Bordeaux', 'FR', 44.8378, -0.5792, 'large'],
  ['fr-lille', 'Lille', 'FR', 50.6292, 3.0573, 'large'],
  ['fr-montpellier', 'Montpellier', 'FR', 43.6108, 3.8767, 'large'],
  ['fr-nantes', 'Nantes', 'FR', 47.2184, -1.5536, 'large'],
  ['fr-annemasse', 'Annemasse', 'FR', 46.1934, 6.2342, 'small'],
  ['fr-chamonix', 'Chamonix', 'FR', 45.9237, 6.8694, 'small', ['Chamonix-Mont-Blanc']],
  // Central / Eastern Europe
  ['si-ljubljana', 'Ljubljana', 'SI', 46.0569, 14.5058, 'medium', ['Laibach', 'Lubiana']],
  ['hr-zagreb', 'Zagreb', 'HR', 45.815, 15.9819, 'large', ['Zagabria', 'Agram']],
  ['hr-rijeka', 'Rijeka', 'HR', 45.3271, 14.4422, 'medium', ['Fiume']],
  ['hr-split', 'Split', 'HR', 43.5081, 16.4402, 'medium', ['Spalato']],
  ['cz-prague', 'Prague', 'CZ', 50.0755, 14.4378, 'major', ['Praha', 'Prag', 'Praga']],
  ['cz-brno', 'Brno', 'CZ', 49.1951, 16.6068, 'large', ['Brünn']],
  ['cz-plzen', 'Plzeň', 'CZ', 49.7384, 13.3736, 'medium', ['Pilsen', 'Plzen']],
  ['sk-bratislava', 'Bratislava', 'SK', 48.1486, 17.1077, 'large', ['Pressburg', 'Pozsony']],
  ['hu-budapest', 'Budapest', 'HU', 47.4979, 19.0402, 'major', ['Budapeszt']],
  ['pl-warsaw', 'Warsaw', 'PL', 52.2297, 21.0122, 'major', ['Warszawa', 'Warschau', 'Varsavia']],
  ['pl-krakow', 'Kraków', 'PL', 50.0647, 19.945, 'large', ['Krakow', 'Krakau', 'Cracow', 'Cracovia']],
  ['pl-wroclaw', 'Wrocław', 'PL', 51.1079, 17.0385, 'large', ['Wroclaw', 'Breslau']],
  ['rs-belgrade', 'Belgrade', 'RS', 44.7866, 20.4489, 'major', ['Beograd', 'Belgrad', 'Belgrado']],
  ['ro-bucharest', 'Bucharest', 'RO', 44.4268, 26.1025, 'major', ['București', 'Bukarest', 'Bucarest']],
  ['bg-sofia', 'Sofia', 'BG', 42.6977, 23.3219, 'major', ['София', 'Sofija']],
  // Benelux, Iberia, North
  ['nl-amsterdam', 'Amsterdam', 'NL', 52.3676, 4.9041, 'major'],
  ['nl-rotterdam', 'Rotterdam', 'NL', 51.9244, 4.4777, 'major'],
  ['nl-utrecht', 'Utrecht', 'NL', 52.0907, 5.1214, 'large'],
  ['nl-eindhoven', 'Eindhoven', 'NL', 51.4416, 5.4697, 'medium'],
  ['be-brussels', 'Brussels', 'BE', 50.8503, 4.3517, 'major', ['Bruxelles', 'Brussel', 'Brüssel', 'Bruxelas']],
  ['be-antwerp', 'Antwerp', 'BE', 51.2194, 4.4025, 'large', ['Antwerpen', 'Anvers', 'Anversa']],
  ['be-liege', 'Liège', 'BE', 50.6326, 5.5797, 'medium', ['Liege', 'Lüttich', 'Luik']],
  ['lu-luxembourg', 'Luxembourg', 'LU', 49.6116, 6.1319, 'medium', ['Luxemburg', 'Lussemburgo']],
  ['es-madrid', 'Madrid', 'ES', 40.4168, -3.7038, 'major'],
  ['es-barcelona', 'Barcelona', 'ES', 41.3874, 2.1686, 'major', ['Barcellona', 'Barcelone']],
  ['pt-lisbon', 'Lisbon', 'PT', 38.7223, -9.1393, 'major', ['Lisboa', 'Lissabon', 'Lisbona', 'Lisbonne']],
  ['dk-copenhagen', 'Copenhagen', 'DK', 55.6761, 12.5683, 'major', ['København', 'Kopenhagen', 'Copenaghen']],
  ['gb-london', 'London', 'GB', 51.5074, -0.1278, 'major', ['Londres', 'Londra']],
];

const tzByCountry = new Map(COUNTRIES.map((c) => [c.code, c.timezone]));

export const CITIES: GazetteerCity[] = ROWS.map(([id, name, cc, lat, lon, size, aliases]) => ({
  id,
  name,
  countryCode: cc,
  lat,
  lon,
  size,
  aliases: aliases ?? [],
  timezone: tzByCountry.get(cc) ?? 'UTC',
}));

const cityById = new Map(CITIES.map((c) => [c.id, c]));
export function getCity(id: string): GazetteerCity | undefined {
  return cityById.get(id);
}

/**
 * Assigns a coordinate to the closest gazetteer city whose radius contains it.
 * When the stop name mentions a city (e.g. "Bozen Busbahnhof"), that city wins within
 * 1.5× its radius, which disambiguates suburbs between two cities.
 */
export function matchCity(lat: number, lon: number, stopName?: string): GazetteerCity | undefined {
  let best: { city: GazetteerCity; score: number } | undefined;
  const nameKey = stopName ? normalizeName(stopName) : '';
  for (const city of CITIES) {
    const d = haversineMeters({ lat, lon }, city);
    const radius = CITY_RADIUS_METERS[city.size];
    const named =
      nameKey !== '' &&
      [city.name, ...city.aliases].some((n) => {
        const k = normalizeName(n);
        return k.length >= 3 && (nameKey === k || nameKey.startsWith(`${k} `) || nameKey.includes(` ${k}`));
      });
    const limit = named ? radius * 1.5 : radius;
    if (d > limit) continue;
    const score = d / radius - (named ? 1 : 0);
    if (!best || score < best.score) best = { city, score };
  }
  return best?.city;
}

/** Nearest country (by nearest gazetteer city) — used only as a fallback for stops without country info. */
export function guessCountry(lat: number, lon: number): string | undefined {
  let best: { cc: string; d: number } | undefined;
  for (const city of CITIES) {
    const d = haversineMeters({ lat, lon }, city);
    if (!best || d < best.d) best = { cc: city.countryCode, d };
  }
  return best && best.d < 150_000 ? best.cc : undefined;
}

export function searchGazetteer(query: string, limit = 10): GazetteerCity[] {
  const q = normalizeName(query);
  if (!q) return [];
  const scored: Array<{ c: GazetteerCity; s: number }> = [];
  for (const c of CITIES) {
    let s = 0;
    for (const n of [c.name, ...c.aliases]) {
      const k = normalizeName(n);
      if (k === q) s = Math.max(s, 1);
      else if (k.startsWith(q)) s = Math.max(s, 0.8);
      else s = Math.max(s, nameSimilarity(k, q) * 0.6);
    }
    if (s > 0.3) scored.push({ c, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.c);
}
