import { useTranslation } from 'react-i18next';

import { BackButton } from '@/platform/components/back-button';
import {
  ManagerPageLayout as PageLayout,
  ManagerPageLayoutContent as PageLayoutContent,
  ManagerPageLayoutTopBar as PageLayoutTopBar,
  ManagerPageLayoutTopBarTitle as PageLayoutTopBarTitle,
} from '@/platform/components/page-layout';
import { Card, CardContent } from '@/platform/components/ui/card';

export const PageUserNew = () => {
  const { t } = useTranslation(['user']);
  return (
    <PageLayout>
      <PageLayoutTopBar startActions={<BackButton />}>
        <PageLayoutTopBarTitle>
          {t('user:manager.new.title')}
        </PageLayoutTopBarTitle>
      </PageLayoutTopBar>
      <PageLayoutContent>
        <Card>
          <CardContent className="space-y-3">
            <p>{t('user:manager.new.instructions')}</p>
            <code className="block break-all">
              pnpm auth:password create EMAIL NAME [user|admin]
            </code>
            <p>{t('user:manager.new.handoffInstructions')}</p>
          </CardContent>
        </Card>
      </PageLayoutContent>
    </PageLayout>
  );
};
