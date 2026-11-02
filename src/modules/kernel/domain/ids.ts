import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError } from './errors/id-validation-error';

type InternalBrand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

const zBrandedNonEmptyString = <TBrand extends string>() =>
  z.string().trim().min(1).brand<TBrand>();

export const zUserIdSchema = zBrandedNonEmptyString<'UserId'>();
export const zSessionIdSchema = zBrandedNonEmptyString<'SessionId'>();
export const zScopeKeySchema = zBrandedNonEmptyString<'ScopeKey'>();
export const zEmailStatusIdSchema = zBrandedNonEmptyString<'EmailStatusId'>();
export const zEmailProviderMessageIdSchema =
  zBrandedNonEmptyString<'EmailProviderMessageId'>();
export const zEmailIdempotencyKeySchema =
  zBrandedNonEmptyString<'EmailIdempotencyKey'>();
export const zEmailWebhookEventIdSchema =
  zBrandedNonEmptyString<'EmailWebhookEventId'>();
export const zEmailRecipientListSchema =
  zBrandedNonEmptyString<'EmailRecipientList'>();
export const zOtpCodeSchema = z.string().trim().length(6).brand<'OtpCode'>();
export const zLanguageCodeSchema = zBrandedNonEmptyString<'LanguageCode'>();
export const zEmailAddressSchema = z
  .string()
  .trim()
  .pipe(z.email())
  .brand<'EmailAddress'>();

export type UserId = z.infer<typeof zUserIdSchema>;
export type SessionId = z.infer<typeof zSessionIdSchema>;
export type AuthSessionId = SessionId;
export type ScopeKey = z.infer<typeof zScopeKeySchema>;
export type EmailStatusId = z.infer<typeof zEmailStatusIdSchema>;
export type EmailProviderMessageId = z.infer<
  typeof zEmailProviderMessageIdSchema
>;
export type EmailIdempotencyKey = z.infer<typeof zEmailIdempotencyKeySchema>;
export type EmailWebhookEventId = z.infer<typeof zEmailWebhookEventIdSchema>;
export type EmailRecipientList = z.infer<typeof zEmailRecipientListSchema>;
export type OtpCode = z.infer<typeof zOtpCodeSchema>;
export type LanguageCode = z.infer<typeof zLanguageCodeSchema>;
export type EmailAddress = z.infer<typeof zEmailAddressSchema>;

export type GeneratedId = InternalBrand<string, 'GeneratedId'>;
export type RequestId = InternalBrand<string, 'RequestId'>;
export type CorrelationId = InternalBrand<string, 'CorrelationId'>;
export type CacheKey = InternalBrand<string, 'CacheKey'>;

export type ParseResult<TValue> = BoxedResult<TValue, IdValidationError>;

const ensureNonEmptyId = (
  value: string,
  typeName: string
): ParseResult<string> => {
  const trimmed = value.trim();
  if (!trimmed) {
    return Result.Error(new IdValidationError(typeName, value));
  }
  return Result.Ok(trimmed);
};

const parseBrandedString = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: string,
  typeName: string,
  message?: string
): ParseResult<z.output<TSchema>> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    return Result.Error(new IdValidationError(typeName, value, message));
  }
  return Result.Ok(result.data);
};

export const toUserId = (value: string): ParseResult<UserId> =>
  parseBrandedString(zUserIdSchema, value, 'UserId');
export const toSessionId = (value: string): ParseResult<SessionId> =>
  parseBrandedString(zSessionIdSchema, value, 'SessionId');
export const toScopeKey = (value: string): ParseResult<ScopeKey> =>
  parseBrandedString(zScopeKeySchema, value, 'ScopeKey');
export const toEmailStatusId = (value: string): ParseResult<EmailStatusId> =>
  parseBrandedString(zEmailStatusIdSchema, value, 'EmailStatusId');
export const toEmailProviderMessageId = (
  value: string
): ParseResult<EmailProviderMessageId> =>
  parseBrandedString(
    zEmailProviderMessageIdSchema,
    value,
    'EmailProviderMessageId'
  );
export const toEmailIdempotencyKey = (
  value: string
): ParseResult<EmailIdempotencyKey> =>
  parseBrandedString(zEmailIdempotencyKeySchema, value, 'EmailIdempotencyKey');
export const toEmailWebhookEventId = (
  value: string
): ParseResult<EmailWebhookEventId> =>
  parseBrandedString(zEmailWebhookEventIdSchema, value, 'EmailWebhookEventId');
export const toEmailRecipientList = (
  value: string
): ParseResult<EmailRecipientList> =>
  parseBrandedString(zEmailRecipientListSchema, value, 'EmailRecipientList');
export const toOtpCode = (value: string): ParseResult<OtpCode> =>
  parseBrandedString(zOtpCodeSchema, value, 'OtpCode', 'OtpCode is invalid');
export const toLanguageCode = (value: string): ParseResult<LanguageCode> =>
  parseBrandedString(zLanguageCodeSchema, value, 'LanguageCode');
export const toEmailAddress = (value: string): ParseResult<EmailAddress> =>
  parseBrandedString(
    zEmailAddressSchema,
    value,
    'EmailAddress',
    'EmailAddress is invalid'
  );

export const toGeneratedId = (value: string): ParseResult<GeneratedId> => {
  const result = ensureNonEmptyId(value, 'GeneratedId');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as GeneratedId);
};
export const toRequestId = (value: string): ParseResult<RequestId> => {
  const result = ensureNonEmptyId(value, 'RequestId');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as RequestId);
};
export const toCorrelationId = (value: string): ParseResult<CorrelationId> => {
  const result = ensureNonEmptyId(value, 'CorrelationId');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as CorrelationId);
};
export const toCacheKey = (value: string): ParseResult<CacheKey> => {
  const result = ensureNonEmptyId(value, 'CacheKey');
  return result.isError()
    ? Result.Error(result.getError())
    : Result.Ok(result.get() as CacheKey);
};

export const zUserId = () => zUserIdSchema;
export const zSessionId = () => zSessionIdSchema;
export const zScopeKey = () => zScopeKeySchema;
export const zEmailStatusId = () => zEmailStatusIdSchema;
export const zEmailProviderMessageId = () => zEmailProviderMessageIdSchema;
export const zEmailIdempotencyKey = () => zEmailIdempotencyKeySchema;
export const zEmailWebhookEventId = () => zEmailWebhookEventIdSchema;
export const zEmailRecipientList = () => zEmailRecipientListSchema;
export const zOtpCode = () => zOtpCodeSchema;
export const zLanguageCode = () => zLanguageCodeSchema;
export const zEmailAddress = () => zEmailAddressSchema;
