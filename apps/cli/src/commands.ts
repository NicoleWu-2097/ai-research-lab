export const COMMANDS = [
  "/projects",
  "/new",
  "/open",
  "/delete",
  "/back",
  "/close",
  "/size",
  "/upload",
  "/report",
  "/cite",
  "/save",
  "/history",
  "/tools",
  "/approval",
  "/approve",
  "/reject",
  "/resume",
  "/help",
  "/quit",
];
export function commandSuffix(input: string): string {
  if (!/^\/[a-z]+$/i.test(input)) return "";
  if (COMMANDS.includes(input)) return "";
  return (
    COMMANDS.find((command) => command.startsWith(input))?.slice(
      input.length,
    ) ?? ""
  );
}
