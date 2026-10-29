/** Shared sensitive-key detector for native memory capture and extraction. */
export const SECRET_KEY_PATTERN =
  /(authorization|auth_token|access_token|refresh_token|bearer|token|secret|password|passwd|pwd|api[-_]?key|apikey|cookie|set-cookie|signature|private[-_]?key|client[-_]?secret|x[-_]?api[-_]?key)/i;
