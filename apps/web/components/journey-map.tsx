'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import type { Itinerary } from '@/lib/api';

const STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';
const LEG_COLORS = ['#187049', '#2563eb', '#c2410c', '#7c3aed', '#0e7490'];

/** Map of the selected itinerary: one coloured line per leg, markers at transfer points. */
export function JourneyMap({ it }: { it: Itinerary | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const maplibre = (await import('maplibre-gl')).default;
        if (cancelled || !ref.current) return;
        const m = new maplibre.Map({ container: ref.current, style: STYLE, center: [10, 47], zoom: 4.5, attributionControl: { compact: true } });
        m.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        m.on('load', () => setReady(true));
        m.on('error', () => {});
        map.current = m;
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    for (const id of m.getStyle().layers?.map((l) => l.id) ?? []) if (id.startsWith('ob-')) m.removeLayer(id);
    for (const id of Object.keys(m.getStyle().sources ?? {})) if (id.startsWith('ob-')) m.removeSource(id);
    if (!it) return;
    const features = it.legs.map((leg, i) => ({
      type: 'Feature' as const,
      properties: { color: LEG_COLORS[i % LEG_COLORS.length] },
      geometry: {
        type: 'LineString' as const,
        coordinates: [leg.from, ...leg.intermediateStops, leg.to].map((s) => [s.lon, s.lat]),
      },
    }));
    const points = [it.legs[0]!.from, ...it.legs.map((l) => l.to)].map((s) => ({
      type: 'Feature' as const,
      properties: { name: s.name },
      geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    }));
    m.addSource('ob-legs', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    m.addSource('ob-stops', { type: 'geojson', data: { type: 'FeatureCollection', features: points } });
    m.addLayer({ id: 'ob-legs', type: 'line', source: 'ob-legs', paint: { 'line-color': ['get', 'color'], 'line-width': 4 }, layout: { 'line-cap': 'round' } });
    m.addLayer({ id: 'ob-stops', type: 'circle', source: 'ob-stops', paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#17201c', 'circle-stroke-width': 2 } });
    m.addLayer({
      id: 'ob-labels',
      type: 'symbol',
      source: 'ob-stops',
      layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
      paint: { 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
    const coords = features.flatMap((f) => f.geometry.coordinates) as Array<[number, number]>;
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 50, duration: 400, maxZoom: 9 });
  }, [it, ready]);

  if (failed) return <div className="flex h-full items-center justify-center text-sm text-muted">Map unavailable</div>;
  return <div ref={ref} className="h-full w-full" role="img" aria-label={it ? 'Map of the selected itinerary' : 'Map'} />;
}
