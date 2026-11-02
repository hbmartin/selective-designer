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

export const LoginEmailOtpHint = () => {
  if (import.meta.env.PROD || envClient.VITE_VISUAL_TEST) {
    return null;
  }

  return (
    <Alert dir="ltr">
      <TerminalIcon className="size-4" />
      <AlertTitle>Dev mode</AlertTitle>
      <AlertDescription className="flex flex-wrap gap-x-1 text-sm leading-4">
        <span>Read the code from Maildev (</span>
        <a
          // eslint-disable-next-line sonarjs/no-clear-text-protocols
          href="http://localhost:1080"
          className="font-medium underline underline-offset-4 hover:no-underline"
          target="_blank"
          rel="noreferrer noopener"
        >
          http://localhost:1080
        </a>
        <span>).</span>
      </AlertDescription>
    </Alert>
  );
};
