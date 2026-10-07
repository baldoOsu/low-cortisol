// Hand-written types for live-guards.mjs.

export declare function isDefaultUserDataDir(dir: string, env?: { localAppData?: string; home?: string }): boolean;

export declare function findSessionRestoreData(userDataDir: string): string[];

export declare function isHomeUrl(url: string): boolean;

export declare const IN_PAGE_IS_HOME: string;

export declare function onlyOnHome(expression: string, otherwise: string): string;

export declare function describeUrl(url: string): string;
