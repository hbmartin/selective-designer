import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('resolves the same router-core package as TanStack React Router', () => {
  const fromApp = createRequire(new URL('../../package.json', import.meta.url));
  const fromReactRouter = createRequire(
    fromApp.resolve('@tanstack/react-router/package.json')
  );
  const core = '@tanstack/router-core/package.json';
  const appPath = realpathSync(fromApp.resolve(core));
  const routerPath = realpathSync(fromReactRouter.resolve(core));
  const appVersion = fromApp(core).version;
  const routerVersion = fromReactRouter(core).version;

  expect(
    appPath,
    `BridgeLink uses router-core ${appVersion} at ${appPath}, and React Router uses ${routerVersion} at ${routerPath}. Update the pins together.`
  ).toBe(routerPath);
});
