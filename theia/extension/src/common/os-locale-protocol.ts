/**
 * The OS country code, which only Electron's main process can read
 * (app.getLocaleCountryCode()). The browser build has no such bridge.
 */
export const OS_LOCALE_PATH = '/services/hackbench/os-locale'

export const OsLocaleService = Symbol('OsLocaleService')
export interface OsLocaleService {
  /** ISO 3166-1 alpha-2 country code, or '' when the OS reports none. */
  countryCode(): Promise<string>
}
