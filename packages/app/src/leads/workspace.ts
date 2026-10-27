const WORKSPACE_KEY = "roofing-crm.workspace";

let fallback: string | undefined;

export function workspaceId(): string {
  try {
    const stored = localStorage.getItem(WORKSPACE_KEY);
    if (stored) return stored;
    const created = crypto.randomUUID();
    localStorage.setItem(WORKSPACE_KEY, created);
    return created;
  } catch {
    fallback ??= crypto.randomUUID();
    return fallback;
  }
}

export function resetWorkspace(): void {
  try {
    localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    fallback = undefined;
  }
}
