import type { Page, Request, Response, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import type { CustomFixture } from '@tests/e2e/utils/types';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_LANGUAGE_KEY } from '@/platform/lib/i18n/constants';
import { sanitizeLogFields } from '@/platform/lib/redaction/sanitize-log-fields';

import locales from '@/app/i18n';
import { AUTH_SIGNUP_ENABLED } from '@/modules/auth/client';
import { FileRouteTypes } from '@/routeTree.gen';

import { installConsoleErrorGuard } from './console-error-guard';
import { type MaildevOtpPollEvent, readLatestOtp } from './maildev';

type PostAuthRoute = '/app' | '/manager';

type AuthDiagnosticEvent = {
  at: string;
  elapsedMs: number;
  type: string;
  url: string;
  details?: Record<string, unknown>;
};

export interface PageUtils {
  /**
   * Utility used to authenticate a user on the app
   */
  login: (input: { email: string; code?: string }) => Promise<void>;

  /**
   * Attach the auth diagnostics collected for the current test.
   */
  attachAuthDiagnostics: (label?: string) => Promise<void>;

  /**
   * Record a timestamped auth diagnostic event.
   */
  authDebug: (type: string, details?: Record<string, unknown>) => void;

  /**
   * Wait for a post-auth route or any nested route below it.
   */
  waitForPostAuthRoute: (route: PostAuthRoute) => Promise<void>;

  /**
   * Fail if the page emitted unexpected browser console errors or page errors.
   */
  assertNoUnexpectedConsoleErrors: () => Promise<void>;

  /**
   * Override of the `page.goto` method with typed routes from the app
   */
  to: (
    url: FileRouteTypes['to'],
    options?: Parameters<Page['goto']>[1]
  ) => ReturnType<Page['goto']>;
}

export type ExtendedPageInstance = Page & PageUtils;
export type ExtendedPage = { page: ExtendedPageInstance };

const DEBUG_PATHS = ['/api/auth', '/login', '/manager', '/app'] as const;
const AUTH_WAIT_TIMEOUT_MS = 25_000;
const AUTH_API_RESPONSE_BODY_PREVIEW_LENGTH = 2_000;
const DIAGNOSTIC_RESPONSE_HEADERS = [
  'content-type',
  'location',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
  'x-retry-after',
] as const;
const SENSITIVE_DETAIL_KEYS = new Set([
  'code',
  'email',
  'id',
  'identifier',
  'name',
  'otp',
  'phone',
  'user',
]);

const redactDiagnosticDetails = (
  details?: Record<string, unknown>
): Record<string, unknown> | undefined =>
  details
    ? sanitizeLogFields(details, { sensitiveKeys: SENSITIVE_DETAIL_KEYS })
    : details;

const selectedResponseHeaders = (response: Response) => {
  const headers = response.headers();
  const selected: Record<string, string> = {};

  for (const header of DIAGNOSTIC_RESPONSE_HEADERS) {
    const value = headers[header];
    if (value) selected[header] = value;
  }

  return selected;
};

const readRequestPostData = (request: Request) => {
  const postData = request.postData();
  if (!postData) return undefined;

  try {
    return {
      postDataJson: request.postDataJSON() as unknown,
      postDataLength: postData.length,
    };
  } catch (error) {
    return {
      postDataLength: postData.length,
      postDataParseError:
        error instanceof Error ? error.message : String(error),
    };
  }
};

const responseBodyPreview = async (response: Response) => {
  try {
    const body = await response.text();
    return {
      bodyLength: body.length,
      bodyPreview: body.slice(0, AUTH_API_RESPONSE_BODY_PREVIEW_LENGTH),
      bodyTruncated: body.length > AUTH_API_RESPONSE_BODY_PREVIEW_LENGTH,
    };
  } catch (error) {
    return {
      bodyReadError: error instanceof Error ? error.message : String(error),
    };
  }
};

