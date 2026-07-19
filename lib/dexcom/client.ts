'use strict';

/**
 * dexcom-share-client is ESM-only (package.json "type": "module", no "require" export
 * condition), while this app compiles to CommonJS. A CommonJS module can only load an
 * ESM-only package via a real dynamic import() (Node's native ESM/CJS interop) - a static
 * `import` here would fail to compile. The module is cached after first load since dynamic
 * import() itself is already a promise-cached singleton per specifier.
 */
type DexcomModule = typeof import('dexcom-share-client', { with: { 'resolution-mode': 'import' } });
type DexcomOptions = ConstructorParameters<DexcomModule['default']>[0];
/** Derived from the module's own constructor options rather than a separate type import, since a
 *  type-only static import of an ESM-only package would itself need a resolution-mode attribute. */
type RegionCode = NonNullable<DexcomOptions['region']>;

let modulePromise: Promise<DexcomModule> | null = null;

function loadDexcomModule(): Promise<DexcomModule> {
  if (!modulePromise) {
    // eslint-plugin-node@11 predates dynamic import() support in its feature table; real Node
    // (>=16, this app's engines range) and this app's own module:node16 tsconfig both fully
    // support it, and it's required here since dexcom-share-client is ESM-only and cannot be
    // require()'d from CJS.
    // eslint-disable-next-line node/no-unsupported-features/es-syntax
    modulePromise = import('dexcom-share-client');
  }
  return modulePromise;
}

export interface DexcomCredentialsInput {
  username: string;
  password: string;
  /** Plain lowercase region code, matching the driver.settings.compose.json dropdown values. */
  region: string;
}

/** The real dexcom-share-client DexcomShare instance, typed structurally where DexcomPoller needs it. */
export type RealDexcomClient = InstanceType<DexcomModule['default']>;

function regionEnumValue(module: DexcomModule, region: string): RegionCode {
  switch (region) {
    case 'ous': return module.Region.OUS;
    case 'jp': return module.Region.JP;
    default: return module.Region.US;
  }
}

/** Build a real DexcomShare client. Used as the DexcomPoller clientFactory in device.ts. */
export async function createDexcomClient(credentials: DexcomCredentialsInput): Promise<RealDexcomClient> {
  const dexcom = await loadDexcomModule();
  const DexcomShare = dexcom.default;
  return new DexcomShare({
    username: credentials.username,
    password: credentials.password,
    region: regionEnumValue(dexcom, credentials.region),
  });
}

/**
 * Validate credentials during pairing and return the account's stable Dexcom accountId.
 * A null result from getLatestGlucoseReading() is a *valid* login with no recent sensor data,
 * not a failure - only a thrown DexcomError means the credentials themselves were rejected.
 */
export async function verifyDexcomLogin(credentials: DexcomCredentialsInput): Promise<{ accountId: string }> {
  const client = await createDexcomClient(credentials);
  await client.getLatestGlucoseReading();
  const { accountId } = client;
  if (!accountId) {
    throw new Error('Dexcom Share did not return an account ID for this login.');
  }
  return { accountId };
}

/** Map a thrown DexcomError (or anything else) to a friendly, pairing-UI-safe message. */
export function describeDexcomError(error: unknown): string {
  const errorType = (error as { errorType?: string } | null)?.errorType;
  const errorEnum = (error as { errorEnum?: string } | null)?.errorEnum;
  if (errorType === 'AccountError') {
    if (errorEnum === 'Maximum authentication attempts exceeded') {
      return 'Too many failed sign-in attempts. Wait a while before trying again.';
    }
    return 'Could not sign in - check the username, password, and region.';
  }
  if (errorType === 'ArgumentError') {
    return 'Check that the username, password, and region are filled in correctly.';
  }
  if (errorType === 'ServerError' || errorType === 'SessionError') {
    return 'Dexcom Share is not responding right now. Try again in a moment.';
  }
  return error instanceof Error ? error.message : 'Could not sign in to Dexcom Share.';
}

const RECOGNIZED_DEXCOM_ERROR_TYPES = new Set(['AccountError', 'ArgumentError', 'ServerError', 'SessionError']);

/**
 * True when describeDexcomError() maps this to a specific, known-cause message rather than
 * falling back to the raw library text - i.e. whether the error's own stack trace (always the
 * same dexcom-share-client internal frames for these known types) still carries any signal worth
 * logging, versus an unrecognised error where the stack is the only clue to what actually broke.
 */
export function isRecognizedDexcomError(error: unknown): boolean {
  const errorType = (error as { errorType?: string } | null)?.errorType;
  return errorType !== undefined && RECOGNIZED_DEXCOM_ERROR_TYPES.has(errorType);
}
