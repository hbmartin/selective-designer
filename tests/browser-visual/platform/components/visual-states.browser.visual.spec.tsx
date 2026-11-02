import { page, render, setupUser } from '@tests/utils';
import { type ReactNode, useState } from 'react';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import { Button } from '@/platform/components/ui/button';
import { DatePicker } from '@/platform/components/ui/date-picker';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/platform/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/platform/components/ui/dropdown-menu';

const visualOptions = {
  comparatorName: 'pixelmatch',
  comparatorOptions: {
    allowedMismatchedPixelRatio: 0.001,
  },
} as const;

const fixedDate = new Date('2026-06-15T12:00:00.000Z');

function VisualSurface(props: { children: ReactNode; narrow?: boolean }) {
  return (
    <div
      data-testid="visual-surface"
      className="flex min-h-[420px] items-start justify-center bg-background p-8 text-foreground"
    >
      <div className={props.narrow ? 'w-80' : 'w-[28rem]'}>
        {props.children}
      </div>
    </div>
  );
}

function RequiredTextForm() {
  const form = useAppForm({
    defaultValues: { name: '' },
    validators: {
      onSubmit: z.object({
        name: z.string().min(1, 'Name is required'),
      }),
    },
    onSubmit: () => undefined,
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>Name</FormFieldLabel>
        <form.AppField name="name">
          {(field) => <field.FieldText type="text" />}
        </form.AppField>
      </FormField>
      <Button type="submit">Save profile</Button>
    </Form>
  );
}

function ComboboxForm() {
  const form = useAppForm({
    defaultValues: { project: null as string | null },
    validators: {
      onSubmit: z.object({
        project: z.string().nullable(),
      }),
    },
    onSubmit: () => undefined,
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>Project</FormFieldLabel>
        <form.AppField name="project">
          {(field) => (
            <field.FieldCombobox
              emptyContent="No projects found"
              items={[
                { label: 'Analytics', value: 'analytics' },
                { label: 'Billing', value: 'billing' },
                { label: 'Customer Portal', value: 'customer-portal' },
              ]}
              placeholder="Choose a project"
              showClear
            />
          )}
        </form.AppField>
      </FormField>
      <Button type="submit">Save project</Button>
    </Form>
  );
}

function DropdownMenuVisual() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="secondary" />}>
        Open actions
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            Archive
            <DropdownMenuShortcut>Cmd+A</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>Duplicate</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DialogVisual() {
  return (
    <Dialog>
      <DialogTrigger render={<Button />}>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite teammate</DialogTitle>
          <DialogDescription>
            Send a secure invitation to collaborate on this workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            Pending invitations expire after seven days.
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary">Cancel</Button>
          <Button>Send invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DatePickerVisual() {
  const [value, setValue] = useState<Date | null>(fixedDate);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium" htmlFor="release-date">
        Release date
      </label>
      <DatePicker
        id="release-date"
        calendarProps={{ defaultMonth: fixedDate }}
        value={value}
        onChange={setValue}
      />
    </div>
  );
}

test('form validation error remains visually stable', async () => {
  const user = setupUser();
  render(
    <VisualSurface narrow>
      <RequiredTextForm />
    </VisualSurface>
  );

  await user.click(page.getByRole('button', { name: 'Save profile' }));
  await expect.element(page.getByText('Name is required')).toBeVisible();

  await expect
    .element(page.getByTestId('visual-surface'))
    .toMatchScreenshot('form-validation-error', visualOptions);
});

test('combobox open state remains visually stable', async () => {
  const user = setupUser();
  render(
    <VisualSurface>
      <ComboboxForm />
    </VisualSurface>
  );

  await user.click(page.getByRole('combobox', { name: 'Project' }));
  await expect
    .element(page.getByRole('option', { name: 'Billing' }))
    .toBeVisible();

  await expect
    .element(document.body)
    .toMatchScreenshot('combobox-open', visualOptions);
});

test('combobox no-results state remains visually stable', async () => {
  const user = setupUser();
  render(
    <VisualSurface>
      <ComboboxForm />
    </VisualSurface>
  );

  const input = page.getByRole('combobox', { name: 'Project' });
  await user.click(input);
  await user.type(input.element() as HTMLInputElement, 'Unmatched');
  await expect.element(page.getByText('No projects found')).toBeVisible();

  await expect
    .element(document.body)
    .toMatchScreenshot('combobox-no-results', visualOptions);
});

test('dropdown menu expanded state remains visually stable', async () => {
  const user = setupUser();
  render(
    <VisualSurface narrow>
      <DropdownMenuVisual />
    </VisualSurface>
  );

  await user.click(page.getByRole('button', { name: 'Open actions' }));
  await expect
    .element(page.getByRole('menuitem', { name: /archive/i }))
    .toBeVisible();

  await expect
    .element(document.body)
    .toMatchScreenshot('dropdown-menu-expanded', visualOptions);
});

test('dialog open state remains visually stable', async () => {
  const user = setupUser();
  render(
    <VisualSurface narrow>
      <DialogVisual />
    </VisualSurface>
  );

  await user.click(page.getByRole('button', { name: 'Open dialog' }));
  await expect
    .element(page.getByRole('dialog', { name: 'Invite teammate' }))
    .toBeVisible();

  await expect
    .element(document.body)
    .toMatchScreenshot('dialog-open', visualOptions);
});

test('date picker open state remains visually stable', async () => {
  const user = setupUser();
  render(
    <VisualSurface narrow>
      <DatePickerVisual />
    </VisualSurface>
  );

  await user.click(page.getByRole('button'));
  await expect.element(page.getByText('June 2026')).toBeVisible();

  await expect
    .element(document.body)
    .toMatchScreenshot('date-picker-open', visualOptions);
});
