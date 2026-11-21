/** Render the extension's warnings in amber in browser DevTools. */
export function browserWarning(message: string, error: unknown): void {
  console.warn('%c[Citizen Hangar]%c ' + message, 'color: #b76500; font-weight: bold', '', error);
}
