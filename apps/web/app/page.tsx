import { Suspense } from 'react';
import { SearchPage } from '@/components/search-page';

export default function Home() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  );
}
