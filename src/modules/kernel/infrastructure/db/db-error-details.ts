import { z } from 'zod';

type DatabaseErrorDetailValue = string | number;

export interface DatabaseErrorDetails {
  name?: string;
  message?: string;
  code?: string;
  detail?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
  dataType?: string;
  severity?: string;
  hint?: string;
  position?: DatabaseErrorDetailValue;
  where?: string;
  routine?: string;
  internalPosition?: DatabaseErrorDetailValue;
  internalQuery?: string;
  cause?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readDetailValue(value: unknown): DatabaseErrorDetailValue | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readCauseMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return undefined;
}

function assignIfMissing<T>(
  currentValue: T | undefined,
  nextValue: T | undefined,
  assign: (value: T) => void
): boolean {
  if (nextValue === undefined || currentValue !== undefined) return false;

  assign(nextValue);
  return true;
}

function readNameAndMessage(
  error: unknown,
  details: DatabaseErrorDetails
): boolean {
  let updated = false;

  if (error instanceof Error) {
    if (details.name === undefined) {
      details.name = error.name;
      updated = true;
    }
    if (details.message === undefined) {
      details.message = error.message;
      updated = true;
    }
  }

  if (isRecord(error)) {
    const nameValue = readStringValue(error.name);
    if (nameValue !== undefined && details.name === undefined) {
      details.name = nameValue;
      updated = true;
    }

    const messageValue = readStringValue(error.message);
    if (messageValue !== undefined && details.message === undefined) {
      details.message = messageValue;
      updated = true;
    }
  }

  return updated;
}

function readDatabaseFields(
  error: unknown,
  details: DatabaseErrorDetails
): boolean {
  if (!isRecord(error)) return false;

  return [
    assignIfMissing(details.code, readStringValue(error.code), (value) => {
      details.code = value;
    }),
    assignIfMissing(details.detail, readStringValue(error.detail), (value) => {
      details.detail = value;
    }),
    assignIfMissing(details.schema, readStringValue(error.schema), (value) => {
      details.schema = value;
    }),
    assignIfMissing(details.table, readStringValue(error.table), (value) => {
      details.table = value;
    }),
    assignIfMissing(details.column, readStringValue(error.column), (value) => {
      details.column = value;
    }),
    assignIfMissing(
      details.constraint,
      readStringValue(error.constraint),
      (value) => {
        details.constraint = value;
      }
    ),
    assignIfMissing(
      details.dataType,
      readStringValue(error.dataType),
      (value) => {
        details.dataType = value;
      }
    ),
    assignIfMissing(
      details.severity,
      readStringValue(error.severity),
      (value) => {
        details.severity = value;
      }
    ),
    assignIfMissing(details.hint, readStringValue(error.hint), (value) => {
      details.hint = value;
    }),
    assignIfMissing(
      details.position,
      readDetailValue(error.position),
      (value) => {
        details.position = value;
      }
    ),
    assignIfMissing(details.where, readStringValue(error.where), (value) => {
      details.where = value;
    }),
    assignIfMissing(
      details.routine,
      readStringValue(error.routine),
      (value) => {
        details.routine = value;
      }
    ),
    assignIfMissing(
      details.internalPosition,
      readDetailValue(error.internalPosition),
      (value) => {
        details.internalPosition = value;
      }
    ),
    assignIfMissing(
      details.internalQuery,
      readStringValue(error.internalQuery),
      (value) => {
        details.internalQuery = value;
      }
    ),
  ].some(Boolean);
}

function ensureStandardDbFields(details: DatabaseErrorDetails): void {
  if (!('code' in details)) details.code = undefined;
  if (!('constraint' in details)) details.constraint = undefined;
  if (!('detail' in details)) details.detail = undefined;
}

export function extractDatabaseErrorDetails(
  error: unknown
): DatabaseErrorDetails | undefined {
  const details: DatabaseErrorDetails = {};
  let hasDetails = false;

  if (readNameAndMessage(error, details)) hasDetails = true;
  if (readDatabaseFields(error, details)) hasDetails = true;

  if (isRecord(error) && 'cause' in error) {
    const cause = error.cause;
    const causeMessage = readCauseMessage(cause);
    if (causeMessage !== undefined && details.cause === undefined) {
      details.cause = causeMessage;
      hasDetails = true;
    }

    if (readNameAndMessage(cause, details)) hasDetails = true;
    if (readDatabaseFields(cause, details)) hasDetails = true;
  }

  if (!hasDetails) return undefined;

  ensureStandardDbFields(details);
  return details;
}

export function withDatabaseErrorDetails(
  details: Record<string, unknown>,
  error: unknown
): Record<string, unknown> {
  const dbError = extractDatabaseErrorDetails(error);
  return dbError ? { ...details, dbError } : details;
}

export interface DatabaseErrorLogFields {
  event: string;
  error: string;
  exception?: Error;
  details: Record<string, unknown>;
}

export function buildDatabaseErrorLogFields(params: {
  event: string;
  error: unknown;
  context: Record<string, unknown>;
}): DatabaseErrorLogFields {
  const errorMessage =
    params.error instanceof Error ? params.error.message : String(params.error);
  return {
    event: params.event,
    error: errorMessage,
    exception: params.error instanceof Error ? params.error : undefined,
    details: withDatabaseErrorDetails(params.context, params.error),
  };
}

function* databaseErrorCauses(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

function extractFromErrorOrCause<T, R>(
  error: unknown,
  schema: z.ZodType<T>,
  extract: (data: T) => R
): R | undefined {
  for (const cause of databaseErrorCauses(error)) {
    const parsed = schema.safeParse(cause);
    if (parsed.success) return extract(parsed.data);
  }
  return undefined;
}

export function getDatabaseErrorCode(error: unknown): string | undefined {
  for (const current of databaseErrorCauses(error)) {
    // PostgreSQL classes include 2B, 3D, F0, HV, P0 and XX. Application
    // codes and transport codes such as EPIPE are not SQLSTATEs.
    if (
      typeof current.code === 'string' &&
      /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/u.test(current.code)
    )
      return current.code;
  }
  return undefined;
}

/** Certainty is separate from retryability: 40003 explicitly means unknown. */
export function classifyDatabaseFailure(error: unknown) {
  const sqlState = getDatabaseErrorCode(error);
  const uncertain =
    !sqlState ||
    sqlState.startsWith('08') ||
    ['40003', '57P01', '57P02', '57P03'].includes(sqlState);
  return {
    sqlState,
    publication: uncertain ? ('unknown' as const) : ('rejected' as const),
    retryableRollback:
      !!sqlState && ['40001', '40P01', '55P03'].includes(sqlState),
  };
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  return getDatabaseErrorCode(error) === '23505';
}

const errorWithConstraintSchema = z.looseObject({ constraint: z.string() });

export function getConstraintName(error: unknown): string | undefined {
  return extractFromErrorOrCause(
    error,
    errorWithConstraintSchema,
    (data) => data.constraint
  );
}

const errorWithDetailSchema = z.looseObject({ detail: z.string() });

export function getErrorDetail(error: unknown): string | undefined {
  return extractFromErrorOrCause(
    error,
    errorWithDetailSchema,
    (data) => data.detail
  );
}
