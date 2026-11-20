import { ImageIcon, PlusIcon } from 'lucide-react';

import { Button } from '@/platform/components/ui/button';
import { EmptyState } from '@/platform/components/ui/empty-state';

function Default() {
  return (
    <EmptyState
      icon={<ImageIcon />}
      title="No designs yet"
      description="Upload an architect's image to start."
      action={
        <Button size="sm">
          <PlusIcon />
          New design
        </Button>
      }
    />
  );
}

function Small() {
  return (
    <EmptyState
      size="sm"
      icon={<ImageIcon />}
      title="No renders yet"
      description="Renders you start appear here."
    />
  );
}

function TitleOnly() {
  return <EmptyState title="Nothing to show" />;
}

export default {
  Default,
  Small,
  TitleOnly,
};
