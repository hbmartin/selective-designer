import { TerminalIcon } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/platform/components/ui/alert';

import { envClient } from '@/platform/env/client';

export const LoginEmailHint = () => {
  if (import.meta.env.PROD || envClient.VITE_VISUAL_TEST) {
    return null;
  }

  return (
    <Alert dir="ltr">
      <TerminalIcon className="size-4" />
      <AlertTitle>Dev mode</AlertTitle>
      <AlertDescription className="flex flex-wrap gap-x-1 text-sm leading-4">
        Use a seeded account (see <code>pnpm db:seed</code> output).
      </AlertDescription>
    </Alert>
  );
};
