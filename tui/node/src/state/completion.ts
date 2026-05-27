export type CompletionKind = "slash" | "path";
export type CompletionItem = { value: string; description?: string; kind?: string };

export function shouldComplete(value: string): CompletionKind | null {
  if (value.startsWith("/")) {
    return "slash";
  }
  const atIndex = value.lastIndexOf("@");
  if (atIndex >= 0 && !/\s/.test(value.slice(atIndex + 1))) {
    return "path";
  }
  return null;
}

export function moveSelection(selectedIndex: number, delta: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (selectedIndex + delta + total) % total;
}

export function completionWindow<T>(items: T[], selectedIndex: number, size: number): T[] {
  const start = Math.min(Math.max(selectedIndex - size + 1, 0), Math.max(items.length - size, 0));
  return items.slice(start, start + size);
}

export function acceptSelected(items: CompletionItem[], selectedIndex: number): string | null {
  return items[selectedIndex]?.value ?? null;
}
