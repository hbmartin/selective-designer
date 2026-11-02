import { SearchIcon } from 'lucide-react';
import {
  ComponentProps,
  ReactNode,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/platform/components/ui/button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/platform/components/ui/drawer';
import { SearchInput } from '@/platform/components/ui/search-input';

type Props = Omit<ComponentProps<typeof Button>, 'children' | 'onChange'> &
  Pick<ComponentProps<typeof SearchInput>, 'changeAction' | 'value'> & {
    loading?: boolean;
    inputProps?: Omit<
      ComponentProps<typeof SearchInput>,
      'changeAction' | 'onValueChange' | 'value'
    >;
  } & { label?: ReactNode };

const SearchButtonComponent = ({
  value,
  changeAction,
  loading,
  inputProps,
  label,
  ...props
}: Props) => {
  const { t } = useTranslation(['components']);
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(value ?? '');
  const [isActionPending, startActionTransition] = useTransition();
  const lastRequestedValueRef = useRef(value ?? '');

  const commitValue = (nextValue: string) => {
    if (!changeAction || nextValue === lastRequestedValueRef.current) return;

    lastRequestedValueRef.current = nextValue;
    startActionTransition(async () => {
      try {
        await changeAction(nextValue);
      } catch (error) {
        lastRequestedValueRef.current = value ?? '';
        throw error;
      }
    });
  };

  return (
    <Drawer
      swipeDirection="up"
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (isOpen) {
          setInternalValue(value ?? '');
          setOpen(true);
          return;
        }

        setOpen(false);
        commitValue(internalValue);
      }}
    >
      <DrawerTrigger
        render={
          <Button
            size="icon"
            variant="ghost"
            loading={loading || isActionPending}
            {...props}
          />
        }
      >
        <SearchIcon />
        {isActionPending && (
          <span className="sr-only" role="status">
            {t('components:searchButton.pending')}
          </span>
        )}
        <span className="sr-only">
          {label || t('components:searchButton.label')}
        </span>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader className="sr-only">
          <DrawerTitle>
            {label || t('components:searchButton.label')}
          </DrawerTitle>
          <DrawerDescription></DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="py-4">
          <SearchInput
            value={internalValue}
            onValueChange={setInternalValue}
            size="lg"
            autoFocus // Force iOS to open the keyboard
            {...inputProps}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitValue(internalValue);
                setOpen(false);
              }
              inputProps?.onKeyDown?.(event);
            }}
          />
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
};

export const SearchButton = (props: Props) => {
  return <SearchButtonComponent key={props.value} {...props} />;
};
