export type SlashCommandCategory =
  | "local"
  | "runtime"
  | "session"
  | "model"
  | "view"
  | "safety";

export type SlashCommandRoute =
  | { kind: "local" }
  | { kind: "runtime"; method: "command.run" }
  | { kind: "reserved"; method: "command.run" };

export type SlashCommand = {
  name: string;
  aliases: string[];
  category: SlashCommandCategory;
  description: string;
  mutating: boolean;
  route: SlashCommandRoute;
};

export const SLASH_COMMAND_CATALOG: SlashCommand[] = [
  {
    name: "/help",
    aliases: ["/?"],
    category: "local",
    description: "Show command catalog and keyboard help.",
    mutating: false,
    route: { kind: "local" },
  },
  {
    name: "/?",
    aliases: ["/help"],
    category: "local",
    description: "Show command catalog and keyboard help.",
    mutating: false,
    route: { kind: "local" },
  },
  {
    name: "/theme",
    aliases: [],
    category: "local",
    description: "List or change the local TUI theme.",
    mutating: true,
    route: { kind: "local" },
  },
  {
    name: "/clear",
    aliases: [],
    category: "local",
    description: "Clear the visible transcript in this TUI.",
    mutating: true,
    route: { kind: "local" },
  },
  {
    name: "/history",
    aliases: [],
    category: "local",
    description: "Show a bounded local transcript history preview.",
    mutating: false,
    route: { kind: "local" },
  },
  {
    name: "/search",
    aliases: [],
    category: "local",
    description: "Search visible transcript locally.",
    mutating: false,
    route: { kind: "local" },
  },
  {
    name: "/export",
    aliases: [],
    category: "local",
    description: "Preview a bounded transcript export without writing files.",
    mutating: false,
    route: { kind: "local" },
  },
  {
    name: "/copy",
    aliases: [],
    category: "local",
    description: "Show the latest assistant text for manual copy.",
    mutating: false,
    route: { kind: "local" },
  },
  {
    name: "/view",
    aliases: [],
    category: "view",
    description: "Change transcript view mode through the runtime.",
    mutating: true,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/status",
    aliases: [],
    category: "runtime",
    description: "Inspect current runtime status.",
    mutating: false,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/context",
    aliases: [],
    category: "runtime",
    description: "Inspect assembled context sources.",
    mutating: false,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/usage",
    aliases: [],
    category: "runtime",
    description: "Inspect token and usage counters.",
    mutating: false,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/changes",
    aliases: [],
    category: "runtime",
    description: "Inspect runtime-recorded file changes.",
    mutating: false,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/diff",
    aliases: [],
    category: "runtime",
    description: "Inspect runtime diff output when supported.",
    mutating: false,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/undo",
    aliases: [],
    category: "runtime",
    description: "Ask the runtime to undo the last recoverable file change.",
    mutating: true,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/checkpoint",
    aliases: [],
    category: "runtime",
    description: "Create or inspect a runtime checkpoint when supported.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/sessions",
    aliases: [],
    category: "session",
    description: "List resumable sessions through the runtime.",
    mutating: false,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/resume",
    aliases: [],
    category: "session",
    description: "Resume a session through the runtime.",
    mutating: true,
    route: { kind: "runtime", method: "command.run" },
  },
  {
    name: "/model",
    aliases: [],
    category: "model",
    description: "Inspect or change the active model through the runtime.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/compact",
    aliases: [],
    category: "runtime",
    description: "Request runtime context compaction.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/retry",
    aliases: [],
    category: "runtime",
    description: "Retry the last recoverable turn.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/queue",
    aliases: [],
    category: "runtime",
    description: "Inspect queued or pending runtime work.",
    mutating: false,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/title",
    aliases: [],
    category: "session",
    description: "Inspect or set the current session title.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/statusbar",
    aliases: [],
    category: "view",
    description: "Inspect or adjust status line details.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/redraw",
    aliases: [],
    category: "view",
    description: "Ask the runtime/UI to refresh terminal rendering when supported.",
    mutating: false,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/terminal-setup",
    aliases: [],
    category: "view",
    description: "Inspect terminal setup diagnostics when supported.",
    mutating: false,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/details",
    aliases: [],
    category: "view",
    description: "Open details for the current turn or selected item.",
    mutating: false,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/trust",
    aliases: [],
    category: "safety",
    description: "Inspect or update workspace trust through the runtime.",
    mutating: true,
    route: { kind: "reserved", method: "command.run" },
  },
  {
    name: "/quit",
    aliases: [],
    category: "local",
    description: "Ask the runtime to shut down the TUI.",
    mutating: true,
    route: { kind: "runtime", method: "command.run" },
  },
];

export function commandName(raw: string): string {
  return raw.trim().split(/\s+/, 1)[0] ?? "";
}

export function slashCommandByName(raw: string): SlashCommand | null {
  const name = commandName(raw);
  return (
    SLASH_COMMAND_CATALOG.find(
      (command) => command.name === name || command.aliases.includes(name),
    ) ?? null
  );
}

export function isLocalSlashCommand(raw: string): boolean {
  return slashCommandByName(raw)?.route.kind === "local";
}

export function slashCommandCompletions(prefix: string): SlashCommand[] {
  const normalized = prefix.trim() || "/";
  return SLASH_COMMAND_CATALOG.filter(
    (command) =>
      command.name.startsWith(normalized) ||
      command.aliases.some((alias) => alias.startsWith(normalized)),
  );
}

export function slashCommandSuggestions(raw: string, limit = 3): SlashCommand[] {
  const name = commandName(raw);
  if (!name.startsWith("/") || name === "/") {
    return [];
  }
  return [...SLASH_COMMAND_CATALOG]
    .map((command) => ({ command, distance: levenshtein(name, command.name) }))
    .sort((left, right) => left.distance - right.distance || left.command.name.localeCompare(right.command.name))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(name.length / 2)))
    .slice(0, limit)
    .map((entry) => entry.command);
}

export function catalogHelpLines(): string[] {
  return [
    "Input",
    "  Enter send message or clarification reply",
    "  / starts commands",
    "  Ctrl-C requests interrupt",
    "",
    "Completion popup",
    "  Up/Down move",
    "  Tab accept",
    "  Esc cancel",
    "",
    "Approval and clarification",
    "  Approval: press 1-9 to choose",
    "  Clarification: type a reply; single-select accepts number or label",
    "",
    "Commands",
    ...SLASH_COMMAND_CATALOG.map((command) => {
      const flag = command.mutating ? "mutating" : "read";
      const route = command.route.kind === "local" ? "local" : "runtime";
      return `  ${command.name.padEnd(12)} ${command.category.padEnd(7)} ${flag.padEnd(8)} ${route.padEnd(7)} ${command.description}`;
    }),
  ];
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      const insertion = (current[rightIndex] ?? 0) + 1;
      const deletion = (previous[rightIndex + 1] ?? 0) + 1;
      const substitution = (previous[rightIndex] ?? 0) + cost;
      current[rightIndex + 1] = Math.min(
        insertion,
        deletion,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}
