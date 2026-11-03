/** The TV app's page (`/tv`), which runs on its own; `/tv/vincular` is the site's, on the phone. */
export const isTvPage = (pathname: string) => /^\/tv\/?$/.test(pathname)
