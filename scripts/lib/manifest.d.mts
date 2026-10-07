// Hand-written types for manifest.mjs.

export declare const HOST_NAME: 'com.lowcortisol.companion';

export declare function extensionIdFromPublicKey(publicKeyB64: string): string;

export interface IconSet {
  16: string;
  48: string;
  128: string;
}

export interface ExtensionManifest {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  key: string;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string };
  content_scripts: Array<{ matches: string[]; js: string[]; run_at: 'document_idle' }>;
  action: { default_popup: string; default_title: string; default_icon: IconSet };
  icons: IconSet;
  minimum_chrome_version: string;
}

export declare function makeManifest(flavor: 'dev' | 'prod', publicKeyB64: string, version: string): ExtensionManifest;
