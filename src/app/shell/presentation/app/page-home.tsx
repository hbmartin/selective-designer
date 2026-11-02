import { Logo } from '@/platform/components/brand/logo';
import {
  PageLayout,
  PageLayoutContent,
  PageLayoutTopBar,
} from '@/platform/components/page-layout/app';

export const PageHome = () => {
  return (
    <PageLayout>
      <PageLayoutTopBar className="md:hidden">
        <Logo className="mx-auto w-24" />
      </PageLayoutTopBar>
      <PageLayoutContent />
    </PageLayout>
  );
};
