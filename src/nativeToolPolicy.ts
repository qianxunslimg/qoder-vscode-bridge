export interface NativeToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: object;
}

const MAX_TOOL_DESCRIPTION_CHARS = 240;

// Copilot orders its built-in coding tools before optional provider tools, but
// extensions can add dozens of extra entries. Keep the tools that make up a
// normal coding-agent loop even when they appear late in the host list.
const CORE_TOOL_NAMES = new Set([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'Write',
  'create_directory',
  'create_file',
  'file_search',
  'grep_search',
  'get_errors',
  'insert_edit_into_file',
  'list_dir',
  'manage_todo_list',
  'qoder_read_file',
  'read_file',
  'replace_string_in_file',
  'run_in_terminal',
  'runSubagent',
  'view_image',
  'vscode_askQuestions',
  'vscode_listCodeUsages',
  'vscode_renameSymbol',
]);

function compactDescription(name: string, description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  const value = normalized || `Invoke the VS Code host tool ${name}.`;
  if (value.length <= MAX_TOOL_DESCRIPTION_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/** Select a bounded, deterministic tool set while retaining core coding tools. */
export function selectNativeTools(
  tools: readonly NativeToolDescriptor[] | undefined,
  limit: number,
): NativeToolDescriptor[] {
  const seen = new Set<string>();
  const core: NativeToolDescriptor[] = [];
  const optional: NativeToolDescriptor[] = [];

  for (const candidate of tools ?? []) {
    if (!candidate.name || seen.has(candidate.name)) {
      continue;
    }
    seen.add(candidate.name);
    const descriptor = {
      name: candidate.name,
      description: compactDescription(candidate.name, candidate.description),
      inputSchema: candidate.inputSchema,
    };
    (CORE_TOOL_NAMES.has(candidate.name) ? core : optional).push(descriptor);
  }

  const boundedLimit = Math.max(1, Math.floor(limit));
  return [...core, ...optional].slice(0, boundedLimit);
}
