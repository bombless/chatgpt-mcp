export type AgentRequest = {
  type: 'request';
  id: string;
  tool: string;
  args: Record<string, unknown>;
};

export type AgentResponse = {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type AgentHello = {
  type: 'hello';
  agentId: string;
  hostname: string;
  platform: string;
  version: string;
};

export type AgentMessage = AgentHello | AgentResponse;

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'list_directory'
  | 'move_file'
  | 'delete_file'
  | 'execute_powershell'
  | 'get_system_info'
  | 'run_npm'
  | 'run_python'
  | 'run_node'
  | 'read_file_range'
  | 'tail_file'
  | 'get_file_info'
  | 'create_directory'
  | 'copy_file'
  | 'process_list'
  | 'kill_process'
  | 'rg'
  | 'git'
  | 'apply_patch'
  | 'find_files';
