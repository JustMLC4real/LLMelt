export function claudeCliLoggedInFromStatus(output: string): boolean {
  try {
    const status = JSON.parse(output.trim()) as { loggedIn?: unknown };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}
