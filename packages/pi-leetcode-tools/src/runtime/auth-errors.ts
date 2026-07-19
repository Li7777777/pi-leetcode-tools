export const AUTH_ERROR_CODES = [
  "auth_browser_closed",
  "auth_browser_open_failed",
  "auth_browser_unavailable",
  "auth_credentials_not_configured",
  "auth_credentials_incomplete",
  "auth_environment_bundle_partial",
  "auth_expired",
  "auth_import_cancelled",
  "auth_invalid_arguments",
  "auth_login_timeout",
  "auth_profile_invalid",
  "auth_profile_not_found",
  "auth_profile_overridden_by_environment",
  "auth_probe_invalid_response",
  "auth_probe_rejected",
  "auth_probe_timeout",
  "auth_probe_unavailable",
  "auth_region_invalid",
  "auth_region_mismatch",
  "auth_temporary_profile_cleanup_failed",
  "auth_tty_required",
  "credential_store_corrupt",
  "credential_store_rollback_failed",
  "credential_store_unavailable",
  "credentials_already_exist"
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/**
 * A bounded, user-actionable authentication error. Messages must never include
 * credential values, HTTP bodies, browser diagnostics, or keyring entry names.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthError";
    this.code = code;
  }
}

export function asAuthError(
  error: unknown,
  code: AuthErrorCode,
  message: string
): AuthError {
  return error instanceof AuthError
    ? error
    : new AuthError(code, message, { cause: error });
}
