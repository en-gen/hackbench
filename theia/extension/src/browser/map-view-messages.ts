/** The map tab's missing-ROM wording (#786): pure, so it runs without a Theia shell. */
export const romMissingMessage = (title: string): string =>
  `The base ROM ${title} is not on this machine. Choose File > Project Properties... and locate it again.`
