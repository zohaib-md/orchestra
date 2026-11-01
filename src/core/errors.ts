/** A refusal a caller can cause, as opposed to a system failure. */
export class UserError extends Error {
  constructor(
    readonly code: string,
    readonly values: Record<string, string> = {},
  ) {
    super(code);
    this.name = "UserError";
  }
}

/** Fixed refusal codes, worded by the dashboard in each language. */
export const USER_ERRORS = {
  missing: "missing",
  invalid: "invalid",
  alreadyExists: "already_exists",
  notOpen: "not_open",
  notAllowed: "not_allowed",
} as const;
