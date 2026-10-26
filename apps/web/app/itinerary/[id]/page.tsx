import Link from 'next/link';
import { ItineraryTimeline } from '@/components/itinerary-card';
import { Card } from '@/components/ui/primitives';
import { getItinerary } from '@/lib/api';
import { dayTime, duration } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getItinerary(id).catch(() => null);
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-center">
        <h1 className="text-xl font-semibold">Itinerary not found</h1>
        <p className="mt-2 text-sm text-muted">Itineraries are kept for 7 days after a search.</p>
        <Link href="/" className="mt-4 inline-block text-brand-700 underline">
          New search
        </Link>
      </div>
    );
  }
  const it = data.itinerary;
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-xl font-semibold">
        {it.legs[0]!.from.cityName ?? it.legs[0]!.from.name} → {it.legs[it.legs.length - 1]!.to.cityName ?? it.legs[it.legs.length - 1]!.to.name}
      </h1>
      <p className="text-sm text-muted">
        {dayTime(it.departure)} – {dayTime(it.arrival)} · {duration(it.durationSeconds)}
      </p>
      <Card className="mt-4">
        <ItineraryTimeline it={it} />
      </Card>
    </div>
  );
}
