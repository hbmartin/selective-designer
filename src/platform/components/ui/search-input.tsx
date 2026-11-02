import { SearchIcon, XIcon } from 'lucide-react';
import React, {
  ComponentProps,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useTranslation } from 'react-i18next';
import { mergeRefs } from 'react-merge-refs';

import { cn } from '@/platform/lib/tailwind/utils';
import { useHydrated } from '@/platform/hooks/use-hydrated';

import { Input } from '@/platform/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/platform/components/ui/input-group';
import { Spinner } from '@/platform/components/ui/spinner';

type CustomProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  changeAction?(value: string): unknown | Promise<unknown>;
  delay?: number;
  clearLabel?: string;
  loading?: boolean;
};

type SearchInputProps = CustomProps &
  Omit<ComponentProps<typeof Input>, 'defaultValue' | 'onChange' | 'value'>;

export const SearchInput = ({
  ref,
  value,
  defaultValue,
  className,
  onValueChange,
  changeAction,
  delay = 500,
  placeholder,
  clearLabel,
  disabled = false,
  loading = false,
  size,
  ...rest
}: SearchInputProps & { ref?: React.RefObject<HTMLInputElement | null> }) => {
  const { t } = useTranslation(['components']);
  const hydrated = useHydrated();
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = mergeRefs([ref, internalRef]);

  const [search, setSearch] = useState<string>(value ?? defaultValue ?? '');
  const [isActionPending, startActionTransition] = useTransition();
  const userChangedValueRef = useRef(false);
  const actionSequenceRef = useRef(0);
  const lastObservedExternalValueRef = useRef(value ?? '');
  const hasChangeAction = changeAction !== undefined;

  const runChangeAction = useEffectEvent(
    async (nextValue: string, actionSequence: number) => {
      await changeAction?.(nextValue);

      if (actionSequence !== actionSequenceRef.current) return;

      userChangedValueRef.current = false;
    }
  );

  useEffect(() => {
    const nextValue = value ?? '';
    if (nextValue === lastObservedExternalValueRef.current) return;

    lastObservedExternalValueRef.current = nextValue;
    if (userChangedValueRef.current && nextValue !== search) return;

    userChangedValueRef.current = false;
    setSearch(nextValue);
  }, [search, value]);

  useEffect(() => {
    if (!userChangedValueRef.current || !hasChangeAction) return;
    if (search === (value ?? '')) {
      userChangedValueRef.current = false;
      return;
    }

    const actionSequence = ++actionSequenceRef.current;
    const timeoutId = setTimeout(() => {
      startActionTransition(async () => {
        await runChangeAction(search, actionSequence);
      });
    }, delay);

    return () => clearTimeout(timeoutId);
  }, [delay, hasChangeAction, search, value]);

  const updateSearch = (nextValue: string) => {
    userChangedValueRef.current = true;
    setSearch(nextValue);
    onValueChange?.(nextValue);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    updateSearch(event.target.value);
  };

  const handleClear = () => {
    updateSearch('');
    internalRef.current?.focus();
  };

  const handleEscape = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event?.key?.toLowerCase() === 'escape') {
      handleClear();
    }
    rest.onKeyDown?.(event);
  };

  const getEndElement = () => {
    if (loading || isActionPending) return <Spinner />;
    if (!disabled && search)
      return (
        <InputGroupButton
          onClick={handleClear}
          variant="ghost"
          size="icon-xs"
          className="mr-0.5"
        >
          <span className="sr-only">
            {clearLabel ?? t('components:searchInput.clear')}
          </span>
          <XIcon />
        </InputGroupButton>
      );
    return <SearchIcon className={cn(disabled && 'opacity-30')} />;
  };

  return (
    <InputGroup
      size={size}
      className={className}
      aria-busy={loading || isActionPending || undefined}
      data-hydrated={hydrated}
      inert={!hydrated}
    >
      {isActionPending && (
        <span className="sr-only" role="status">
          {t('components:searchInput.pending')}
        </span>
      )}
      <InputGroupInput
        {...rest}
        ref={inputRef}
        onChange={handleChange}
        value={search || ''}
        placeholder={placeholder ?? t('components:searchInput.placeholder')}
        onKeyDown={handleEscape}
        disabled={disabled}
      />
      <InputGroupAddon align="inline-end">{getEndElement()}</InputGroupAddon>
    </InputGroup>
  );
};
