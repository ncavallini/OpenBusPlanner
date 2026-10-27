import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Privacy policy — OpenBus Planner' };

const CONTROLLER = 'PCN Group';
const CONTACT_EMAIL = 'n.cavallini@pcngroup.ch';
const LAST_UPDATED = '27 October 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 p-4 md:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function PrivacyPage() {
  const mail = (
    <a className="text-brand-700 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
  );
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className="mt-1 text-muted">Last updated: {LAST_UPDATED}</p>
      <Card className="mt-6 divide-y divide-line">
        <Section title="Summary">
          <p>
            You can use OpenBus Planner without an account. We set no cookies, use no analytics or advertising trackers and do not
            store your IP address with your searches. The only third party your browser contacts is the map tile provider.
          </p>
        </Section>

        <Section title="Who is responsible">
          <p>
            {CONTROLLER} operates openbus.pcngroup.ch and is responsible for the processing described here under the Swiss Federal Act
            on Data Protection (FADP) and, where it applies, the EU General Data Protection Regulation (GDPR). Contact: {mail}.
          </p>
        </Section>

        <Section title="What we process and why">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Your searches.</strong> To answer a search, our server receives the places, date, time window and options you
              enter. We keep a log of searches (these fields, the number of results and which timetable sources were used) to
              operate, troubleshoot and improve the service. This log contains no IP address, account or other
              identifier. The itineraries returned by a search are kept for 7 days so that shared result links keep working.
            </li>
            <li>
              <strong>Technical data.</strong> When your browser connects to our server it necessarily transmits your IP address and
              technical request data (browser type, requested page, time). We use the IP address only briefly in memory to limit
              abusive request rates; our application logs do not record it.
            </li>
            <li>
              <strong>Search addresses in links.</strong> Your search is part of the page address (URL), so it appears in your
              browser history and in any link you share.
            </li>
          </ul>
          <p>
            Legal basis under the GDPR: our legitimate interest in providing a working, secure journey planner (Art. 6(1)(f)
            GDPR).
          </p>
        </Section>

        <Section title="Third parties">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Map tiles: OpenFreeMap</strong> (tiles.openfreemap.org). To display the map, your browser loads map images
              directly from OpenFreeMap, which receives your IP address and the map area shown. OpenFreeMap may process this data
              outside Switzerland.
            </li>
            <li>
              <strong>Operator websites.</strong> Booking links take you to the operator's own website. We do not pass your search or
              any personal data to the operator; once there, the operator's privacy policy applies.
            </li>
          </ul>
          <p>We do not sell personal data and do not share it with anyone else.</p>
        </Section>

        <Section title="Where the data is stored">
          <p>The service and its database run on servers in Switzerland.</p>
        </Section>

        <Section title="Your rights">
          <p>
            You may ask for access to, correction or deletion of personal data about you, and object to its processing. Because we do
            not link searches to people, we usually cannot attribute any stored data to you. Write to {mail}. You may also complain to
            the Swiss Federal Data Protection and Information Commissioner (FDPIC) or, in the EU, to your national data protection
            authority.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If we introduce advertising, analytics or user accounts, we will update this policy before doing so and, where required,
            ask for your consent. The date at the top shows the current version.
          </p>
        </Section>
      </Card>
      <p className="mt-6 text-muted">
        Timetable data and its licences are described on the{' '}
        <Link className="underline" href="/sources">
          data sources
        </Link>{' '}
        page.
      </p>
    </div>
  );
}
