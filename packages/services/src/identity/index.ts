export { signIn, signOut, type SignInResult } from './sign-in';
export { resolveSession, type RequestMeta, type ResolvedSession } from './request-context';
export { getMe, updateMyPreferences, changeMyPassword, type Me } from './me';
export {
  listAccounts, getAccount, createAccount, updateAccount, setAccountStatus, resetAccountPassword,
  changeAccountPermissions, applyPresetToAccount, listPresets, type AccountSummary, type AccountDetail,
} from './accounts';
export { hashPassword } from './password';
// USR-003: the same first password everywhere one is issued, including the
// bootstrap account (src/scripts/first-admin.ts), which predates any user.
export { newTemporaryPassword } from './tokens';
// ADR-0017: scripts that act as a named account build its context from here
// rather than reaching into the module — see src/scripts/import.ts.
export { loadOverrides } from './permission-store';
export { requestPasswordReset, resetPasswordWithToken } from './password-reset';
export type { SessionMeta } from './sessions';
