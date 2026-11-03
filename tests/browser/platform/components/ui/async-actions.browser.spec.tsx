/* oxlint-disable simple-import-sort/imports -- Oxfmt owns import ordering. */
import { page, render, setupUser } from '@tests/utils';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

import { Button } from '@/platform/components/ui/button';
import { ConfirmResponsiveDrawer } from '@/platform/components/ui/confirm-responsive-drawer';
import {
  DataList,
  DataListErrorState,
} from '@/platform/components/ui/datalist';
import { LocalSwitcher } from '@/platform/components/ui/local-switcher';
import { SearchButton } from '@/platform/components/ui/search-button';
import { SearchInput } from '@/platform/components/ui/search-input';

const SearchHarness = (props: {
  persistSearch: (value: string) => Promise<void>;
}) => {
  const [committedSearch, setCommittedSearch] = useState('');

  return (
    <SearchInput
      value={committedSearch}
      delay={100}
      changeAction={async (value) => {
        await props.persistSearch(value);
        setCommittedSearch(value);
      }}
    />
  );
};

test('keeps search typing urgent and dispatches only the latest debounced action', async () => {
  let resolveSearch!: () => void;
  const persistSearch = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSearch = resolve;
      })
  );

  render(<SearchHarness persistSearch={persistSearch} />);

  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(persistSearch).not.toHaveBeenCalled();

  const input = page.getByRole('textbox');
  await input.fill('React');
  expect((input.element() as HTMLInputElement).value).toBe('React');

  await vi.waitFor(() => {
    expect(persistSearch).toHaveBeenCalledOnce();
    expect(persistSearch).toHaveBeenCalledWith('React');
  });
  expect(input.element().closest('[data-slot="input-group"]')).toHaveAttribute(
    'aria-busy',
    'true'
  );

  resolveSearch();
  await vi.waitFor(() => {
    expect(
      input.element().closest('[data-slot="input-group"]')
    ).not.toHaveAttribute('aria-busy');
  });
  expect((input.element() as HTMLInputElement).value).toBe('React');
});

test('mobile search does not dispatch on open and commits Enter once', async () => {
  const user = setupUser();
  const changeAction = vi.fn(async () => undefined);

  render(<SearchButton value="designs" changeAction={changeAction} />);

  await user.click(page.getByRole('button'));
  expect(changeAction).not.toHaveBeenCalled();

  const input = page.getByRole('textbox');
  await user.clear(input);
  await user.type(input, 'renders');
  await user.keyboard('{Enter}');

  await vi.waitFor(() => {
    expect(changeAction).toHaveBeenCalledOnce();
    expect(changeAction).toHaveBeenCalledWith('renders');
  });
});

test('confirmation owns pending state and invokes its action once', async () => {
  const user = setupUser();
  let resolveConfirmation!: () => void;
  const confirmAction = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveConfirmation = resolve;
      })
  );

  render(
    <ConfirmResponsiveDrawer
      title="Delete record"
      confirmText="Delete now"
      confirmAction={confirmAction}
    >
      <Button>Open confirmation</Button>
    </ConfirmResponsiveDrawer>
  );

  await user.click(page.getByRole('button', { name: 'Open confirmation' }));
  const confirmButton = page.getByRole('button', { name: 'Delete now' });
  (confirmButton.element() as HTMLElement).click();

  await vi.waitFor(() => expect(confirmAction).toHaveBeenCalledOnce());
  await expect.element(confirmButton).toBeDisabled();
  await expect.element(confirmButton).toHaveAttribute('aria-busy', 'true');

  resolveConfirmation();
  await expect.element(page.getByText('Delete record')).not.toBeInTheDocument();
});

test('retry actions expose localized pending feedback and prevent duplicates', async () => {
  const user = setupUser();
  let resolveRetry!: () => void;
  const retryAction = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveRetry = resolve;
      })
  );

  render(
    <DataList>
      <DataListErrorState retryAction={retryAction} />
    </DataList>
  );

  const retryButton = page.getByRole('button');
  await user.click(retryButton);

  await expect.element(retryButton).toBeDisabled();
  expect(retryAction).toHaveBeenCalledOnce();

  resolveRetry();
  await expect.element(retryButton).not.toBeDisabled();
});

test('hides the language switcher while only one language ships', async () => {
  await render(<LocalSwitcher />);

  await expect.element(page.getByRole('button')).not.toBeInTheDocument();
  await expect
    .element(page.getByRole('img', { name: /language/i }))
    .not.toBeInTheDocument();
});
