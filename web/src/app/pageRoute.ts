export function isGoblinFactoryPath(pathname: string): boolean {
  return /^\/goblin-factory\/?$/.test(pathname);
}

export function isPilotTrainingPath(pathname: string): boolean { return /^\/pilot-training\/?$/.test(pathname); }