const shouldRecordUrl = (rawUrl: string) => {
  try {
    const { pathname } = new URL(rawUrl, 'http://localhost');
    return DEBUG_PATHS.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`)
    );
  } catch {
    return DEBUG_PATHS.some((path) => rawUrl.includes(path));
  }
};

const stringifyDiagnostics = (events: AuthDiagnosticEvent[]) =>
  JSON.stringify(events, null, 2);

const isPostAuthRouteUrl = (url: URL, route: PostAuthRoute) =>
  url.pathname === route || url.pathname.startsWith(`${route}/`);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob.replace(/\*+/g, '*').split('*').map(escapeRegExp).join('.*')}$`
  );

const isCurrentUrlMatch = (
  currentUrl: string,
  target: Parameters<Page['waitForURL']>[0]
) => {
  if (typeof target === 'function') {
    return target(new URL(currentUrl));
  }

  if (target instanceof RegExp) {
    return target.test(currentUrl);
  }

  if (isUrlPattern(target)) {
    return target.test(currentUrl);
  }

  if (typeof target !== 'string') {
    return false;
  }

  if (target.includes('*')) {
    const pattern = globToRegExp(target);
    const current = new URL(currentUrl);
    return pattern.test(currentUrl) || pattern.test(current.pathname);
  }

  const current = new URL(currentUrl);
  return currentUrl === target || current.pathname === target;
};

const isUrlPattern = (target: unknown): target is URLPattern =>
  typeof URLPattern !== 'undefined' && target instanceof URLPattern;

const createAuthDiagnostics = (page: Page, testInfo: TestInfo) => {
  const startedAt = Date.now();
  const events: AuthDiagnosticEvent[] = [];

  const log = (type: string, details?: Record<string, unknown>) => {
    const safeDetails = redactDiagnosticDetails(details);
    const event = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      type,
      url: page.url(),
      ...(safeDetails ? { details: safeDetails } : {}),
    };

    events.push(event);
    console.info(`[auth-e2e] ${testInfo.title} ${type}`, event);
  };

  const attach = async (label = 'auth-flow-diagnostics') => {
    if (events.length === 0) {
      return;
    }

    const path = testInfo.outputPath(`${label}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringifyDiagnostics(events));

    await testInfo.attach(`${label}.json`, {
      contentType: 'application/json',
      path,
    });
  };

  const waitForUrl = async (
    type: string,
    url: Parameters<Page['waitForURL']>[0],
    details?: Record<string, unknown>
  ) => {
    log(`${type}.start`, details);

    try {
      if (isCurrentUrlMatch(page.url(), url)) {
        log(`${type}.already_matched`, { ...details, skippedWait: true });
        log(`${type}.done`, details);
        return;
      }

      await page.waitForURL(url, {
        timeout: AUTH_WAIT_TIMEOUT_MS,
        waitUntil: 'commit',
      });
    } catch (error) {
      log(`${type}.failed`, {
        ...details,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      await attach(`${type.replaceAll('.', '-')}-timeout`);
      throw error;
    }

    log(`${type}.done`, details);
  };

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }

    log('page.navigated', { navigatedUrl: frame.url() });
  });

  page.on('console', (message) => {
    const text = message.text();
    if (message.type() !== 'error' && !text.includes('[auth-e2e]')) {
      return;
    }

    log('browser.console', {
      level: message.type(),
      location: message.location(),
      text,
    });
  });

  page.on('pageerror', (error) => {
    log('browser.pageerror', {
      message: error.message,
      stack: error.stack ?? null,
    });
  });

  page.on('requestfailed', (request) => {
    const requestUrl = request.url();
    if (!shouldRecordUrl(requestUrl)) {
      return;
    }

    log('request.failed', {
      errorText: request.failure()?.errorText ?? null,
      method: request.method(),
      requestUrl,
    });
  });

  page.on('request', (request) => {
    const requestUrl = request.url();
    if (!requestUrl.includes('/api/auth')) {
      return;
    }

    log('request', {
      method: request.method(),
      requestUrl,
      resourceType: request.resourceType(),
      ...readRequestPostData(request),
    });
  });

  page.on('response', (response) => {
    const responseUrl = response.url();
    if (!shouldRecordUrl(responseUrl)) {
      return;
    }

    const status = response.status();
    if (status < 300 && !responseUrl.includes('/api/auth')) {
      return;
    }

    log('response', {
      headers: selectedResponseHeaders(response),
      method: response.request().method(),
      responseUrl,
      status,
    });

    if (status >= 400 && responseUrl.includes('/api/auth')) {
      void (async () => {
        const body = await responseBodyPreview(response);
        log('response.body', {
          method: response.request().method(),
          responseUrl,
          status,
          ...body,
        });
      })();
    }
  });

  return { attach, log, waitForUrl };
};

export const pageWithUtils: CustomFixture<Page & PageUtils> = async (
  { page },
  apply,
  testInfo
) => {
  const diagnostics = createAuthDiagnostics(page, testInfo);
  const consoleGuard = installConsoleErrorGuard(page, testInfo);

  page.login = async function login(input: { email: string; code?: string }) {
    const routeLogin = '/login' satisfies FileRouteTypes['to'];
    const routeLoginVerify = '/login/verify' satisfies FileRouteTypes['to'];

    await diagnostics.waitForUrl(
      'login.wait_for_login',
      (url) => url.pathname === routeLogin,
      {
        route: routeLogin,
      }
    );

    await expect(
      page.getByText(
        locales[DEFAULT_LANGUAGE_KEY].auth[
          AUTH_SIGNUP_ENABLED ? 'pageLoginWithSignUp' : 'pageLogin'
        ].title,
        {
          exact: true,
        }
      )
    ).toBeVisible();
    await expect(page.getByTestId('auth-login-form')).toHaveAttribute(
      'data-hydrated',
      'true'
    );
    diagnostics.log('login.form.hydrated');

    diagnostics.log('login.form.visible');

    const emailInput = page.getByPlaceholder(
      locales[DEFAULT_LANGUAGE_KEY].auth.common.email.label
    );
    await emailInput.fill(input.email);
    await expect(emailInput).toHaveValue(input.email);
    diagnostics.log('login.email.filled', {
      emailInputMatches: (await emailInput.inputValue()) === input.email,
    });

    const submitButton = page.getByRole('button', {
      name: locales[DEFAULT_LANGUAGE_KEY].auth[
        AUTH_SIGNUP_ENABLED ? 'pageLoginWithSignUp' : 'pageLogin'
      ].loginWithEmail,
    });
    const otpRequestedAfterMs = Date.now();

    diagnostics.log('login.email.submit.ready', {
      buttonEnabled: await submitButton.isEnabled(),
      otpRequestedAfterMs,
    });
    await submitButton.click();
    diagnostics.log('login.email.submitted');

    await diagnostics.waitForUrl(
      'login.wait_for_verify',
      (url) => url.pathname === routeLoginVerify,
      {
        route: routeLoginVerify,
      }
    );
    await expect(page.getByTestId('auth-login-verify-form')).toHaveAttribute(
      'data-hydrated',
      'true'
    );
    diagnostics.log('login.verify.form.hydrated');
    const logMaildevPoll = ({ details, type }: MaildevOtpPollEvent) => {
      diagnostics.log(`login.${type}`, details);
    };
    const code =
      input.code ??
      (await readLatestOtp(input.email, {
        afterMs: otpRequestedAfterMs,
        onPoll: logMaildevPoll,
      }).catch(async (error) => {
        diagnostics.log('login.maildev.otp.failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        await diagnostics.attach('login-maildev-otp-failed');
        throw error;
      }));
    diagnostics.log('login.maildev.otp.received', {
      codeLength: code.length,
    });
    await page
      .getByText(locales[DEFAULT_LANGUAGE_KEY].auth.common.otp.label)
      .fill(code);
    diagnostics.log('login.otp.filled', {
      codeLength: code.length,
    });
  };

  page.attachAuthDiagnostics = diagnostics.attach;
  page.assertNoUnexpectedConsoleErrors = consoleGuard.assertNoUnexpectedIssues;
  page.authDebug = diagnostics.log;
  page.waitForPostAuthRoute = async function waitForPostAuthRoute(route) {
    await diagnostics.waitForUrl(
      'post_auth.wait',
      (url) => isPostAuthRouteUrl(url, route),
      { route }
    );
  };

  page.to = (url, options) =>
    page.goto(url, { waitUntil: 'commit', ...options });

  await apply(page);

  if (testInfo.status === testInfo.expectedStatus) {
    await consoleGuard.assertNoUnexpectedIssues();
  } else {
    await consoleGuard.attach();
  }

  if (testInfo.status !== testInfo.expectedStatus) {
    await diagnostics.attach();
  }
};
