export type BobKeyType = 'inference' | 'general';
export interface BobSetupInput {
  apiKey?: string; // omitted = keep the stored key
  keyType: BobKeyType;
  teamId?: string; // required when keyType === 'general'
  binaryPath?: string; // omitted = auto-detect
  acceptLicense: boolean; // must be true to save
}
export interface BobStatus {
  configured: boolean;
  keySaved: boolean;
  keyType?: BobKeyType;
  teamIdSet: boolean;
  binaryPath?: string;
  bobVersion?: string;
  nodeVersion?: string;
  licenseAccepted: boolean;
  lastCheckAt?: string;
  lastCheckOk?: boolean;
}
export interface BobCheckResult {
  step: 'binary' | 'node' | 'license' | 'auth';
  ok: boolean;
  message: string; // plain language
  value?: string; // e.g. version string
}
