import { AUTH_EMAIL_OTP_EXPIRATION_IN_MINUTES } from '@/modules/auth';
import { envClient } from '@/platform/env/client';

export { AUTH_EMAIL_OTP_EXPIRATION_IN_MINUTES };

export const AUTH_SIGNUP_ENABLED = envClient.VITE_AUTH_SIGNUP_ENABLED;
