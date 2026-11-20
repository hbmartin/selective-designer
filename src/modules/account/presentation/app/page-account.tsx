import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AppPageLayout as PageLayout,
  AppPageLayoutContent as PageLayoutContent,
  AppPageLayoutTopBar as PageLayoutTopBar,
  AppPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';

import { DisplayPreferences } from '../display-preferences';
import { UserCard } from '../user-card';

export const PageAccount = (props: { supportSlot?: ReactNode }) => {
  const { t } = useTranslation(['account']);

  return (
    <PageLayout>
      <PageLayoutTopBar containerClassName="max-w-2xl">
        <PageLayoutTopBarTitle>{t('account:title')}</PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent containerClassName="max-w-2xl">
        <div className="flex flex-col gap-4">
          <UserCard />
          <DisplayPreferences />
          {props.supportSlot}
        </div>
      </PageLayoutContent>
    </PageLayout>
  );
};
