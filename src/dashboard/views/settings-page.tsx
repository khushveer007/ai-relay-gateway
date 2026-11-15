import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageError } from '@/components/page-error';
import { PageHeader } from '@/components/page-header';
import { useLoadErrorToast } from '@/hooks/use-load-error-toast';
import { providersQuery, settingsQuery } from '@/lib/queries';
import { RuleTester } from './settings/rule-tester';
import { SettingsFormCard } from './settings/settings-form';

const LOAD_MESSAGE = 'Failed to load Rules & Settings. Check your connection and try again.';

function CardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-1/2" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </CardContent>
    </Card>
  );
}

// One page, loaded as one unit (D-28): skeletons only while there is no data, and any needed query
// that failed with nothing cached shows the shared PageError. Order: settings, rule tester, rules list.
export default function SettingsView() {
  const settingsQ = useQuery(settingsQuery);
  const providersQ = useQuery(providersQuery);
  useLoadErrorToast(settingsQ, 'settings-load', LOAD_MESSAGE);
  useLoadErrorToast(providersQ, 'settings-providers-load', LOAD_MESSAGE);

  const settings = settingsQ.data;
  const providers = providersQ.data?.providers;
  const failed = (settingsQ.isError && !settings) || (providersQ.isError && !providers);
  const refreshing = settingsQ.fetchStatus === 'fetching' || providersQ.fetchStatus === 'fetching';
  const refresh = () => {
    void settingsQ.refetch();
    void providersQ.refetch();
  };

  let body;
  if (failed) {
    body = <PageError message={LOAD_MESSAGE} onRefresh={refresh} refreshing={refreshing} />;
  } else if (!settings || !providers) {
    body = (
      <div className="grid gap-6 md:grid-cols-2">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  } else {
    body = (
      <>
        <div className="grid gap-6 md:grid-cols-2">
          <SettingsFormCard settings={settings} />
          <RuleTester providers={providers} />
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rules & Settings"
        subtitle="Retry limits, log retention, and the rules that decide when to rotate a key or switch providers."
      />
      {body}
    </div>
  );
}
